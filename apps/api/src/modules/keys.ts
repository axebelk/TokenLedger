import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  PROVIDERS,
  ForbiddenError,
  NotFoundError,
  hasMinimumRole,
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
  modelAllowlist: z.array(z.string().max(100)).max(100).default([]),
  rpmLimit: z.number().int().min(1).optional(),
  expiresAt: z.coerce.date().optional(),
});

const keySelect = {
  id: true, name: true, keyLast4: true, projectId: true, userId: true,
  providerAllowlist: true, modelAllowlist: true, rpmLimit: true,
  expiresAt: true, status: true, lastUsedAt: true, createdAt: true,
} as const;

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

    const minted = mintVirtualKey();
    const key = await prisma.virtualKey.create({
      data: {
        workspaceId,
        projectId: body.projectId,
        userId,
        name: body.name,
        keyHash: minted.hash,
        keyLast4: minted.last4,
        providerAllowlist: body.providerAllowlist,
        modelAllowlist: body.modelAllowlist,
        rpmLimit: body.rpmLimit ?? null,
        expiresAt: body.expiresAt ?? null,
      },
      select: keySelect,
    });

    // Full key is returned exactly once; only the hash is stored.
    return reply.status(201).send({ ...key, key: minted.token });
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
