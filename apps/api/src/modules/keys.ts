import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  PROVIDERS,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  hasMinimumRole,
  type Provider,
} from "@tokentrail/shared";
import { mintVirtualKey } from "@tokentrail/auth";
import { CHANNELS, type Redis } from "@tokentrail/queue";
import type { PrismaClient } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const issueSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  userId: z.string().uuid().optional(), // ADMIN may issue for someone else
  providerAllowlist: z.array(z.enum(PROVIDERS)).default([]),
  // Pins the key to specific ProviderCredential rows — needed when a
  // workspace has several credentials for the same provider (e.g. multiple
  // Anthropic accounts shared across developers) and this key must always
  // use one particular one rather than whichever is flagged isDefault.
  credentialAllowlist: z.array(z.string().uuid()).max(50).default([]),
  modelAllowlist: z.array(z.string().max(100)).max(100).default([]),
  rpmLimit: z.number().int().min(1).optional(),
  expiresAt: z.coerce.date().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  credentialAllowlist: z.array(z.string().uuid()).max(50).optional(),
  modelAllowlist: z.array(z.string().max(100)).max(100).optional(),
  // Explicit null clears an existing limit/expiry; omit to leave untouched.
  rpmLimit: z.number().int().min(1).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

const keySelect = {
  id: true, name: true, keyLast4: true, projectId: true, userId: true,
  providerAllowlist: true, credentialAllowlist: true, modelAllowlist: true, rpmLimit: true,
  expiresAt: true, status: true, lastUsedAt: true, createdAt: true,
} as const;

/**
 * Pinning to specific credentials also implies their providers are allowed —
 * merge them into providerAllowlist so the coarse per-provider check (which
 * runs before credential resolution in the gateway) never blocks a provider
 * the caller explicitly selected credentials for.
 */
async function resolveProviderAllowlist(
  prisma: PrismaClient,
  workspaceId: string,
  credentialAllowlist: string[],
  baseProviderAllowlist: Provider[],
): Promise<Provider[]> {
  if (credentialAllowlist.length === 0) return baseProviderAllowlist;
  const creds = await prisma.providerCredential.findMany({
    where: { id: { in: credentialAllowlist }, workspaceId },
    select: { id: true, provider: true },
  });
  if (creds.length !== credentialAllowlist.length) {
    throw new ValidationError("One or more selected credentials were not found in this workspace");
  }
  return Array.from(new Set([...baseProviderAllowlist, ...creds.map((c) => c.provider)]));
}

interface KeysModuleOptions {
  prisma: PrismaClient;
  redis: Redis;
  authenticate: preHandlerHookHandler;
}

