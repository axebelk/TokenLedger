import type {
  NormalizedUsage,
  ProviderAdapter,
  ResolvedCredential,
  StreamUsageExtractor,
} from "./types.js";

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

/** Model lives in the URL path (…/models/{model}:generateContent), not the body. */
function modelFromPath(path: string): string {
  const match = /\/models\/([^:/?]+)/.exec(path);
  return match?.[1] ?? "";
}

function normalize(model: string, usage: GeminiUsage | undefined): NormalizedUsage {
  const cached = usage?.cachedContentTokenCount ?? 0;
  return {
    model,
    inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cached),
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: usage?.thoughtsTokenCount ?? 0,
    complete: usage != null,
  };
}

export const geminiAdapter: ProviderAdapter = {
  id: "GEMINI",
  defaultBaseUrl: "https://generativelanguage.googleapis.com",

  buildUpstream(path: string, credential: ResolvedCredential) {
    // Gemini authenticates with the API key in a header (preferred over the
    // ?key= query param so the secret never lands in URLs/logs).
    return {
      url: (credential.baseUrl ?? this.defaultBaseUrl) + path,
      headers: { "x-goog-api-key": credential.secret ?? "" },
    };
  },

  // Gemini's streamGenerateContent already includes usageMetadata on the final
  // chunk; nothing to inject.
  ensureUsageInStream: (body) => body,

  parseUsage(json) {
    const usage = json.usageMetadata as GeminiUsage | undefined;
    const model =
      typeof json.modelVersion === "string" ? json.modelVersion : String(json.model ?? "");
    return normalize(model, usage);
  },

  // Gemini streams as SSE (?alt=sse) with a JSON object per data line; the last
  // chunk carries usageMetadata.
  streamUsageExtractor(): StreamUsageExtractor {
    let model = "";
    let usage: GeminiUsage | undefined;
    return {
      onFrame(frame) {
        const data = ssePayload(frame);
        if (!data) return;
        if (typeof data.modelVersion === "string" && data.modelVersion) model = data.modelVersion;
        if (data.usageMetadata && typeof data.usageMetadata === "object") {
          usage = data.usageMetadata as GeminiUsage;
        }
      },
      finish: () => normalize(model, usage),
    };
  },

  mapError(httpStatus, body) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: { message?: string } }).error?.message ?? "")
        : "Upstream error";
    return { type: "provider_error", httpStatus, message };
  },

  modelFromPath,
};

export { modelFromPath };

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
