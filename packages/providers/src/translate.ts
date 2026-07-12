/**
 * Format translation for the unified OpenAI-compatible endpoint
 * (/gw/v1/chat/completions). OpenAI-compatible providers need no translation;
 * Anthropic and Gemini do. These are pure functions — the gateway wires them
 * into request rewriting, response mapping, and (for Anthropic) SSE re-encoding.
 */

const DEFAULT_MAX_TOKENS = 4096;

interface OpenAiMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

interface OpenAiChatRequest {
  model: string;
  messages?: OpenAiMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
}

function contentToText(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  }
  return "";
}

// ─────────────────────────── Anthropic ───────────────────────────

export function openaiToAnthropicRequest(body: OpenAiChatRequest, model: string): Record<string, unknown> {
  const messages = body.messages ?? [];
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => contentToText(m.content))
    .join("\n\n");
  const converted = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: contentToText(m.content) }));

  const out: Record<string, unknown> = {
    model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    messages: converted,
  };
  if (system) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream) out.stream = true;
  return out;
}

const ANTHROPIC_FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function anthropicToOpenaiResponse(json: AnthropicResponse, created: number): Record<string, unknown> {
  const text = (json.content ?? []).map((b) => b.text ?? "").join("");
  const input = json.usage?.input_tokens ?? 0;
  const output = json.usage?.output_tokens ?? 0;
  return {
    id: json.id ?? "chatcmpl-tt",
    object: "chat.completion",
    created,
    model: json.model ?? "",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: ANTHROPIC_FINISH[json.stop_reason ?? ""] ?? "stop",
      },
    ],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

/**
 * Stateful Anthropic-SSE → OpenAI-chunk translator. Feed each raw Anthropic SSE
 * frame; get back the OpenAI `data: {…}` lines to emit (already terminated with
 * `\n\n`). Emits `data: [DONE]\n\n` after message_stop.
 */
export function createAnthropicToOpenaiStream(model: string, created: number) {
  const id = "chatcmpl-tt-stream";
  let started = false;

  function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
    return (
      "data: " +
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) +
      "\n\n"
    );
  }

  return {
    onFrame(frame: string): string {
      const data = ssePayload(frame);
      if (!data) return "";
      let out = "";
      if (data.type === "message_start" && !started) {
        started = true;
        out += chunk({ role: "assistant", content: "" }, null);
      } else if (data.type === "content_block_delta") {
        const delta = data.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) out += chunk({ content: delta.text }, null);
      } else if (data.type === "message_delta") {
        const stopReason = (data.delta as { stop_reason?: string } | undefined)?.stop_reason;
        out += chunk({}, ANTHROPIC_FINISH[stopReason ?? ""] ?? "stop");
      } else if (data.type === "message_stop") {
        out += "data: [DONE]\n\n";
      }
      return out;
    },
  };
}

// ─────────────────────────── Gemini ───────────────────────────

export function openaiToGeminiRequest(body: OpenAiChatRequest): Record<string, unknown> {
  const messages = body.messages ?? [];
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => contentToText(m.content))
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: contentToText(m.content) }],
    }));

  const generationConfig: Record<string, unknown> = {};
  if (body.max_tokens != null || body.max_completion_tokens != null) {
    generationConfig.maxOutputTokens = body.max_tokens ?? body.max_completion_tokens;
  }
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.top_p != null) generationConfig.topP = body.top_p;

  const out: Record<string, unknown> = { contents };
  if (systemText) out.systemInstruction = { parts: [{ text: systemText }] };
  if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig;
  return out;
}

const GEMINI_FINISH: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
};

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function geminiToOpenaiResponse(
  json: GeminiResponse,
  model: string,
  created: number,
): Record<string, unknown> {
  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const input = json.usageMetadata?.promptTokenCount ?? 0;
  const output = json.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    id: "chatcmpl-tt",
    object: "chat.completion",
    created,
    model: json.modelVersion ?? model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: GEMINI_FINISH[candidate?.finishReason ?? ""] ?? "stop",
      },
    ],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

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
