import { Readable, pipeline as streamPipeline } from "node:stream";
import { request as undiciRequest } from "undici";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PROVIDERS, type Provider } from "@tokentrail/shared";
import {
  getAdapter,
  anthropicToOpenaiResponse,
  createAnthropicToOpenaiStream,
  geminiToOpenaiResponse,
  openaiToAnthropicRequest,
  openaiToGeminiRequest,
  type NormalizedUsage,
} from "@tokentrail/providers";
import type { Logger } from "@tokentrail/telemetry";
import type { GatewayDeps } from "../types.js";
import {
  EventFinalizer, FrameTap, MAX_REQUEST_BODY,
  authorizeKey, forwardableHeaders, readAll, sendGatewayError,
} from "./core.js";

/**
 * Unified OpenAI-compatible endpoint: POST /gw/v1/chat/completions.
 * The `model` field carries a provider prefix ("anthropic/claude-sonnet-5").
 * OpenAI-shaped providers pass through; Anthropic and Gemini are translated in
 * both directions. Metering always uses the upstream native usage, so cost is
 * correct regardless of translation.
 */

type Shape = "openai" | "anthropic" | "gemini";
const SHAPE: Record<Provider, Shape> = {
  OPENAI: "openai", DEEPSEEK: "openai", OPENROUTER: "openai", MINIMAX: "openai", OLLAMA: "openai",
  ANTHROPIC: "anthropic", GEMINI: "gemini",
};
/** Upstream chat path per OpenAI-compatible provider. */
const OPENAI_PATH: Partial<Record<Provider, string>> = {
  OPENAI: "/v1/chat/completions",
  DEEPSEEK: "/v1/chat/completions",
  OPENROUTER: "/v1/chat/completions",
  MINIMAX: "/v1/text/chatcompletion_v2",
  OLLAMA: "/v1/chat/completions", // Ollama exposes an OpenAI-compatible surface
};

