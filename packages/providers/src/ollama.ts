import type {
  NormalizedUsage,
  ProviderAdapter,
  ResolvedCredential,
  StreamUsageExtractor,
} from "./types.js";

interface OllamaFinal {
  model?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

function normalize(json: OllamaFinal, complete: boolean): NormalizedUsage {
  return {
    model: json.model ?? "",
    inputTokens: json.prompt_eval_count ?? 0,
    outputTokens: json.eval_count ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    complete,
  };
}

export const ollamaAdapter: ProviderAdapter = {
  id: "OLLAMA",
  defaultBaseUrl: "http://localhost:11434",

  // Ollama is unauthenticated by default; the credential's baseUrl is the
  // whole configuration.
  buildUpstream(path: string, credential: ResolvedCredential) {
    return {
      url: (credential.baseUrl ?? this.defaultBaseUrl) + path,
      headers: {},
    };
  },

  ensureUsageInStream: (body) => body,

  parseUsage(json) {
    const final = json as OllamaFinal;
    return normalize(final, final.done === true);
  },

  // Ollama streams NDJSON, not SSE; the gateway feeds each JSON line as a frame.
  streamUsageExtractor(): StreamUsageExtractor {
    let final: OllamaFinal = {};
    let done = false;

    return {
      onFrame(frame) {
        try {
          const data = JSON.parse(frame) as OllamaFinal;
          if (data.done === true) {
            final = data;
            done = true;
          } else if (data.model) {
            final.model = data.model;
          }
        } catch {
          // partial line — ignore
        }
      },
      finish: () => normalize(final, done),
    };
  },

  mapError(httpStatus, body) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "Upstream error";
    return { type: "provider_error", httpStatus, message };
  },
};
