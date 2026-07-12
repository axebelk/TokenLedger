import type { Provider } from "../../generated/client/index.js";

/**
 * Initial pricing catalog seed — USD per 1M tokens. Best-effort published
 * prices; the weekly pricing-sync job and admin overrides keep them current.
 * effectiveFrom marks catalog validity, not provider announcement dates.
 */

export interface PriceSeed {
  provider: Provider;
  modelPattern: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
  effectiveFrom: Date;
}

const FROM = new Date("2026-01-01T00:00:00Z");

export const PRICING_SEED: PriceSeed[] = [
  // Anthropic
  { provider: "ANTHROPIC", modelPattern: "claude-opus-4*", inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5, cacheWritePerMtok: 18.75, effectiveFrom: FROM },
  { provider: "ANTHROPIC", modelPattern: "claude-sonnet-4*", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, effectiveFrom: FROM },
  { provider: "ANTHROPIC", modelPattern: "claude-haiku-4*", inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25, effectiveFrom: FROM },
  { provider: "ANTHROPIC", modelPattern: "claude-3-5-haiku*", inputPerMtok: 0.8, outputPerMtok: 4, cacheReadPerMtok: 0.08, cacheWritePerMtok: 1, effectiveFrom: FROM },

  // OpenAI
  { provider: "OPENAI", modelPattern: "gpt-4o", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 1.25, effectiveFrom: FROM },
  { provider: "OPENAI", modelPattern: "gpt-4o-mini", inputPerMtok: 0.15, outputPerMtok: 0.6, cacheReadPerMtok: 0.075, effectiveFrom: FROM },
  { provider: "OPENAI", modelPattern: "gpt-4.1*", inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, effectiveFrom: FROM },
  { provider: "OPENAI", modelPattern: "o3*", inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, effectiveFrom: FROM },
  { provider: "OPENAI", modelPattern: "text-embedding-3-small", inputPerMtok: 0.02, outputPerMtok: 0, effectiveFrom: FROM },

  // Gemini
  { provider: "GEMINI", modelPattern: "gemini-2.5-pro*", inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.31, effectiveFrom: FROM },
  { provider: "GEMINI", modelPattern: "gemini-2.5-flash*", inputPerMtok: 0.3, outputPerMtok: 2.5, cacheReadPerMtok: 0.075, effectiveFrom: FROM },

  // DeepSeek
  { provider: "DEEPSEEK", modelPattern: "deepseek-chat", inputPerMtok: 0.27, outputPerMtok: 1.1, cacheReadPerMtok: 0.07, effectiveFrom: FROM },
  { provider: "DEEPSEEK", modelPattern: "deepseek-reasoner", inputPerMtok: 0.55, outputPerMtok: 2.19, cacheReadPerMtok: 0.14, effectiveFrom: FROM },

  // Minimax
  { provider: "MINIMAX", modelPattern: "MiniMax-Text-01", inputPerMtok: 0.2, outputPerMtok: 1.1, effectiveFrom: FROM },
  { provider: "MINIMAX", modelPattern: "MiniMax-M1*", inputPerMtok: 0.4, outputPerMtok: 2.2, effectiveFrom: FROM },

  // OpenRouter — passthrough marketplace; upstream-reported cost preferred at
  // runtime. Catalog entries only for common defaults; wildcard as UNPRICED-avoider.
  { provider: "OPENROUTER", modelPattern: "openrouter/auto", inputPerMtok: 0, outputPerMtok: 0, effectiveFrom: FROM },

  // Ollama — self-hosted: $0 by default; workspaces may set internal rates via overrides.
  { provider: "OLLAMA", modelPattern: "*", inputPerMtok: 0, outputPerMtok: 0, effectiveFrom: FROM },
];
