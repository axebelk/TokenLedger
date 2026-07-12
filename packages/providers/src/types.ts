import type { Provider } from "@tokentrail/shared";

/** Decrypted credential handed to an adapter for one upstream call. */
export interface ResolvedCredential {
  secret?: string; // absent for Ollama
  baseUrl?: string; // overrides the adapter default
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

/** Provider-agnostic usage extracted from a response (stream or not). */
export interface NormalizedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** True when the terminal usage record was seen; false ⇒ costBasis=ESTIMATED. */
  complete: boolean;
  /** Upstream-reported cost in USD, when the provider supplies one (OpenRouter). */
  upstreamCostUsd?: string;
}

/**
 * Incremental SSE observer. The gateway pipes raw bytes through untouched and
 * feeds each complete SSE frame here; the extractor accumulates usage without
 * ever buffering the stream.
 */
export interface StreamUsageExtractor {
  onFrame(frame: string): void;
  finish(): NormalizedUsage;
}

export interface GatewayError {
  type: string;
  httpStatus: number;
  message: string;
}

/**
 * One pure module per provider — zero IO, unit-testable against recorded
 * fixtures. New provider = implement this + pricing entries + fixtures.
 */
export interface ProviderAdapter {
  id: Provider;
  defaultBaseUrl: string;
  /** Rewrites path + auth headers for the upstream; bodies pass through. */
  buildUpstream(path: string, credential: ResolvedCredential): UpstreamRequest;
  /** Mutates a request body so the stream will include usage (e.g. OpenAI
   *  stream_options.include_usage). Returns the body unchanged if n/a. */
  ensureUsageInStream(body: Record<string, unknown>): Record<string, unknown>;
  /** Extracts usage from a complete (non-streaming) JSON response body. */
  parseUsage(json: Record<string, unknown>): NormalizedUsage;
  /** Creates a per-request SSE usage observer. */
  streamUsageExtractor(): StreamUsageExtractor;
  mapError(httpStatus: number, body: unknown): GatewayError;
  /** Providers that carry the model in the URL path (Gemini) implement this so
   *  the gateway can attribute the model when the request body omits it. */
  modelFromPath?(path: string): string;
}
