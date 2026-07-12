import type {
  NormalizedUsage,
  ProviderAdapter,
  ResolvedCredential,
  StreamUsageExtractor,
} from "./types.js";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function normalize(model: string, usage: AnthropicUsage, complete: boolean): NormalizedUsage {
  return {
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    reasoningTokens: 0,
    complete,
  };
}

export const anthropicAdapter: ProviderAdapter = {
  id: "ANTHROPIC",
  defaultBaseUrl: "https://api.anthropic.com",

  buildUpstream(path: string, credential: ResolvedCredential) {
    return {
      url: (credential.baseUrl ?? this.defaultBaseUrl) + path,
      headers: {
        "x-api-key": credential.secret ?? "",
        "anthropic-version": "2023-06-01",
      },
    };
  },

  // Anthropic streams always carry usage in message_start/message_delta.
  ensureUsageInStream: (body) => body,

  parseUsage(json) {
    const usage = (json.usage ?? {}) as AnthropicUsage;
    return normalize(String(json.model ?? ""), usage, json.usage != null);
  },

  streamUsageExtractor(): StreamUsageExtractor {
    let model = "";
    const acc: AnthropicUsage = {};
    let sawDelta = false;

    return {
      onFrame(frame) {
        const data = ssePayload(frame);
        if (!data) return;
        // message_start carries model + input/cache tokens; message_delta
        // carries the authoritative cumulative output_tokens.
        if (data.type === "message_start" && typeof data.message === "object" && data.message) {
          const message = data.message as { model?: string; usage?: AnthropicUsage };
          model = message.model ?? model;
          Object.assign(acc, message.usage ?? {});
        } else if (data.type === "message_delta") {
          const usage = (data as { usage?: AnthropicUsage }).usage;
          if (usage) {
            if (usage.output_tokens != null) acc.output_tokens = usage.output_tokens;
            if (usage.input_tokens != null) acc.input_tokens = usage.input_tokens;
            sawDelta = true;
          }
        }
      },
      finish: () => normalize(model, acc, sawDelta),
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
