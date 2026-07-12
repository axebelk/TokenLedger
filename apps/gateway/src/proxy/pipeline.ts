import { Readable, Transform, pipeline as streamPipeline } from "node:stream";
import { request as undiciRequest } from "undici";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PROVIDERS, uuidv7, type CostBasis, type Provider } from "@tokentrail/shared";
import { sha256Hex } from "@tokentrail/auth";
import { calculateCostUsd } from "@tokentrail/pricing";
import { getAdapter, type NormalizedUsage, type ProviderAdapter } from "@tokentrail/providers";
import type { UsageEventMessage } from "@tokentrail/queue";
import type { Logger } from "@tokentrail/telemetry";
import type { GatewayDeps, ResolvedKeyContext } from "../types.js";

const MAX_REQUEST_BODY = 20 * 1024 * 1024;
/** Hop-by-hop / recomputed headers never forwarded in either direction. */
const SKIP_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "authorization",
  "x-api-key", "accept-encoding", "keep-alive", "proxy-authorization", "te", "upgrade",
]);

export function makeGatewayHandler(deps: GatewayDeps, logger: Logger) {
  return async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const occurredAt = new Date();

    const { provider: slug } = request.params as { provider: string };
    const provider = PROVIDERS.find((p) => p.toLowerCase() === slug);
    if (!provider) {
      return sendError(reply, 404, "provider_not_configured", `Unknown provider '${slug}'`, request.id);
    }
    let adapter: ProviderAdapter;
    try {
      adapter = getAdapter(provider);
    } catch {
      return sendError(reply, 501, "provider_not_implemented", `Provider '${slug}' arrives in Phase 2`, request.id);
    }

    // ── Auth: tt_live_ key from Authorization: Bearer or x-api-key ──────────
    const presented = extractKey(request);
    if (!presented) {
      return sendError(reply, 401, "invalid_key", "Provide a TokenTrail virtual key (tt_live_…)", request.id);
    }
    const ctx = await deps.keyStore.resolve(sha256Hex(presented));
    if (!ctx) return sendError(reply, 401, "invalid_key", "Unknown virtual key", request.id);
    if (ctx.status === "REVOKED") {
      return sendError(reply, 401, "key_revoked", "This virtual key has been revoked", request.id);
    }
    if (ctx.status === "EXPIRED" || (ctx.expiresAt && ctx.expiresAt.getTime() < Date.now())) {
      return sendError(reply, 401, "key_expired", "This virtual key has expired", request.id);
    }
    if (ctx.providerAllowlist.length > 0 && !ctx.providerAllowlist.includes(provider)) {
      return sendError(reply, 403, "model_not_allowed", `This key may not use provider '${slug}'`, request.id);
    }

    // ── Request body: buffer (bounded), inject stream-usage options ─────────
    let bodyBuf: Buffer | undefined;
    let requestModel = "";
    if (request.body && typeof (request.body as Readable).pipe === "function") {
      bodyBuf = await readAll(request.body as Readable, MAX_REQUEST_BODY);
      if ((request.headers["content-type"] ?? "").includes("json") && bodyBuf.length > 0) {
        try {
          const parsed = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
          requestModel = typeof parsed.model === "string" ? parsed.model : "";
          bodyBuf = Buffer.from(JSON.stringify(adapter.ensureUsageInStream(parsed)));
        } catch {
          /* non-JSON payload despite header — pass through untouched */
        }
      }
    }
    if (
      ctx.modelAllowlist.length > 0 &&
      requestModel &&
      !ctx.modelAllowlist.some((allowed) => requestModel === allowed || (allowed.endsWith("*") && requestModel.startsWith(allowed.slice(0, -1))))
    ) {
      return sendError(reply, 403, "model_not_allowed", `Model '${requestModel}' is not allowed for this key`, request.id);
    }

    const rawUrl = request.raw.url ?? "";
    const queryIndex = rawUrl.indexOf("?");
    const subPath = "/" + ((request.params as Record<string, string>)["*"] ?? "") +
      (queryIndex >= 0 ? rawUrl.slice(queryIndex) : "");

    const emitter = new EventFinalizer({
      deps, adapter, ctx, provider,
      endpoint: subPath.split("?")[0] ?? subPath,
      requestId: request.id, requestModel, occurredAt, startedAt, logger,
    });

    // ── Rate limit (per-key RPM, fixed window, fails open) ──────────────────
    if (ctx.rpmLimit) {
      const decision = await deps.rateLimiter.check(`vk:${ctx.vkId}`, ctx.rpmLimit);
      if (!decision.allowed) {
        reply.header("retry-after", String(decision.retryAfterS));
        emitter.finalize({ httpStatus: 429, streamed: false, usage: null, statusOverride: "BLOCKED_RATELIMIT" });
        return sendError(reply, 429, "rate_limited",
          `Key rate limit of ${ctx.rpmLimit} requests/minute exceeded`, request.id);
      }
    }

    // ── Credential ───────────────────────────────────────────────────────────
    let credential;
    try {
      credential = await deps.credentialStore.getDefault(ctx.workspaceId, provider);
    } catch (err) {
      logger.error({ err, provider }, "credential resolution failed");
      credential = null;
    }
    if (!credential) {
      return sendError(reply, 404, "provider_not_configured",
        `No active ${slug} credential configured for this workspace`, request.id);
    }
    emitter.setCredentialId(credential.credentialId);

    // ── Proxy ────────────────────────────────────────────────────────────────
    const upstream = adapter.buildUpstream(subPath, credential);

    let upstreamRes;
    try {
      upstreamRes = await undiciRequest(upstream.url, {
        method: request.method as "POST" | "GET" | "PUT" | "DELETE",
        headers: {
          ...forwardableHeaders(request.headers),
          ...upstream.headers,
          "accept-encoding": "identity",
          "user-agent": "tokentrail-gateway/0.1",
        },
        ...(bodyBuf ? { body: bodyBuf } : {}),
        headersTimeout: 60_000,
        bodyTimeout: 600_000,
      });
    } catch (err) {
      logger.warn({ err, url: upstream.url }, "upstream unreachable");
      emitter.finalize({ httpStatus: 502, streamed: false, usage: null });
      return sendError(reply, 502, "upstream_unavailable", "The AI provider could not be reached", request.id);
    }

    reply.status(upstreamRes.statusCode);
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (!SKIP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
        reply.header(name, value as string | string[]);
      }
    }

    const contentType = String(upstreamRes.headers["content-type"] ?? "");
    const isSse = contentType.includes("text/event-stream");
    const isNdjson = contentType.includes("ndjson");

    if ((isSse || isNdjson) && upstreamRes.statusCode < 400) {
      // Streaming: pass bytes through untouched, tap frames for usage.
      const extractor = adapter.streamUsageExtractor();
      const tap = new FrameTap(isSse ? "\n\n" : "\n", (frame) => extractor.onFrame(frame), emitter);
      streamPipeline(upstreamRes.body, tap, (err) => {
        // err ≠ null ⇒ client abort or upstream drop; usage so far still counts.
        emitter.finalize({
          httpStatus: upstreamRes.statusCode,
          streamed: true,
          usage: extractor.finish(),
          aborted: Boolean(err),
        });
      });
      return reply.send(tap);
    }

    // Non-streaming (or upstream error): buffer, extract usage, pass through.
    const resBody = await readAll(upstreamRes.body, MAX_REQUEST_BODY);
    let usage: NormalizedUsage | null = null;
    if (upstreamRes.statusCode < 400 && contentType.includes("json")) {
      try {
        usage = adapter.parseUsage(JSON.parse(resBody.toString("utf8")) as Record<string, unknown>);
      } catch {
        /* unparseable success body — record zero usage */
      }
    }
    emitter.finalize({ httpStatus: upstreamRes.statusCode, streamed: false, usage });
    return reply.send(resBody);
  };
}

