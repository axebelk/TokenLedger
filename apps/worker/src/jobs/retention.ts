import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "@tokentrail/db";
import type { Logger } from "@tokentrail/telemetry";

const DELETE_BATCH = 5000;

/**
 * Daily housekeeping: prune raw usage events past the retention window and
 * clean up expired export jobs + their files. Rollups are kept indefinitely
 * (they're small and are the analytics source of truth).
 *
 * Raw events are deleted in bounded batches by ctid so we never take a long
 * lock on the hot table.
 */
export async function runRetention(
  prisma: PrismaClient,
  exportsDir: string,
  retentionDays: number,
  logger: Logger,
): Promise<{ eventsDeleted: number; exportsDeleted: number; filesDeleted: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  let eventsDeleted = 0;
  for (;;) {
    const n = await prisma.$executeRaw`
      DELETE FROM usage_event
      WHERE ctid IN (
        SELECT ctid FROM usage_event WHERE "occurredAt" < ${cutoff} LIMIT ${DELETE_BATCH}
      )`;
    eventsDeleted += n;
    if (n < DELETE_BATCH) break;
  }

  // Expired export jobs: unlink files, drop rows.
  const now = new Date();
  const expired = await prisma.exportJob.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true, filePath: true },
  });
  let filesDeleted = 0;
  for (const job of expired) {
    if (job.filePath) {
      await unlink(job.filePath).then(() => (filesDeleted += 1)).catch(() => {});
    }
  }
  const { count: exportsDeleted } = await prisma.exportJob.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  // Sweep orphaned export files no ExportJob references (crash between write + row update).
  filesDeleted += await sweepOrphanFiles(prisma, exportsDir).catch(() => 0);

  logger.info({ eventsDeleted, exportsDeleted, filesDeleted, retentionDays }, "retention complete");
  return { eventsDeleted, exportsDeleted, filesDeleted };
}


async function sweepOrphanFiles(prisma: PrismaClient, exportsDir: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(exportsDir);
  } catch {
    return 0; // dir doesn't exist yet
  }
  const csvs = files.filter((f) => f.endsWith(".csv"));
  if (csvs.length === 0) return 0;

  const ids = csvs.map((f) => f.replace(/\.csv$/, ""));
  const known = new Set(
    (await prisma.exportJob.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((j) => j.id),
  );
  let removed = 0;
  for (const file of csvs) {
    const id = file.replace(/\.csv$/, "");
    if (known.has(id)) continue;
    const path = join(exportsDir, file);
    // Only remove files older than a day, to avoid racing an in-flight export.
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs > 86_400_000) {
        await unlink(path);
        removed += 1;
      }
    } catch {
      /* gone already */
    }
  }
  return removed;
}
