import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { request as undiciRequest } from "undici";
import { z } from "zod";
import { PROVIDERS, NotFoundError, ValidationError } from "@tokentrail/shared";
import { encryptSecret, type MasterKeyRing } from "@tokentrail/auth";
import { getAdapter, supportedProviders } from "@tokentrail/providers";
import type { PrismaClient } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const createSchema = z.object({
  provider: z.enum(PROVIDERS),
  name: z.string().min(1).max(100),
  secret: z.string().min(1).max(500).optional(),
  baseUrl: z.string().url().optional(),
  modelAllowlist: z.array(z.string()).max(100).default([]),
  isDefault: z.boolean().default(false),
});

/** Cheapest liveness probe per provider (models list / tags). */
const PROBE_PATHS: Partial<Record<string, string>> = {
  ANTHROPIC: "/v1/models",
  OPENAI: "/v1/models",
  OLLAMA: "/api/tags",
};

interface CredModuleOptions {
  prisma: PrismaClient;
  authenticate: preHandlerHookHandler;
  ring: MasterKeyRing | null;
}

export function registerCredentialsModule(app: FastifyInstance, opts: CredModuleOptions): void {
  const { prisma, authenticate, ring } = opts;
  const admin = [authenticate, makeWorkspaceGuard(prisma, "ADMIN")];

  app.get("/workspaces/:ws/credentials", { preHandler: admin }, async (request) => {
    const credentials = await prisma.providerCredential.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId },
      orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, provider: true, name: true, secretLast4: true, baseUrl: true,
        modelAllowlist: true, isDefault: true, status: true, createdAt: true,
      },
    });
    return { data: credentials };
  });

  app.post("/workspaces/:ws/credentials", { preHandler: admin }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const workspaceId = request.wsCtx!.workspaceId;

    if (body.provider === "OLLAMA" && !body.baseUrl) {
      throw new ValidationError("Ollama credentials require a baseUrl");
    }
    if (body.provider !== "OLLAMA" && !body.secret) {
      throw new ValidationError(`${body.provider} credentials require a secret`);
    }
    if (body.secret && !ring) {
      throw new ValidationError(
        "TOKENTRAIL_MASTER_KEY is not configured — cannot store encrypted credentials",
      );
    }

    const credential = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.providerCredential.updateMany({
          where: { workspaceId, provider: body.provider, isDefault: true },
          data: { isDefault: false },
        });
      }
      const isFirst =
        (await tx.providerCredential.count({ where: { workspaceId, provider: body.provider } })) === 0;
      return tx.providerCredential.create({
        data: {
          workspaceId,
          provider: body.provider,
          name: body.name,
          encryptedSecret: body.secret ? new Uint8Array(encryptSecret(body.secret, ring!)) : null,
          secretLast4: body.secret ? body.secret.slice(-4) : null,
          baseUrl: body.baseUrl ?? null,
          modelAllowlist: body.modelAllowlist,
          isDefault: body.isDefault || isFirst, // first credential becomes the default
        },
        select: {
          id: true, provider: true, name: true, secretLast4: true, baseUrl: true,
          isDefault: true, status: true, createdAt: true,
        },
      });
    });
    return reply.status(201).send(credential);
  });

  app.post("/workspaces/:ws/credentials/:id/test", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const stored = await prisma.providerCredential.findFirst({
      where: { id, workspaceId: request.wsCtx!.workspaceId },
    });
    if (!stored) throw new NotFoundError("Credential", id);

    const probePath = PROBE_PATHS[stored.provider];
    if (!probePath || !supportedProviders().includes(stored.provider)) {
      return { ok: null, checked: false, message: "No live probe available for this provider yet" };
    }

    const adapter = getAdapter(stored.provider);
    const { decryptSecret } = await import("@tokentrail/auth");
    const secret =
      stored.encryptedSecret && ring
        ? decryptSecret(Buffer.from(stored.encryptedSecret), ring)
        : undefined;
    const upstream = adapter.buildUpstream(probePath, {
      ...(secret !== undefined ? { secret } : {}),
      ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    });

    try {
      const res = await undiciRequest(upstream.url, {
        method: "GET",
        headers: upstream.headers,
        headersTimeout: 5000,
      });
      await res.body.dump();
      const ok = res.statusCode < 400;
      return { ok, checked: true, httpStatus: res.statusCode };
    } catch {
      return { ok: false, checked: true, message: "Provider unreachable" };
    }
  });

  const patchSchema = z.object({
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    isDefault: z.literal(true).optional(),
    name: z.string().min(1).max(100).optional(),
    // Present + non-empty ⇒ rotate the secret; omit to leave the stored secret untouched.
    secret: z.string().min(1).max(500).optional(),
    // Explicit null clears an existing baseUrl override; omit to leave it untouched.
    baseUrl: z.string().url().nullable().optional(),
  });

  app.patch("/workspaces/:ws/credentials/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const body = patchSchema.parse(request.body);
    const stored = await prisma.providerCredential.findFirst({ where: { id, workspaceId } });
    if (!stored) throw new NotFoundError("Credential", id);

    if (body.secret && !ring) {
      throw new ValidationError(
        "TOKENTRAIL_MASTER_KEY is not configured — cannot store encrypted credentials",
      );
    }
    if (stored.provider === "OLLAMA" && body.baseUrl === null) {
      throw new ValidationError("Ollama credentials require a baseUrl");
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.providerCredential.updateMany({
          where: { workspaceId, provider: stored.provider, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.providerCredential.update({
        where: { id },
        data: {
          ...(body.status ? { status: body.status } : {}),
          ...(body.isDefault ? { isDefault: true } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
          ...(body.secret
            ? {
                encryptedSecret: new Uint8Array(encryptSecret(body.secret, ring!)),
                secretLast4: body.secret.slice(-4),
              }
            : {}),
        },
        select: {
          id: true, provider: true, name: true, secretLast4: true, baseUrl: true,
          isDefault: true, status: true, createdAt: true,
        },
      });
    });
    return updated;
  });

  app.delete("/workspaces/:ws/credentials/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const stored = await prisma.providerCredential.findFirst({
      where: { id, workspaceId: request.wsCtx!.workspaceId },
    });
    if (!stored) throw new NotFoundError("Credential", id);
    try {
      await prisma.providerCredential.delete({ where: { id } });
    } catch (err) {
      // Referenced by a provider pool (EE) — can't hard-delete; disable instead.
      if ((err as { code?: string }).code === "P2003") {
        throw new ValidationError("This credential is in use by a provider pool — disable it instead of deleting");
      }
      throw err;
    }
    return { ok: true };
  });
}
