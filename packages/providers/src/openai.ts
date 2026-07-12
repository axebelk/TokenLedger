import type {
  NormalizedUsage,
  ProviderAdapter,
  ResolvedCredential,
  StreamUsageExtractor,
} from "./types.js";

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function normalize(model: string, usage: OpenAiUsage, complete: boolean): NormalizedUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    model,
    // OpenAI's prompt_tokens includes cached tokens; TokenTrail prices them
    // separately, so uncached input = prompt - cached.
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    complete,
  };
}

export const openaiAdapter: ProviderAdapter = {
  id: "OPENAI",
  defaultBaseUrl: "https://api.openai.com",

  buildUpstream(path: string, credential: ResolvedCredential) {
    return {
      url: (credential.baseUrl ?? this.defaultBaseUrl) + path,
      headers: { authorization: `Bearer ${credential.secret ?? ""}` },
    };
  },

  // Streaming responses omit usage unless explicitly requested.
  ensureUsageInStream(body) {
    if (body.stream === true) {
      const opts = (body.stream_options ?? {}) as Record<string, unknown>;
      body.stream_options = { ...opts, include_usage: true };
    }
    return body;
  },

  parseUsage(json) {
    const usage = (json.usage ?? {}) as OpenAiUsage;
    return normalize(String(json.model ?? ""), usage, json.usage != null);
  },

  streamUsageExtractor(): StreamUsageExtractor {
    let model = "";
    let usage: OpenAiUsage | null = null;

    return {
      onFrame(frame) {
        const data = ssePayload(frame);
        if (!data) return;
        if (typeof data.model === "string" && data.model) model = data.model;
        // The final chunk (empty choices) carries the usage object.
        if (data.usage && typeof data.usage === "object") {
          usage = data.usage as OpenAiUsage;
        }
      },
      finish: () => normalize(model, usage ?? {}, usage !== null),
    };
  },

  mapError(httpStatus, body) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: { message?: string } }).error?.message ?? "")
        : "Upstream error";
    return { type: "provider_error", httpStatus, message };
  },
};

function ssePayload(frame: string): Record<string, unknown> | null {
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
