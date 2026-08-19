import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  PROVIDERS, LicenseRequiredError, NotFoundError, ValidationError, getCredentialCooldownTtl,
} from "@tokenledger/shared";
import { Prisma, type PrismaClient } from "@tokenledger/db";
import { entitled } from "@tokenledger/ee-licensing";
import type { Redis } from "@tokenledger/queue";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const STRATEGIES = ["PRIORITY", "ROUND_ROBIN", "WEIGHTED"] as const;
const HEALTHS = ["HEALTHY", "DEGRADED", "DISABLED"] as const;

const poolSchema = z.object({
  provider: z.enum(PROVIDERS),
  name: z.string().min(1).max(100),
  strategy: z.enum(STRATEGIES).default("ROUND_ROBIN"),
  cooldownS: z.number().int().min(5).max(3600).default(60),
});

const memberSchema = z.object({
  credentialId: z.string().uuid(),
  priority: z.number().int().min(0).max(1000).default(0),
  weight: z.number().int().min(1).max(1000).default(1),
  rpmLimit: z.number().int().min(1).optional(),
  tpmLimit: z.number().int().min(1).optional(),
});

interface PoolsModuleOptions {
  prisma: PrismaClient;
  redis: Redis;
  authenticate: preHandlerHookHandler;
}

/**
 * Provider pools (FR-GW-EE): "always available" LLM usage across N API keys
 * for the same provider — round-robin/priority/weighted selection with
 * automatic failover when a key gets rate-limited (429) or errors (5xx).
 * The pool schema itself ships in community (0_init) so a self-hoster who
 * later licenses can just start using it; creating/editing pools is the
 * gated part — that's the enterprise value, not the data model.
 */
