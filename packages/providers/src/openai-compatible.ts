import type {
  GatewayError,
  NormalizedUsage,
  ProviderAdapter,
  ResolvedCredential,
  StreamUsageExtractor,
} from "./types.js";
import type { Provider } from "@tokentrail/shared";

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** OpenRouter reports request cost in USD here when usage.include is set. */
  cost?: number;
}

export interface OpenAiCompatibleOptions {
  id: Provider;
  defaultBaseUrl: string;
  /** Ask the provider to report cost/usage in responses (OpenRouter). */
  requestUsage?: boolean;
  /** Provider-specific error envelope mapping (e.g. Minimax base_resp). */
  mapError?: (httpStatus: number, body: unknown) => GatewayError;
}

export function normalizeOpenAiUsage(
  model: string,
  usage: OpenAiUsage,
  complete: boolean,
): NormalizedUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    model,
    // prompt_tokens includes cached tokens; TokenTrail prices them separately.
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    complete,
    ...(typeof usage.cost === "number" ? { upstreamCostUsd: usage.cost.toFixed(8) } : {}),
  };
}

export function ssePayload(frame: string): Record<string, unknown> | null {
  const line = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return null;
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function defaultMapError(httpStatus: number, body: unknown): GatewayError {
  const message =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: { message?: string } }).error?.message ?? "")
      : "Upstream error";
  return { type: "provider_error", httpStatus, message };
}

/**
 * Builds an adapter for any OpenAI-Chat-Completions-compatible provider
 * (OpenAI, DeepSeek, OpenRouter, Minimax). Bearer auth, `usage` object with
 * prompt/completion tokens, SSE with a terminal usage chunk.
 */
export function createOpenAiCompatibleAdapter(opts: OpenAiCompatibleOptions): ProviderAdapter {
  const mapError = opts.mapError ?? defaultMapError;

  return {
    id: opts.id,
    defaultBaseUrl: opts.defaultBaseUrl,

    buildUpstream(path: string, credential: ResolvedCredential) {
      return {
        url: (credential.baseUrl ?? opts.defaultBaseUrl) + path,
        headers: { authorization: `Bearer ${credential.secret ?? ""}` },
      };
    },

    ensureUsageInStream(body) {
      if (body.stream === true) {
        const streamOpts = (body.stream_options ?? {}) as Record<string, unknown>;
        body.stream_options = { ...streamOpts, include_usage: true };
      }
      if (opts.requestUsage) {
        const usageOpt = (body.usage ?? {}) as Record<string, unknown>;
        body.usage = { ...usageOpt, include: true };
      }
      return body;
    },

    parseUsage(json) {
      const usage = (json.usage ?? {}) as OpenAiUsage;
      return normalizeOpenAiUsage(String(json.model ?? ""), usage, json.usage != null);
    },

    streamUsageExtractor(): StreamUsageExtractor {
      let model = "";
      let usage: OpenAiUsage | null = null;
      return {
        onFrame(frame) {
          const data = ssePayload(frame);
          if (!data) return;
          if (typeof data.model === "string" && data.model) model = data.model;
          if (data.usage && typeof data.usage === "object") usage = data.usage as OpenAiUsage;
        },
        finish: () => normalizeOpenAiUsage(model, usage ?? {}, usage !== null),
      };
    },

    mapError,
  };
}
