import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { hasMinimumRole, NotFoundError, type ExportFilters, type ExportParams } from "@tokentrail/shared";
import { type Queue } from "@tokentrail/queue";
import { Prisma, type PrismaClient } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const createSchema = z.object({
  kind: z.literal("usage_events"),
  filters: z
    .object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      projectId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      provider: z.enum(["ANTHROPIC", "OPENAI", "GEMINI", "MINIMAX", "OPENROUTER", "DEEPSEEK", "OLLAMA"]).optional(),
      model: z.string().max(100).optional(),
    })
    .default({}),
});

const jobSelect = {
  id: true, status: true, rowCount: true, error: true, expiresAt: true, createdAt: true, params: true,
} as const;

interface ExportsModuleOptions {
  prisma: PrismaClient;
  authenticate: preHandlerHookHandler;
  exportQueue: Queue;
}

export function registerExportsModule(app: FastifyInstance, opts: ExportsModuleOptions): void {
  const { prisma, authenticate, exportQueue } = opts;
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];

  /** Scoped members export only their own usage; ADMIN/OWNER/VIEWER export workspace-wide. */
  function scopeUserId(request: { wsCtx?: { role: string }; user?: { id: string } }): string | undefined {
    const role = request.wsCtx!.role;
    const wide = hasMinimumRole(role as never, "ADMIN") || role === "VIEWER";
    return wide ? undefined : request.user!.id;
  }

  app.post("/workspaces/:ws/exports", { preHandler: member }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const scoped = scopeUserId(request);
    const params: ExportParams = {
      kind: body.kind,
      filters: body.filters as ExportFilters, // zod-validated; exactOptional-safe
      ...(scoped ? { scopeUserId: scoped } : {}),
    };

    const job = await prisma.exportJob.create({
      data: {
        workspaceId: request.wsCtx!.workspaceId,
        requestedById: request.user!.id,
        params: params as unknown as Prisma.InputJsonValue,
        status: "PENDING",
      },
      select: jobSelect,
    });

    await exportQueue.add("export", { exportJobId: job.id }, {
      jobId: job.id,
      removeOnComplete: 100,
      removeOnFail: 100,
      attempts: 2,
      backoff: { type: "fixed", delay: 3000 },
    });

    return reply.status(202).send(serialize(job));
  });

  app.get("/workspaces/:ws/exports", { preHandler: member }, async (request) => {
    const jobs = await prisma.exportJob.findMany({
      where: {
        workspaceId: request.wsCtx!.workspaceId,
        // A scoped member sees only exports they requested.
        ...(scopeUserId(request) ? { requestedById: request.user!.id } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: jobSelect,
    });
    return { data: jobs.map(serialize) };
  });

  app.get("/workspaces/:ws/exports/:id", { preHandler: member }, async (request) => {
    const job = await findJob(prisma, request);
    return serialize(job);
  });

  app.get("/workspaces/:ws/exports/:id/download", { preHandler: member }, async (request, reply) => {
    const job = await findJob(prisma, request);
    if (job.status !== "DONE" || !job.filePath) {
      throw new NotFoundError("Export file (job not finished)");
    }
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
      throw new NotFoundError("Export file (expired)");
    }
    try {
      await stat(job.filePath);
    } catch {
      throw new NotFoundError("Export file");
    }
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="tokentrail-export-${job.id}.csv"`);
    return reply.send(createReadStream(job.filePath));
  });
}

async function findJob(
  prisma: PrismaClient,
  request: { params: unknown; wsCtx?: { workspaceId: string; role: string }; user?: { id: string } },
) {
  const { id } = request.params as { id: string };
  const wide = hasMinimumRole(request.wsCtx!.role as never, "ADMIN") || request.wsCtx!.role === "VIEWER";
  const job = await prisma.exportJob.findFirst({
    where: {
      id,
      workspaceId: request.wsCtx!.workspaceId,
      ...(wide ? {} : { requestedById: request.user!.id }),
    },
    select: { ...jobSelect, filePath: true },
  });
  if (!job) throw new NotFoundError("Export", id);
  return job;
}

function serialize(job: {
  id: string; status: string; rowCount: number | null; error: string | null;
  expiresAt: Date | null; createdAt: Date; params: unknown;
}) {
  const params = job.params as { kind?: string };
  return {
    id: job.id,
    status: job.status,
    kind: params.kind ?? "usage_events",
    rowCount: job.rowCount,
    error: job.error,
    expiresAt: job.expiresAt,
    createdAt: job.createdAt,
    downloadUrl: job.status === "DONE" ? `./exports/${job.id}/download` : null,
  };
}
