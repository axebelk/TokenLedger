import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";

// DeepSeek's API is OpenAI-compatible; cached input tokens appear in
// prompt_tokens_details.cached_tokens, reasoning tokens for deepseek-reasoner
// in completion_tokens_details.reasoning_tokens — both handled by the base.
export const deepseekAdapter = createOpenAiCompatibleAdapter({
  id: "DEEPSEEK",
  defaultBaseUrl: "https://api.deepseek.com",
});