export function makeUnifiedHandler(deps: GatewayDeps, logger: Logger) {
  return async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const occurredAt = new Date();

    // ── Auth ────────────────────────────────────────────────────────────────
    const auth = await authorizeKey(deps, request);
    if ("error" in auth) {
      return sendGatewayError(reply, auth.error.status, auth.error.type, auth.error.message, request.id);
    }
    const { ctx } = auth;

    // ── Parse body + resolve provider/model from the model prefix ───────────
    const raw = await readAll(request.body as Readable, MAX_REQUEST_BODY);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return sendGatewayError(reply, 400, "invalid_request", "Request body must be JSON", request.id);
    }
    const modelField = typeof parsed.model === "string" ? parsed.model : "";
    const slashIndex = modelField.indexOf("/");
    if (slashIndex <= 0) {
      return sendGatewayError(reply, 400, "invalid_request",
        `model must be "<provider>/<model>", got "${modelField}"`, request.id);
    }
    const providerSlug = modelField.slice(0, slashIndex).toLowerCase();
    const realModel = modelField.slice(slashIndex + 1);
    const provider = PROVIDERS.find((p) => p.toLowerCase() === providerSlug);
    if (!provider) {
      return sendGatewayError(reply, 400, "invalid_request", `Unknown provider '${providerSlug}'`, request.id);
    }
    const adapter = getAdapter(provider);
    const wantStream = parsed.stream === true;

    // ── Authorization: provider + model allowlists ──────────────────────────
    if (ctx.providerAllowlist.length > 0 && !ctx.providerAllowlist.includes(provider)) {
      return sendGatewayError(reply, 403, "model_not_allowed", `This key may not use provider '${providerSlug}'`, request.id);
    }
    if (
      ctx.modelAllowlist.length > 0 &&
      !ctx.modelAllowlist.some((a) => realModel === a || (a.endsWith("*") && realModel.startsWith(a.slice(0, -1))))
    ) {
      return sendGatewayError(reply, 403, "model_not_allowed", `Model '${realModel}' is not allowed for this key`, request.id);
    }

    const shape = SHAPE[provider];
    // Gemini streaming translation isn't supported on the unified endpoint yet;
    // its native /gw/gemini route streams fully.
    if (shape === "gemini" && wantStream) {
      return sendGatewayError(reply, 400, "unsupported",
        "Streaming Gemini via the unified endpoint isn't supported yet — use stream:false, or the native /gw/gemini route", request.id);
    }
    const endpoint = "/v1/chat/completions";
    const emitter = new EventFinalizer({
      deps, ctx, provider, endpoint,
      requestId: request.id, requestModel: realModel, occurredAt, startedAt, logger,
    });

    // ── Prechecks (rate limit, then budget) ─────────────────────────────────
    if (ctx.rpmLimit) {
      const decision = await deps.rateLimiter.check(`vk:${ctx.vkId}`, ctx.rpmLimit);
      if (!decision.allowed) {
        reply.header("retry-after", String(decision.retryAfterS));
        emitter.finalize({ httpStatus: 429, streamed: false, usage: null, statusOverride: "BLOCKED_RATELIMIT" });
        return sendGatewayError(reply, 429, "rate_limited",
          `Key rate limit of ${ctx.rpmLimit} requests/minute exceeded`, request.id);
      }
    }
    // (Enterprise budget enforcement hooks in here on the enterprise branch.)

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
        `No active ${providerSlug} credential configured for this workspace`, request.id);
    }
    emitter.setCredentialId(credential.credentialId);

    // ── Translate the request per provider shape ────────────────────────────
    let upstreamPath: string;
    let upstreamBody: Record<string, unknown>;
    if (shape === "openai") {
      upstreamPath = OPENAI_PATH[provider]!;
      upstreamBody = adapter.ensureUsageInStream({ ...parsed, model: realModel });
    } else if (shape === "anthropic") {
      upstreamPath = "/v1/messages";
      upstreamBody = openaiToAnthropicRequest(parsed as never, realModel);
    } else {
      const verb = wantStream ? "streamGenerateContent" : "generateContent";
      const suffix = wantStream ? "?alt=sse" : "";
      upstreamPath = `/v1beta/models/${realModel}:${verb}${suffix}`;
      upstreamBody = openaiToGeminiRequest(parsed as never);
    }
    const upstream = adapter.buildUpstream(upstreamPath, credential);

    // ── Proxy ────────────────────────────────────────────────────────────────
    let upstreamRes;
    try {
      upstreamRes = await undiciRequest(upstream.url, {
        method: "POST",
        headers: {
          ...forwardableHeaders(request.headers),
          ...upstream.headers,
          "content-type": "application/json",
          "accept-encoding": "identity",
          "user-agent": "tokentrail-gateway/0.1",
        },
        body: JSON.stringify(upstreamBody),
        headersTimeout: 60_000,
        bodyTimeout: 600_000,
      });
    } catch (err) {
      logger.warn({ err, url: upstream.url }, "upstream unreachable");
      emitter.finalize({ httpStatus: 502, streamed: false, usage: null });
      return sendGatewayError(reply, 502, "upstream_unavailable", "The AI provider could not be reached", request.id);
    }

    const upstreamType = String(upstreamRes.headers["content-type"] ?? "");
    const upstreamIsSse = upstreamType.includes("text/event-stream");
    const created = Math.floor(occurredAt.getTime() / 1000);

    // Upstream error → surface status + body (best-effort JSON passthrough).
    if (upstreamRes.statusCode >= 400) {
      const errBody = await readAll(upstreamRes.body, MAX_REQUEST_BODY);
      emitter.finalize({ httpStatus: upstreamRes.statusCode, streamed: false, usage: null });
      reply.status(upstreamRes.statusCode).type(upstreamType || "application/json");
      return reply.send(errBody);
    }

    // ── Streaming ─────────────────────────────────────────────────────────────
    if (wantStream && upstreamIsSse) {
      reply.status(200).type("text/event-stream").header("cache-control", "no-cache");
      const extractor = adapter.streamUsageExtractor();
      const translator =
        shape === "anthropic" ? createAnthropicToOpenaiStream(realModel, created) : null;
      const tap = new FrameTap(
        "\n\n",
        (frame) => extractor.onFrame(frame),
        () => emitter.markFirstByte(),
        // OpenAI-shaped upstreams stream OpenAI chunks already → passthrough.
        // Anthropic → re-encode. (Gemini streaming translation not yet supported;
        // guarded below so we never reach here for Gemini.)
        translator ? (frame) => translator.onFrame(frame) : undefined,
      );
      streamPipeline(upstreamRes.body, tap, (err) => {
        emitter.finalize({
          httpStatus: 200, streamed: true, usage: extractor.finish(), aborted: Boolean(err),
        });
      });
      return reply.send(tap);
    }

    // ── Non-streaming ─────────────────────────────────────────────────────────
    const bodyBuf = await readAll(upstreamRes.body, MAX_REQUEST_BODY);
    let usage: NormalizedUsage | null = null;
    let clientBody: unknown = bodyBuf;
    try {
      const json = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
      usage = adapter.parseUsage(json);
      if (shape === "anthropic") clientBody = anthropicToOpenaiResponse(json as never, created);
      else if (shape === "gemini") clientBody = geminiToOpenaiResponse(json as never, realModel, created);
      else clientBody = json; // already OpenAI-shaped
    } catch {
      /* unparseable — pass raw bytes, zero usage */
    }
    emitter.finalize({ httpStatus: 200, streamed: false, usage });
    reply.status(200).type("application/json");
    return reply.send(clientBody);
  };
}
