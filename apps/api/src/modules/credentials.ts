import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { request as undiciRequest } from "undici";
import { z } from "zod";
import { PROVIDERS, NotFoundError, ValidationError, getCredentialCooldownTtl } from "@tokenledger/shared";
import { encryptSecret, type MasterKeyRing } from "@tokenledger/auth";
import { getAdapter, supportedProviders } from "@tokenledger/providers";
import { Prisma, type PrismaClient } from "@tokenledger/db";
import type { Redis } from "@tokenledger/queue";
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
  redis: Redis;
}

export function registerCredentialsModule(app: FastifyInstance, opts: CredModuleOptions): void {
  const { prisma, authenticate, ring, redis } = opts;
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
        "TOKENLEDGER_MASTER_KEY is not configured — cannot store encrypted credentials",
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
    const { decryptSecret } = await import("@tokenledger/auth");
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
        "TOKENLEDGER_MASTER_KEY is not configured — cannot store encrypted credentials",
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

  // Usage/limits report (FR-GW-EE): per-credential request volume and live
  // cooldown status so admins running N keys behind a pool can see who's
  // carrying load and who just got rate-limited — and when it resets. Works
  // without a pool too (single-credential visibility is community-tier).
  app.get("/workspaces/:ws/credentials/usage", { preHandler: admin }, async (request) => {
    const workspaceId = request.wsCtx!.workspaceId;
    const credentials = await prisma.providerCredential.findMany({
      where: { workspaceId },
      select: { id: true, provider: true, name: true, secretLast4: true, status: true },
      orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
    });
    if (credentials.length === 0) return { data: [] };

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since1h = new Date(Date.now() - 60 * 60 * 1000);
    const rows = await prisma.$queryRaw<
      { credentialId: string; requests_1h: bigint; requests_24h: bigint; errors_24h: bigint;
        input_tokens_24h: bigint; output_tokens_24h: bigint; cost_24h: Prisma.Decimal }[]
    >`
      SELECT "credentialId",
             COUNT(*) FILTER (WHERE "occurredAt" >= ${since1h})::bigint AS requests_1h,
             COUNT(*)::bigint AS requests_24h,
             COUNT(*) FILTER (WHERE status != 'OK')::bigint AS errors_24h,
             COALESCE(SUM("inputTokens"), 0)::bigint AS input_tokens_24h,
             COALESCE(SUM("outputTokens"), 0)::bigint AS output_tokens_24h,
             COALESCE(SUM("costUsd"), 0)::numeric AS cost_24h
        FROM "usage_event"
       WHERE "workspaceId" = ${workspaceId}::uuid
         AND "credentialId" IS NOT NULL
         AND "occurredAt" >= ${since24h}
       GROUP BY "credentialId"
    `;
    const byId = new Map(rows.map((r) => [r.credentialId, r]));

    const data = await Promise.all(
      credentials.map(async (c) => {
        const agg = byId.get(c.id);
        const cooldownTtlS = await getCredentialCooldownTtl(redis, c.id);
        return {
          credentialId: c.id,
          provider: c.provider,
          name: c.name,
          secretLast4: c.secretLast4,
          status: c.status,
          requests1h: Number(agg?.requests_1h ?? 0),
          requests24h: Number(agg?.requests_24h ?? 0),
          errors24h: Number(agg?.errors_24h ?? 0),
          inputTokens24h: Number(agg?.input_tokens_24h ?? 0),
          outputTokens24h: Number(agg?.output_tokens_24h ?? 0),
          costUsd24h: (agg?.cost_24h ?? new Prisma.Decimal(0)).toString(),
          coolingDown: cooldownTtlS !== null,
          resetsAt: cooldownTtlS !== null ? new Date(Date.now() + cooldownTtlS * 1000).toISOString() : null,
        };
      }),
    );
    return { data };
  });
}
