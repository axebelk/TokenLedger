import { describe, expect, it } from "vitest";
import {
  anthropicToOpenaiResponse,
  createAnthropicToOpenaiStream,
  geminiToOpenaiResponse,
  openaiToAnthropicRequest,
  openaiToGeminiRequest,
} from "./translate.js";

const CREATED = 1_800_000_000;

describe("openai → anthropic request", () => {
  it("hoists system messages and maps roles", () => {
    const out = openaiToAnthropicRequest(
      {
        model: "ignored",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
        ],
        max_tokens: 256,
        stop: "END",
      },
      "claude-sonnet-4-5",
    );
    expect(out).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 256,
      system: "Be terse.",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      stop_sequences: ["END"],
    });
  });

  it("defaults max_tokens (Anthropic requires it) and flattens content parts", () => {
    const out = openaiToAnthropicRequest(
      { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      "claude-haiku-4",
    );
    expect(out.max_tokens).toBe(4096);
    expect((out.messages as { content: string }[])[0]!.content).toBe("ab");
  });
});

describe("anthropic → openai response", () => {
  it("maps content, usage, and finish_reason", () => {
    const out = anthropicToOpenaiResponse(
      {
        id: "msg_1", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 12, output_tokens: 8 },
      },
      CREATED,
    ) as any;
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("Hello world");
    expect(out.choices[0].finish_reason).toBe("length");
    expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
  });
});

describe("anthropic SSE → openai chunks", () => {
  it("re-encodes the full stream and terminates with [DONE]", () => {
    const t = createAnthropicToOpenaiStream("claude-sonnet-4-5", CREATED);
    let out = "";
    out += t.onFrame('data: {"type":"message_start","message":{"model":"claude-sonnet-4-5"}}');
    out += t.onFrame('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}');
    out += t.onFrame('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}');
    out += t.onFrame('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}');
    out += t.onFrame('data: {"type":"message_stop"}');

    const chunks = out.trim().split("\n\n");
    expect(JSON.parse(chunks[0]!.slice(6)).choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(JSON.parse(chunks[1]!.slice(6)).choices[0].delta.content).toBe("Hel");
    expect(JSON.parse(chunks[2]!.slice(6)).choices[0].delta.content).toBe("lo");
    expect(JSON.parse(chunks[3]!.slice(6)).choices[0].finish_reason).toBe("stop");
    expect(chunks[4]).toBe("data: [DONE]");
  });
});

describe("openai ↔ gemini", () => {
  it("translates request: system instruction, model role, generationConfig", () => {
    const out = openaiToGeminiRequest({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
      max_tokens: 100,
      temperature: 0.5,
    }) as any;
    expect(out.systemInstruction.parts[0].text).toBe("sys");
    expect(out.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "yo" }] },
    ]);
    expect(out.generationConfig).toEqual({ maxOutputTokens: 100, temperature: 0.5 });
  });

  it("translates response with usage + finish reason", () => {
    const out = geminiToOpenaiResponse(
      {
        modelVersion: "gemini-2.5-pro",
        candidates: [{ content: { parts: [{ text: "Hi " }, { text: "there" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      },
      "gemini-2.5-pro",
      CREATED,
    ) as any;
    expect(out.choices[0].message.content).toBe("Hi there");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });
});
