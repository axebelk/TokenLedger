import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { csvRow, type ExportParams } from "@tokentrail/shared";
import { Prisma, type PrismaClient } from "@tokentrail/db";
import type { Logger } from "@tokentrail/telemetry";

const BATCH = 1000;
const EXPIRY_MS = 24 * 60 * 60 * 1000;

const EVENT_HEADER = [
  "occurredAt", "project", "user", "provider", "model", "endpoint",
  "status", "httpStatus", "streamed", "inputTokens", "outputTokens",
  "cacheReadTokens", "reasoningTokens", "costUsd", "costBasis", "latencyMs", "requestId",
];

/**
 * Runs one export job: streams matching usage events to a CSV file in batches
 * (bounded memory), then marks the job DONE with row count + path + expiry.
 * Any failure flips the job to FAILED with a message — never throws to BullMQ
 * in a way that loses the reason.
 */
export async function runExportJob(
  prisma: PrismaClient,
  exportsDir: string,
  jobId: string,
  logger: Logger,
): Promise<void> {
  const job = await prisma.exportJob.findUnique({ where: { id: jobId } });
  if (!job) {
    logger.warn({ jobId }, "export job vanished before processing");
    return;
  }
  if (job.status === "DONE" || job.status === "FAILED") return; // idempotent on retry

  await prisma.exportJob.update({ where: { id: jobId }, data: { status: "RUNNING" } });

  try {
    await mkdir(exportsDir, { recursive: true });
    const filePath = join(exportsDir, `${jobId}.csv`);
    const out = createWriteStream(filePath, { encoding: "utf8" });

    const params = job.params as unknown as ExportParams;
    let rowCount = 0;
    if (params.kind === "usage_events") {
      rowCount = await writeUsageEvents(prisma, out, job.workspaceId, params);
    } else {
      throw new Error(`Unsupported export kind: ${String((params as { kind: string }).kind)}`);
    }

    out.end();
    await once(out, "finish");

    await prisma.exportJob.update({
      where: { id: jobId },
      data: {
        status: "DONE",
        rowCount,
        filePath,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
      },
    });
    logger.info({ jobId, rowCount }, "export completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : "export failed";
    await prisma.exportJob.update({ where: { id: jobId }, data: { status: "FAILED", error: message } });
    logger.error({ err, jobId }, "export failed");
  }
}

async function writeUsageEvents(
  prisma: PrismaClient,
  out: NodeJS.WritableStream,
  workspaceId: string,
  params: ExportParams,
): Promise<number> {
  writeLine(out, csvRow(EVENT_HEADER));

  const where = buildEventWhere(workspaceId, params);
  let cursor: { occurredAt: Date; id: string } | undefined;
  let total = 0;

  for (;;) {
    const rows = await prisma.usageEvent.findMany({
      where: cursor
        ? { AND: [where, { OR: [{ occurredAt: { lt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, id: { lt: cursor.id } }] }] }
        : where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: BATCH,
      select: {
        id: true, occurredAt: true, provider: true, model: true, endpoint: true,
        status: true, httpStatus: true, streamed: true, inputTokens: true, outputTokens: true,
        cacheReadTokens: true, reasoningTokens: true, costUsd: true, costBasis: true,
        latencyMs: true, requestId: true,
        project: { select: { name: true } },
        user: { select: { name: true } },
      },
    });
    if (rows.length === 0) break;

    for (const e of rows) {
      let drained = writeLine(out, csvRow([
        e.occurredAt.toISOString(), e.project.name, e.user.name, e.provider, e.model, e.endpoint,
        e.status, e.httpStatus, e.streamed, e.inputTokens, e.outputTokens,
        e.cacheReadTokens, e.reasoningTokens, e.costUsd.toString(), e.costBasis, e.latencyMs, e.requestId,
      ]));
      if (!drained) await once(out, "drain"); // honour backpressure on large exports
    }
    total += rows.length;

    const last = rows[rows.length - 1]!;
    cursor = { occurredAt: last.occurredAt, id: last.id };
    if (rows.length < BATCH) break;
  }
  return total;
}

function buildEventWhere(workspaceId: string, params: ExportParams): Prisma.UsageEventWhereInput {
  const f = params.filters ?? {};
  const where: Prisma.UsageEventWhereInput = { workspaceId };
  if (params.scopeUserId) where.userId = params.scopeUserId;
  else if (f.userId) where.userId = f.userId;
  if (f.projectId) where.projectId = f.projectId;
  if (f.provider) where.provider = f.provider;
  if (f.model) where.model = f.model;
  if (f.from || f.to) {
    where.occurredAt = {
      ...(f.from ? { gte: new Date(f.from) } : {}),
      ...(f.to ? { lt: new Date(f.to) } : {}),
    };
  }
  return where;
}

function writeLine(out: NodeJS.WritableStream, line: string): boolean {
  return out.write(line + "\n");
}
