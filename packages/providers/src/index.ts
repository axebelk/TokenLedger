export * from "./types.js";
export * from "./translate.js";
export { anthropicAdapter } from "./anthropic.js";
export { openaiAdapter } from "./openai.js";
export { ollamaAdapter } from "./ollama.js";
export { geminiAdapter } from "./gemini.js";
export { deepseekAdapter } from "./deepseek.js";
export { openrouterAdapter } from "./openrouter.js";
export { minimaxAdapter } from "./minimax.js";
export { createOpenAiCompatibleAdapter } from "./openai-compatible.js";

import type { Provider } from "@tokentrail/shared";
import type { ProviderAdapter } from "./types.js";
import { anthropicAdapter } from "./anthropic.js";
import { openaiAdapter } from "./openai.js";
import { ollamaAdapter } from "./ollama.js";
import { geminiAdapter } from "./gemini.js";
import { deepseekAdapter } from "./deepseek.js";
import { openrouterAdapter } from "./openrouter.js";
import { minimaxAdapter } from "./minimax.js";

/** Adapter registry — all seven supported providers. */
const adapters: Record<Provider, ProviderAdapter> = {
  ANTHROPIC: anthropicAdapter,
  OPENAI: openaiAdapter,
  OLLAMA: ollamaAdapter,
  GEMINI: geminiAdapter,
  DEEPSEEK: deepseekAdapter,
  OPENROUTER: openrouterAdapter,
  MINIMAX: minimaxAdapter,
};

export function getAdapter(provider: Provider): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`Provider ${provider} is not supported`);
  return adapter;
}

export function supportedProviders(): Provider[] {
  return Object.keys(adapters) as Provider[];
}
