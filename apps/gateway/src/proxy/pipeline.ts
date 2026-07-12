import { Readable, pipeline as streamPipeline } from "node:stream";
import { request as undiciRequest } from "undici";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PROVIDERS } from "@tokentrail/shared";
import { sha256Hex } from "@tokentrail/auth";
import { getAdapter, type NormalizedUsage, type ProviderAdapter } from "@tokentrail/providers";
import type { Logger } from "@tokentrail/telemetry";
import type { GatewayDeps } from "../types.js";
import {
  EventFinalizer, FrameTap, MAX_REQUEST_BODY, SKIP_HEADERS,
  extractKey, forwardableHeaders, readAll, sendGatewayError,
} from "./core.js";

export function makeGatewayHandler(deps: GatewayDeps, logger: Logger) {
  return async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const occurredAt = new Date();

    const { provider: slug } = request.params as { provider: string };
    const provider = PROVIDERS.find((p) => p.toLowerCase() === slug);
    if (!provider) {
      return sendGatewayError(reply, 404, "provider_not_configured", `Unknown provider '${slug}'`, request.id);
    }
    const adapter: ProviderAdapter = getAdapter(provider);

    // ── Auth: tt_live_ key from Authorization: Bearer or x-api-key ──────────
    const presented = extractKey(request);
    if (!presented) {
      return sendGatewayError(reply, 401, "invalid_key", "Provide a TokenTrail virtual key (tt_live_…)", request.id);
    }
    const ctx = await deps.keyStore.resolve(sha256Hex(presented));
    if (!ctx) return sendGatewayError(reply, 401, "invalid_key", "Unknown virtual key", request.id);
    if (ctx.status === "REVOKED") {
      return sendGatewayError(reply, 401, "key_revoked", "This virtual key has been revoked", request.id);
    }
    if (ctx.status === "EXPIRED" || (ctx.expiresAt && ctx.expiresAt.getTime() < Date.now())) {
      return sendGatewayError(reply, 401, "key_expired", "This virtual key has expired", request.id);
    }
    if (ctx.providerAllowlist.length > 0 && !ctx.providerAllowlist.includes(provider)) {
      return sendGatewayError(reply, 403, "model_not_allowed", `This key may not use provider '${slug}'`, request.id);
    }

    const rawUrl = request.raw.url ?? "";
    const queryIndex = rawUrl.indexOf("?");
    const subPath = "/" + ((request.params as Record<string, string>)["*"] ?? "") +
      (queryIndex >= 0 ? rawUrl.slice(queryIndex) : "");

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
    // Providers that carry the model in the URL path (Gemini) — attribute it
    // when the request body has none, before the allowlist check applies.
    if (!requestModel && adapter.modelFromPath) {
      requestModel = adapter.modelFromPath(subPath);
    }
    if (
      ctx.modelAllowlist.length > 0 &&
      requestModel &&
      !ctx.modelAllowlist.some((allowed) => requestModel === allowed || (allowed.endsWith("*") && requestModel.startsWith(allowed.slice(0, -1))))
    ) {
      return sendGatewayError(reply, 403, "model_not_allowed", `Model '${requestModel}' is not allowed for this key`, request.id);
    }

    const emitter = new EventFinalizer({
      deps, ctx, provider,
      endpoint: subPath.split("?")[0] ?? subPath,
      requestId: request.id, requestModel, occurredAt, startedAt, logger,
    });

    // ── Rate limit (per-key RPM, fixed window, fails open) ──────────────────
    if (ctx.rpmLimit) {
      const decision = await deps.rateLimiter.check(`vk:${ctx.vkId}`, ctx.rpmLimit);
      if (!decision.allowed) {
        reply.header("retry-after", String(decision.retryAfterS));
        emitter.finalize({ httpStatus: 429, streamed: false, usage: null, statusOverride: "BLOCKED_RATELIMIT" });
        return sendGatewayError(reply, 429, "rate_limited",
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
      return sendGatewayError(reply, 404, "provider_not_configured",
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
      return sendGatewayError(reply, 502, "upstream_unavailable", "The AI provider could not be reached", request.id);
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
      const tap = new FrameTap(
        isSse ? "\n\n" : "\n",
        (frame) => extractor.onFrame(frame),
        () => emitter.markFirstByte(),
      );
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