export function registerPoolsModule(app: FastifyInstance, opts: PoolsModuleOptions): void {
  const { prisma, redis, authenticate } = opts;
  const admin = [authenticate, makeWorkspaceGuard(prisma, "ADMIN")];
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];

  function requireEntitlement(): void {
    if (!entitled("provider_pools")) throw new LicenseRequiredError("provider_pools");
  }

  app.get("/workspaces/:ws/pools", { preHandler: member }, async (request) => {
    const pools = await prisma.providerPool.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId },
      orderBy: { createdAt: "asc" },
      include: { members: { include: { credential: { select: { id: true, name: true, secretLast4: true, status: true } } } } },
    });
    return { data: pools.map(serializePool) };
  });

  app.post("/workspaces/:ws/pools", { preHandler: admin }, async (request, reply) => {
    requireEntitlement();
    const body = poolSchema.parse(request.body);
    const workspaceId = request.wsCtx!.workspaceId;
    try {
      const pool = await prisma.providerPool.create({
        data: { workspaceId, ...body },
        include: { members: true },
      });
      return reply.status(201).send(serializePool(pool));
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        throw new ValidationError(`A pool named "${body.name}" already exists for ${body.provider}`);
      }
      throw err;
    }
  });

  app.patch("/workspaces/:ws/pools/:id", { preHandler: admin }, async (request) => {
    requireEntitlement();
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const body = poolSchema.pick({ name: true, strategy: true, cooldownS: true }).partial().parse(request.body);

    const existing = await prisma.providerPool.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundError("Provider pool", id);

    const data: Prisma.ProviderPoolUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.strategy !== undefined) data.strategy = body.strategy;
    if (body.cooldownS !== undefined) data.cooldownS = body.cooldownS;

    const pool = await prisma.providerPool.update({
      where: { id },
      data,
      include: { members: { include: { credential: { select: { id: true, name: true, secretLast4: true, status: true } } } } },
    });
    return serializePool(pool);
  });

  app.delete("/workspaces/:ws/pools/:id", { preHandler: admin }, async (request) => {
    requireEntitlement();
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const deleted = await prisma.providerPool.deleteMany({ where: { id, workspaceId } });
    if (deleted.count === 0) throw new NotFoundError("Provider pool", id);
    return { ok: true };
  });

  app.post("/workspaces/:ws/pools/:id/members", { preHandler: admin }, async (request, reply) => {
    requireEntitlement();
    const { id: poolId } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const body = memberSchema.parse(request.body);

    const pool = await prisma.providerPool.findFirst({ where: { id: poolId, workspaceId } });
    if (!pool) throw new NotFoundError("Provider pool", poolId);

    const credential = await prisma.providerCredential.findFirst({
      where: { id: body.credentialId, workspaceId, provider: pool.provider },
    });
    if (!credential) {
      throw new ValidationError("Credential not found, or its provider doesn't match this pool's provider");
    }

    try {
      const created = await prisma.poolMember.create({
        data: {
          poolId,
          credentialId: body.credentialId,
          priority: body.priority,
          weight: body.weight,
          ...(body.rpmLimit !== undefined ? { rpmLimit: body.rpmLimit } : {}),
          ...(body.tpmLimit !== undefined ? { tpmLimit: body.tpmLimit } : {}),
        },
        include: { credential: { select: { id: true, name: true, secretLast4: true, status: true } } },
      });
      return reply.status(201).send(serializeMember(created));
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        throw new ValidationError("This credential is already a member of this pool");
      }
      throw err;
    }
  });

  const memberUpdateSchema = z.object({
    priority: z.number().int().min(0).max(1000).optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    rpmLimit: z.number().int().min(1).nullable().optional(),
    tpmLimit: z.number().int().min(1).nullable().optional(),
    health: z.enum(HEALTHS).optional(),
  });

  app.patch("/workspaces/:ws/pools/:id/members/:memberId", { preHandler: admin }, async (request) => {
    requireEntitlement();
    const { id: poolId, memberId } = request.params as { id: string; memberId: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const body = memberUpdateSchema.parse(request.body);

    const existing = await prisma.poolMember.findFirst({
      where: { id: memberId, poolId, pool: { workspaceId } },
    });
    if (!existing) throw new NotFoundError("Pool member", memberId);

    const data: Prisma.PoolMemberUpdateInput = {};
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.weight !== undefined) data.weight = body.weight;
    if (body.rpmLimit !== undefined) data.rpmLimit = body.rpmLimit;
    if (body.tpmLimit !== undefined) data.tpmLimit = body.tpmLimit;
    if (body.health !== undefined) {
      data.health = body.health;
      data.healthChangedAt = new Date();
    }

    const updated = await prisma.poolMember.update({
      where: { id: memberId },
      data,
      include: { credential: { select: { id: true, name: true, secretLast4: true, status: true } } },
    });
    return serializeMember(updated);
  });

  app.delete("/workspaces/:ws/pools/:id/members/:memberId", { preHandler: admin }, async (request) => {
    requireEntitlement();
    const { id: poolId, memberId } = request.params as { id: string; memberId: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const deleted = await prisma.poolMember.deleteMany({
      where: { id: memberId, poolId, pool: { workspaceId } },
    });
    if (deleted.count === 0) throw new NotFoundError("Pool member", memberId);
    return { ok: true };
  });

  // Live status: DB-declared health + Redis cooldown (auto-failover state) +
  // when each member will be trusted again. This is what the "usage limit
  // reached — resets at" report page reads.
  app.get("/workspaces/:ws/pools/:id/status", { preHandler: member }, async (request) => {
    const { id: poolId } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const pool = await prisma.providerPool.findFirst({
      where: { id: poolId, workspaceId },
      include: { members: { include: { credential: { select: { id: true, name: true, secretLast4: true, status: true } } } } },
    });
    if (!pool) throw new NotFoundError("Provider pool", poolId);

    const statuses = await Promise.all(
      pool.members.map(async (m) => {
        const cooldownTtlS = await getCredentialCooldownTtl(redis, m.credentialId);
        return {
          memberId: m.id,
          credentialId: m.credentialId,
          credentialName: m.credential.name,
          secretLast4: m.credential.secretLast4,
          priority: m.priority,
          weight: m.weight,
          rpmLimit: m.rpmLimit,
          tpmLimit: m.tpmLimit,
          health: m.health,
          coolingDown: cooldownTtlS !== null,
          resetsAt: cooldownTtlS !== null ? new Date(Date.now() + cooldownTtlS * 1000).toISOString() : null,
        };
      }),
    );
    return {
      poolId: pool.id,
      strategy: pool.strategy,
      cooldownS: pool.cooldownS,
      members: statuses,
    };
  });
}

function serializePool(pool: {
  id: string; provider: string; name: string; strategy: string; cooldownS: number; createdAt: Date;
  members: unknown[];
}) {
  return {
    id: pool.id,
    provider: pool.provider,
    name: pool.name,
    strategy: pool.strategy,
    cooldownS: pool.cooldownS,
    createdAt: pool.createdAt,
    members: pool.members.map((m) => serializeMember(m as Parameters<typeof serializeMember>[0])),
  };
}

function serializeMember(member: {
  id: string; credentialId: string; priority: number; weight: number;
  rpmLimit: number | null; tpmLimit: number | null; health: string; healthChangedAt: Date | null;
  credential: { id: string; name: string; secretLast4: string | null; status: string };
}) {
  return {
    id: member.id,
    credentialId: member.credentialId,
    credentialName: member.credential.name,
    secretLast4: member.credential.secretLast4,
    credentialStatus: member.credential.status,
    priority: member.priority,
    weight: member.weight,
    rpmLimit: member.rpmLimit,
    tpmLimit: member.tpmLimit,
    health: member.health,
    healthChangedAt: member.healthChangedAt,
  };
}
