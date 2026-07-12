export * from "./types.js";
export { anthropicAdapter } from "./anthropic.js";
export { openaiAdapter } from "./openai.js";
export { ollamaAdapter } from "./ollama.js";

import type { Provider } from "@tokentrail/shared";
import type { ProviderAdapter } from "./types.js";
import { anthropicAdapter } from "./anthropic.js";
import { openaiAdapter } from "./openai.js";
import { ollamaAdapter } from "./ollama.js";

/**
 * Adapter registry. Phase 1 ships the three auth/usage archetypes
 * (Anthropic = x-api-key + SSE usage frames, OpenAI = bearer + injected
 * stream usage, Ollama = unauthenticated local + eval counts); Gemini,
 * OpenRouter, DeepSeek and Minimax land in Phase 2 (see docs/12 roadmap).
 */
const adapters: Partial<Record<Provider, ProviderAdapter>> = {
  ANTHROPIC: anthropicAdapter,
  OPENAI: openaiAdapter,
  OLLAMA: ollamaAdapter,
};

export function getAdapter(provider: Provider): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`Provider ${provider} is not yet supported`);
  return adapter;
}

export function supportedProviders(): Provider[] {
  return Object.keys(adapters) as Provider[];
}