// ─────────────────────────── helpers ───────────────────────────

function extractKey(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer tt_")) return auth.slice("Bearer ".length);
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.startsWith("tt_")) return apiKey;
  return null;
}

function forwardableHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !SKIP_HEADERS.has(name) && !name.startsWith("x-tokentrail-")) {
      out[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return out;
}

async function readAll(stream: Readable, limit: number): Promise<Buffer> {
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

/** Pass-through Transform that feeds complete frames (SSE blocks or NDJSON lines) to a callback. */
class FrameTap extends Transform {
  private pending = "";
  private sawFirstByte = false;

  constructor(
    private delimiter: string,
    private onFrame: (frame: string) => void,
    private emitter: EventFinalizer,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: string, done: (err?: Error | null, data?: Buffer) => void): void {
    if (!this.sawFirstByte) {
      this.sawFirstByte = true;
      this.emitter.markFirstByte();
    }
    this.pending += chunk.toString("utf8");
    let index;
    while ((index = this.pending.indexOf(this.delimiter)) >= 0) {
      const frame = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + this.delimiter.length);
      if (frame.trim().length > 0) safeFrame(this.onFrame, frame);
    }
    done(null, chunk); // bytes pass through completely untouched
  }

  override _flush(done: (err?: Error | null) => void): void {
    if (this.pending.trim().length > 0) safeFrame(this.onFrame, this.pending);
    done();
  }
}

function safeFrame(onFrame: (frame: string) => void, frame: string): void {
  try {
    onFrame(frame);
  } catch {
    /* a malformed frame must never break the byte stream */
  }
}

interface FinalizeArgs {
  httpStatus: number;
  streamed: boolean;
  usage: NormalizedUsage | null;
  aborted?: boolean;
  statusOverride?: "BLOCKED_RATELIMIT" | "BLOCKED_BUDGET";
}

/** Builds and emits the usage event exactly once per request. */
class EventFinalizer {
  private done = false;
  private ttftMs: number | undefined;
  private credentialId: string | undefined;

  constructor(
    private readonly info: {
      deps: GatewayDeps;
      adapter: ProviderAdapter;
      ctx: ResolvedKeyContext;
      provider: Provider;
      endpoint: string;
      requestId: string;
      requestModel: string;
      occurredAt: Date;
      startedAt: bigint;
      logger: Logger;
    },
  ) {}

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

function sendError(
  reply: FastifyReply,
  status: number,
  type: string,
  message: string,
  requestId: string,
) {
  return reply.status(status).send({ error: { type, message, requestId } });
}
