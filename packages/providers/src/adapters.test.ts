import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "./anthropic.js";
import { openaiAdapter } from "./openai.js";
import { ollamaAdapter } from "./ollama.js";

describe("anthropic adapter", () => {
  it("parses non-streaming usage with cache tokens", () => {
    const usage = anthropicAdapter.parseUsage({
      model: "claude-sonnet-5-20260101",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      },
    });
    expect(usage).toMatchObject({
      model: "claude-sonnet-5-20260101",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      complete: true,
    });
  });

  it("accumulates usage across SSE frames", () => {
    const extractor = anthropicAdapter.streamUsageExtractor();
    extractor.onFrame(
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":25,"cache_read_input_tokens":10}}}',
    );
    extractor.onFrame('event: content_block_delta\ndata: {"type":"content_block_delta"}');
    extractor.onFrame(
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":123}}',
    );
    expect(extractor.finish()).toMatchObject({
      model: "claude-sonnet-5",
      inputTokens: 25,
      outputTokens: 123,
      cacheReadTokens: 10,
      complete: true,
    });
  });

  it("reports incomplete usage when the stream is aborted early", () => {
    const extractor = anthropicAdapter.streamUsageExtractor();
    extractor.onFrame(
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":25}}}',
    );
    expect(extractor.finish().complete).toBe(false); // → costBasis=ESTIMATED
  });

  it("swaps auth to x-api-key", () => {
    const req = anthropicAdapter.buildUpstream("/v1/messages", { secret: "sk-ant-x" });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant-x");
  });
});

describe("openai adapter", () => {
  it("injects stream_options.include_usage only for streams", () => {
    expect(openaiAdapter.ensureUsageInStream({ stream: true })).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(openaiAdapter.ensureUsageInStream({ model: "gpt-4o" })).not.toHaveProperty(
      "stream_options",
    );
  });

  it("separates cached tokens from uncached input", () => {
    const usage = openaiAdapter.parseUsage({
      model: "gpt-4o",
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 600 },
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 200,
      reasoningTokens: 50,
    });
  });

  it("picks usage from the final stream chunk", () => {
    const extractor = openaiAdapter.streamUsageExtractor();
    extractor.onFrame('data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}');
    extractor.onFrame('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}');
    extractor.onFrame("data: [DONE]");
    expect(extractor.finish()).toMatchObject({
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 5,
      complete: true,
    });
  });
});

describe("ollama adapter", () => {
  it("reads eval counts from the terminal NDJSON line", () => {
    const extractor = ollamaAdapter.streamUsageExtractor();
    extractor.onFrame('{"model":"llama3.3","message":{"content":"partial"},"done":false}');
    extractor.onFrame('{"model":"llama3.3","done":true,"prompt_eval_count":42,"eval_count":17}');
    expect(extractor.finish()).toMatchObject({
      model: "llama3.3",
      inputTokens: 42,
      outputTokens: 17,
      complete: true,
    });
  });

  it("requires no auth header", () => {
    const req = ollamaAdapter.buildUpstream("/api/chat", { baseUrl: "http://gpu-box:11434" });
    expect(req.url).toBe("http://gpu-box:11434/api/chat");
    expect(req.headers).toEqual({});
  });
});