export function registerKeysModule(app: FastifyInstance, opts: KeysModuleOptions): void {
  const { prisma, redis, authenticate } = opts;
  const member = [authenticate, makeWorkspaceGuard(prisma, "MEMBER")];

  app.get("/workspaces/:ws/keys", { preHandler: member }, async (request) => {
    const isAdmin = hasMinimumRole(request.wsCtx!.role, "ADMIN");
    const keys = await prisma.virtualKey.findMany({
      where: {
        workspaceId: request.wsCtx!.workspaceId,
        ...(isAdmin ? {} : { userId: request.user!.id }), // members see their own keys
      },
      orderBy: { createdAt: "desc" },
      select: keySelect,
    });
    return { data: keys };
  });

  app.post("/workspaces/:ws/keys", { preHandler: member }, async (request, reply) => {
    const body = issueSchema.parse(request.body);
    const workspaceId = request.wsCtx!.workspaceId;
    const isAdmin = hasMinimumRole(request.wsCtx!.role, "ADMIN");

    if (body.userId && body.userId !== request.user!.id && !isAdmin) {
      throw new ForbiddenError("Only admins may issue keys for other users");
    }
    const userId = body.userId ?? request.user!.id;

    const project = await prisma.project.findFirst({
      where: { id: body.projectId, workspaceId, status: "ACTIVE" },
    });
    if (!project) throw new NotFoundError("Project", body.projectId);

    const providerAllowlist = await resolveProviderAllowlist(
      prisma, workspaceId, body.credentialAllowlist, body.providerAllowlist,
    );

    const minted = mintVirtualKey();
    const key = await prisma.virtualKey.create({
      data: {
        workspaceId,
        projectId: body.projectId,
        userId,
        name: body.name,
        keyHash: minted.hash,
        keyLast4: minted.last4,
        providerAllowlist,
        credentialAllowlist: body.credentialAllowlist,
        modelAllowlist: body.modelAllowlist,
        rpmLimit: body.rpmLimit ?? null,
        expiresAt: body.expiresAt ?? null,
      },
      select: keySelect,
    });

    // Full key is returned exactly once; only the hash is stored.
    return reply.status(201).send({ ...key, key: minted.token });
  });

  app.patch("/workspaces/:ws/keys/:keyId", { preHandler: member }, async (request) => {
    const { keyId } = request.params as { keyId: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const isAdmin = hasMinimumRole(request.wsCtx!.role, "ADMIN");
    const body = patchSchema.parse(request.body);

    const existing = await prisma.virtualKey.findFirst({ where: { id: keyId, workspaceId } });
    if (!existing) throw new NotFoundError("Virtual key", keyId);
    if (existing.userId !== request.user!.id && !isAdmin) {
      throw new ForbiddenError("Only the key owner or an admin may edit this key");
    }

    const providerAllowlist =
      body.credentialAllowlist !== undefined
        ? await resolveProviderAllowlist(prisma, workspaceId, body.credentialAllowlist, existing.providerAllowlist)
        : undefined;

    const key = await prisma.virtualKey.update({
      where: { id: keyId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.credentialAllowlist !== undefined ? { credentialAllowlist: body.credentialAllowlist } : {}),
        ...(providerAllowlist !== undefined ? { providerAllowlist } : {}),
        ...(body.modelAllowlist !== undefined ? { modelAllowlist: body.modelAllowlist } : {}),
        ...(body.rpmLimit !== undefined ? { rpmLimit: body.rpmLimit } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      },
      select: keySelect,
    });

    // Propagate restriction/limit changes to gateways promptly (≤5 s effect),
    // same mechanism as revoke — otherwise the 60 s Redis cache TTL applies.
    try {
      await redis.del(`vk:${existing.keyHash}`);
      await redis.publish(CHANNELS.invalidateVk(existing.keyHash), "updated");
    } catch (err) {
      request.log.warn({ err }, "VK cache invalidation failed — gateway TTL (60s) will expire it");
    }
    return key;
  });

  app.post("/workspaces/:ws/keys/:keyId/revoke", { preHandler: member }, async (request) => {
    const { keyId } = request.params as { keyId: string };
    const isAdmin = hasMinimumRole(request.wsCtx!.role, "ADMIN");

    const key = await prisma.virtualKey.findFirst({
      where: { id: keyId, workspaceId: request.wsCtx!.workspaceId },
    });
    if (!key) throw new NotFoundError("Virtual key", keyId);
    if (key.userId !== request.user!.id && !isAdmin) {
      throw new ForbiddenError("Only the key owner or an admin may revoke this key");
    }

    await prisma.virtualKey.update({ where: { id: key.id }, data: { status: "REVOKED" } });

    // Propagate to gateways: drop the Redis cache entry and broadcast (≤5 s effect).
    try {
      await redis.del(`vk:${key.keyHash}`);
      await redis.publish(CHANNELS.invalidateVk(key.keyHash), "revoked");
    } catch (err) {
      request.log.warn({ err }, "VK cache invalidation failed — gateway TTL (60s) will expire it");
    }
    return { ok: true, status: "REVOKED" };
  });
}
