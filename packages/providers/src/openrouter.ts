import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";

// OpenRouter is a marketplace fronting many models. It reports the actual
// charged cost in usage.cost when the request carries usage.include=true, so
// we request it and prefer that over our own catalog estimate (costBasis=ACTUAL).
export const openrouterAdapter = createOpenAiCompatibleAdapter({
  id: "OPENROUTER",
  defaultBaseUrl: "https://openrouter.ai/api",
  requestUsage: true,
});
