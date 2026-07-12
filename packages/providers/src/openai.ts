import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";

export const openaiAdapter = createOpenAiCompatibleAdapter({
  id: "OPENAI",
  defaultBaseUrl: "https://api.openai.com",
});
