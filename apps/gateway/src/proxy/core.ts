import { Readable, Transform } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { uuidv7, type CostBasis, type Provider } from "@tokentrail/shared";
import { calculateCostUsd } from "@tokentrail/pricing";
import type { NormalizedUsage, ProviderAdapter } from "@tokentrail/providers";
import type { UsageEventMessage } from "@tokentrail/queue";
import type { Logger } from "@tokentrail/telemetry";
import type { GatewayDeps, ResolvedKeyContext } from "../types.js";

export const MAX_REQUEST_BODY = 20 * 1024 * 1024;

/** Hop-by-hop / recomputed headers never forwarded in either direction. */
export const SKIP_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "authorization",
  "x-api-key", "accept-encoding", "keep-alive", "proxy-authorization", "te", "upgrade",
]);

export function extractKey(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer tt_")) return auth.slice("Bearer ".length);
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.startsWith("tt_")) return apiKey;
  return null;
}

export function forwardableHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !SKIP_HEADERS.has(name) && !name.startsWith("x-tokentrail-")) {
      out[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return out;
}

export async function readAll(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > limit) {
      stream.destroy();
      throw new Error(`Body exceeds ${limit} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function sendGatewayError(
  reply: FastifyReply,
  status: number,
  type: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
) {
  return reply.status(status).send({ error: { type, message, requestId, ...extra } });
}

function safeFrame<T>(fn: (frame: string) => T, frame: string, fallback: T): T {
  try {
    return fn(frame);
  } catch {
    return fallback;
  }
}

/**
 * Splits an upstream stream into complete frames (SSE blocks or NDJSON lines).
 * - Always calls `tapFrame` for usage extraction.
 * - With no `transformFrame`, the original bytes pass through untouched
 *   (native passthrough — byte-identical).
 * - With `transformFrame`, the original bytes are dropped and the transformed
 *   string is written instead (unified endpoint translation).
 */
export class FrameTap extends Transform {
  private pending = "";
  private sawFirstByte = false;

  constructor(
    private delimiter: string,
    private tapFrame: (frame: string) => void,
    private onFirstByte: () => void,
    private transformFrame?: (frame: string) => string,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: string, done: (err?: Error | null, data?: Buffer) => void): void {
    if (!this.sawFirstByte) {
      this.sawFirstByte = true;
      this.onFirstByte();
    }
    this.pending += chunk.toString("utf8");
    let out = "";
    let index;
    while ((index = this.pending.indexOf(this.delimiter)) >= 0) {
      const frame = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + this.delimiter.length);
      if (frame.trim().length > 0) {
        safeFrame(this.tapFrame, frame, undefined);
        if (this.transformFrame) out += safeFrame(this.transformFrame, frame, "");
      }
    }
    if (this.transformFrame) done(null, out ? Buffer.from(out) : Buffer.alloc(0));
    else done(null, chunk); // bytes pass through completely untouched
  }

  override _flush(done: (err?: Error | null, data?: Buffer) => void): void {
    if (this.pending.trim().length > 0) {
      safeFrame(this.tapFrame, this.pending, undefined);
      if (this.transformFrame) {
        const tail = safeFrame(this.transformFrame, this.pending, "");
        return done(null, tail ? Buffer.from(tail) : undefined);
      }
    }
    done();
  }
}

export interface FinalizeArgs {
  httpStatus: number;
  streamed: boolean;
  usage: NormalizedUsage | null;
  aborted?: boolean;
  statusOverride?: "BLOCKED_RATELIMIT" | "BLOCKED_BUDGET";
}

export interface EventFinalizerInfo {
  deps: GatewayDeps;
  ctx: ResolvedKeyContext;
  provider: Provider;
  endpoint: string;
  requestId: string;
  requestModel: string;
  occurredAt: Date;
  startedAt: bigint;
  logger: Logger;
}

/** Builds and emits the usage event exactly once per request. */
export class EventFinalizer {
  private done = false;
  private ttftMs: number | undefined;
  private credentialId: string | undefined;

  constructor(private readonly info: EventFinalizerInfo) {}

  setCredentialId(id: string): void {
    this.credentialId = id;
  }

  markFirstByte(): void {
    if (this.ttftMs === undefined) this.ttftMs = this.elapsedMs();
  }

  private elapsedMs(): number {
    return Math.round(Number(process.hrtime.bigint() - this.info.startedAt) / 1e6);
  }

  finalize(args: FinalizeArgs): void {
    if (this.done) return;
    this.done = true;
    const { deps, ctx, provider, requestModel } = this.info;

    const usage = args.usage;
    const model = usage?.model || requestModel || "unknown";
    const price = deps.pricing.match(provider, model, ctx.workspaceId);

    let costUsd = "0.00000000";
    let costBasis: CostBasis = "UNPRICED";
    if (price && usage) {
      costUsd = usage.upstreamCostUsd ?? calculateCostUsd(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
        price,
      );
      costBasis = usage.complete && !args.aborted ? "ACTUAL" : "ESTIMATED";
    }

    const event: UsageEventMessage = {
      id: uuidv7(),
      occurredAt: this.info.occurredAt.toISOString(),
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      ...(ctx.teamId ? { teamId: ctx.teamId } : {}),
      userId: ctx.userId,
      virtualKeyId: ctx.vkId,
      ...(this.credentialId ? { credentialId: this.credentialId } : {}),
      provider,
      modelRaw: requestModel || model,
      model,
      endpoint: this.info.endpoint,
      requestId: this.info.requestId,
      status: args.statusOverride ?? (args.httpStatus < 400 ? "OK" : "PROVIDER_ERROR"),
      httpStatus: args.httpStatus,
      streamed: args.streamed,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      costUsd,
      ...(price
        ? {
            unitPrices: {
              in: price.inputPerMtok,
              out: price.outputPerMtok,
              cr: price.cacheReadPerMtok,
              cw: price.cacheWritePerMtok,
              source: price.source,
            },
          }
        : {}),
      costBasis,
      latencyMs: this.elapsedMs(),
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
    };

    try {
      deps.sink.emit(event);
    } catch (err) {
      this.info.logger.error({ err }, "usage event emission threw — event dropped");
    }
  }
}

/** Resolve + validate a virtual key. Returns the context or a client error. */
export async function authorizeKey(
  deps: GatewayDeps,
  request: FastifyRequest,
): Promise<{ ctx: ResolvedKeyContext } | { error: { status: number; type: string; message: string } }> {
  const presented = extractKey(request);
  if (!presented) {
    return { error: { status: 401, type: "invalid_key", message: "Provide a TokenTrail virtual key (tt_live_…)" } };
  }
  const { sha256Hex } = await import("@tokentrail/auth");
  const ctx = await deps.keyStore.resolve(sha256Hex(presented));
  if (!ctx) return { error: { status: 401, type: "invalid_key", message: "Unknown virtual key" } };
  if (ctx.status === "REVOKED") {
    return { error: { status: 401, type: "key_revoked", message: "This virtual key has been revoked" } };
  }
  if (ctx.status === "EXPIRED" || (ctx.expiresAt && ctx.expiresAt.getTime() < Date.now())) {
    return { error: { status: 401, type: "key_expired", message: "This virtual key has expired" } };
  }
  return { ctx };
}
