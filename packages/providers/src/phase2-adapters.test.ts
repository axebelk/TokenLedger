import { describe, expect, it } from "vitest";
import { deepseekAdapter } from "./deepseek.js";
import { openrouterAdapter } from "./openrouter.js";
import { minimaxAdapter } from "./minimax.js";
import { geminiAdapter } from "./gemini.js";
import { getAdapter, supportedProviders } from "./index.js";

describe("registry", () => {
  it("supports all seven providers", () => {
    expect(supportedProviders().sort()).toEqual(
      ["ANTHROPIC", "DEEPSEEK", "GEMINI", "MINIMAX", "OLLAMA", "OPENAI", "OPENROUTER"].sort(),
    );
    for (const p of supportedProviders()) expect(getAdapter(p).id).toBe(p);
  });
});

describe("deepseek adapter (OpenAI-compatible)", () => {
  it("uses bearer auth against api.deepseek.com", () => {
    const req = deepseekAdapter.buildUpstream("/chat/completions", { secret: "sk-deepseek" });
    expect(req.url).toBe("https://api.deepseek.com/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-deepseek");
  });

  it("parses usage incl. reasoning + cached tokens", () => {
    const usage = deepseekAdapter.parseUsage({
      model: "deepseek-reasoner",
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 400,
        prompt_tokens_details: { cached_tokens: 700 },
        completion_tokens_details: { reasoning_tokens: 250 },
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 300,
      cacheReadTokens: 700,
      outputTokens: 400,
      reasoningTokens: 250,
      complete: true,
    });
  });
});

describe("openrouter adapter", () => {
  it("requests usage accounting on streams and non-streams", () => {
    expect(openrouterAdapter.ensureUsageInStream({ stream: true })).toMatchObject({
      stream_options: { include_usage: true },
      usage: { include: true },
    });
    expect(openrouterAdapter.ensureUsageInStream({ model: "x" })).toMatchObject({
      usage: { include: true },
    });
  });

  it("prefers upstream-reported cost (costBasis becomes ACTUAL)", () => {
    const usage = openrouterAdapter.parseUsage({
      model: "anthropic/claude-sonnet-4.5",
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.00123456 },
    });
    expect(usage.upstreamCostUsd).toBe("0.00123456");
  });
});

describe("minimax adapter", () => {
  it("maps the base_resp error envelope even on HTTP 200", () => {
    const err = minimaxAdapter.mapError(200, {
      base_resp: { status_code: 1004, status_msg: "authentication failed" },
    });
    expect(err).toMatchObject({ type: "provider_error", httpStatus: 400, message: "authentication failed" });
  });

  it("treats base_resp status_code 0 as no error, falls through", () => {
    const err = minimaxAdapter.mapError(500, { error: { message: "boom" } });
    expect(err.message).toBe("boom");
  });
});

describe("gemini adapter", () => {
  it("authenticates with x-goog-api-key header, not a query param", () => {
    const req = geminiAdapter.buildUpstream(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      { secret: "AIza-secret" },
    );
    expect(req.headers["x-goog-api-key"]).toBe("AIza-secret");
    expect(req.url).not.toContain("AIza-secret");
  });

  it("extracts the model from the URL path", () => {
    expect(geminiAdapter.modelFromPath?.("/v1beta/models/gemini-2.5-flash:streamGenerateContent"))
      .toBe("gemini-2.5-flash");
  });

  it("parses usageMetadata incl. cached + thinking tokens", () => {
    const usage = geminiAdapter.parseUsage({
      modelVersion: "gemini-2.5-pro",
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 300,
        cachedContentTokenCount: 200,
        thoughtsTokenCount: 120,
      },
    });
    expect(usage).toMatchObject({
      model: "gemini-2.5-pro",
      inputTokens: 800,
      cacheReadTokens: 200,
      outputTokens: 300,
      reasoningTokens: 120,
      complete: true,
    });
  });

  it("accumulates usage from the final SSE chunk", () => {
    const ex = geminiAdapter.streamUsageExtractor();
    ex.onFrame('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"modelVersion":"gemini-2.5-flash"}');
    ex.onFrame('data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}');
    expect(ex.finish()).toMatchObject({
      model: "gemini-2.5-flash",
      inputTokens: 10,
      outputTokens: 5,
      complete: true,
    });
  });

  it("reports incomplete usage when the stream ends without usageMetadata", () => {
    const ex = geminiAdapter.streamUsageExtractor();
    ex.onFrame('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}');
    expect(ex.finish().complete).toBe(false);
  });
});
