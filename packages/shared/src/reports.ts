import type { Provider } from "./enums.js";

/** Async-export report kinds. Phase-1 async export covers raw usage events —
 *  the genuinely large export; the explorer handles bounded views client-side. */
export type ExportKind = "usage_events";

export interface ExportFilters {
  from?: string; // ISO 8601
  to?: string;
  projectId?: string;
  userId?: string;
  provider?: Provider;
  model?: string;
}

/** Stored on ExportJob.params; the worker reads it to run the export. */
export interface ExportParams {
  kind: ExportKind;
  filters?: ExportFilters;
  /** Set when the requester is a scoped member — the worker ANDs this in so a
   *  member can only ever export their own usage. */
  scopeUserId?: string;
}

/** BullMQ job payload for the export-csv queue. */
export interface ExportJobData {
  exportJobId: string;
}
