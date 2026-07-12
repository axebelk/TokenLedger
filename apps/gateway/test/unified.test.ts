import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mintVirtualKey } from "@tokentrail/auth";
import { buildServer, type GatewayServer } from "../src/server.js";
import type { GatewayConfig } from "../src/config.js";
import { CollectingSink, InMemoryCredentialStore, InMemoryKeyStore } from "../src/stores/memory.js";
import { StaticPricingSource } from "../src/pricing.js";
import { MemoryRateLimiter } from "../src/ratelimit.js";
import type { ResolvedKeyContext } from "../src/types.js";

/**
 * A shape-aware mock upstream: it responds in Anthropic / OpenAI / Gemini
 * format based on the request path, so we can verify unified-endpoint routing
 * and translation for each provider shape.
 */
interface Captured { path: string; body: string }
function startShapeMock(): Promise<{ url: string; requests: Captured[]; close(): Promise<void> }> {
  const requests: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      requests.push({ path, body: bodyStr });
      const sent = JSON.parse(bodyStr || "{}") as { stream?: boolean; model?: string };
      const stream = sent.stream === true;
      // Real providers echo the requested model — mirror that so metering and
      // pricing behave as they would in production.
      const pathModel = /\/models\/([^:]+):/.exec(path)?.[1];
      const model = sent.model ?? pathModel ?? "unknown";

      if (path.includes("/v1/messages")) {
        if (stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model, usage: { input_tokens: 10 } } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_1", model, content: [{ type: "text", text: "Hi from claude" }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } }));
        return;
      }
      if (path.includes(":generateContent")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ modelVersion: model, candidates: [{ content: { parts: [{ text: "Hi from gemini" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } }));
        return;
      }
      // OpenAI-compatible chat completions
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "cc_1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "Hi from openai" }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 5 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const config: GatewayConfig = {
  NODE_ENV: "test", LOG_LEVEL: "error", PUBLIC_BASE_URL: "http://localhost:8080",
  REDIS_URL: "redis://127.0.0.1:6390", GATEWAY_FAILURE_POLICY: "FAIL_OPEN", GATEWAY_PORT: 0,
};
const WS = "0198c0de-0000-7000-8000-0000000000w1";
const ctxBase: Omit<ResolvedKeyContext, "vkId"> = {
  workspaceId: WS, projectId: "0198c0de-0000-7000-8000-0000000000p1",
  userId: "0198c0de-0000-7000-8000-0000000000u1", status: "ACTIVE",
  providerAllowlist: [], modelAllowlist: [],
};

let mock: Awaited<ReturnType<typeof startShapeMock>>;
let server: GatewayServer;
let sink: CollectingSink;
let key: string;

async function waitForEvents(n: number, ms = 1500) {
  const end = Date.now() + ms;
  while (sink.events.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

beforeAll(async () => {
  mock = await startShapeMock();
  const keyStore = new InMemoryKeyStore();
  const credStore = new InMemoryCredentialStore();
  sink = new CollectingSink();
  const minted = mintVirtualKey();
  key = minted.token;
  keyStore.set(minted.hash, { ...ctxBase, vkId: "0198c0de-0000-7000-8000-0000000000k1" });
  for (const provider of ["ANTHROPIC", "OPENAI", "DEEPSEEK", "GEMINI"] as const) {
    credStore.set(WS, provider, { credentialId: `c-${provider}`, secret: "sk-x", baseUrl: mock.url });
  }
  server = await buildServer(config, {
    keyStore, credentialStore: credStore, sink,
    pricing: new StaticPricingSource(), rateLimiter: new MemoryRateLimiter(),
  });
});

afterAll(async () => {
  await server.app.close();
  server.redis.disconnect();
  server.subscriber.disconnect();
  await mock.close();
});

beforeEach(() => { sink.events.length = 0; mock.requests.length = 0; });

function call(model: string, extra: Record<string, unknown> = {}) {
  return server.app.inject({
    method: "POST", url: "/gw/v1/chat/completions",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    payload: { model, messages: [{ role: "user", content: "hi" }], ...extra },
  });
}

describe("unified endpoint — routing + translation", () => {
  it("routes OpenAI-compatible providers by prefix (passthrough)", async () => {
    const res = await call("deepseek/deepseek-chat");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe("Hi from openai");
    expect(mock.requests[0]?.path).toContain("/v1/chat/completions");
    expect(JSON.parse(mock.requests[0]!.body).model).toBe("deepseek-chat"); // prefix stripped

    await waitForEvents(1);
    expect(sink.events[0]).toMatchObject({ provider: "DEEPSEEK", model: "deepseek-chat", inputTokens: 30, outputTokens: 5 });
  });

  it("translates an Anthropic request/response to OpenAI shape", async () => {
    const res = await call("anthropic/claude-sonnet-4-5", { messages: [
      { role: "system", content: "Be nice" }, { role: "user", content: "hi" },
    ] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { object: string; choices: { message: { content: string } }[]; usage: { prompt_tokens: number } };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Hi from claude");
    expect(body.usage.prompt_tokens).toBe(100);
    // Upstream received Anthropic-shaped request
    const sent = JSON.parse(mock.requests[0]!.body);
    expect(mock.requests[0]?.path).toContain("/v1/messages");
    expect(sent.system).toBe("Be nice");
    expect(sent.max_tokens).toBeGreaterThan(0);

    await waitForEvents(1);
    expect(sink.events[0]).toMatchObject({ provider: "ANTHROPIC", inputTokens: 100, outputTokens: 20, costBasis: "ACTUAL" });
  });

  it("translates a Gemini request/response (non-streaming)", async () => {
    const res = await call("gemini/gemini-2.5-pro");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe("Hi from gemini");
    expect(mock.requests[0]?.path).toContain("gemini-2.5-pro:generateContent");
    await waitForEvents(1);
    expect(sink.events[0]).toMatchObject({ provider: "GEMINI", inputTokens: 50, outputTokens: 10 });
  });

  it("re-encodes an Anthropic stream into OpenAI chunks", async () => {
    const res = await call("anthropic/claude-sonnet-4-5", { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"object":"chat.completion.chunk"');
    expect(res.body).toContain('"content":"Hi"');
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    await waitForEvents(1);
    expect(sink.events[0]).toMatchObject({ provider: "ANTHROPIC", streamed: true, outputTokens: 4 });
  });

  it("rejects a model without a provider prefix", async () => {
    const res = await call("just-a-model");
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { type: string } }).error.type).toBe("invalid_request");
  });

  it("guards Gemini streaming with a helpful error", async () => {
    const res = await call("gemini/gemini-2.5-pro", { stream: true });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { type: string } }).error.type).toBe("unsupported");
  });

  it("enforces provider allowlist on the unified route", async () => {
    const limited = mintVirtualKey();
    (server.deps.keyStore as InMemoryKeyStore).set(limited.hash, {
      ...ctxBase, vkId: "0198c0de-0000-7000-8000-0000000000k9", providerAllowlist: ["OPENAI"],
    });
    const res = await server.app.inject({
      method: "POST", url: "/gw/v1/chat/completions",
      headers: { authorization: `Bearer ${limited.token}`, "content-type": "application/json" },
      payload: { model: "anthropic/claude-sonnet-4-5", messages: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
