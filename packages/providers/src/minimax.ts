import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";
import type { GatewayError } from "./types.js";

/**
 * Minimax exposes an OpenAI-compatible chat surface but signals errors through
 * a `base_resp: { status_code, status_msg }` envelope — often with HTTP 200 and
 * a non-zero status_code. Map that to a gateway error so failed calls aren't
 * recorded as successful usage.
 */
function mapMinimaxError(httpStatus: number, body: unknown): GatewayError {
  if (typeof body === "object" && body !== null && "base_resp" in body) {
    const base = (body as { base_resp?: { status_code?: number; status_msg?: string } }).base_resp;
    if (base && base.status_code && base.status_code !== 0) {
      return {
        type: "provider_error",
        httpStatus: httpStatus >= 400 ? httpStatus : 400,
        message: base.status_msg ?? `Minimax error ${base.status_code}`,
      };
    }
  }
  const message =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: { message?: string } }).error?.message ?? "")
      : "Upstream error";
  return { type: "provider_error", httpStatus, message };
}

export const minimaxAdapter = createOpenAiCompatibleAdapter({
  id: "MINIMAX",
  defaultBaseUrl: "https://api.minimax.chat",
  mapError: mapMinimaxError,
});

export { mapMinimaxError };
