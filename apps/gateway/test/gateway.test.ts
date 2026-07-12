import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintVirtualKey, sha256Hex } from "@tokentrail/auth";
import { buildServer, type GatewayServer } from "../src/server.js";
import type { GatewayConfig } from "../src/config.js";
import { CollectingSink, InMemoryCredentialStore, InMemoryKeyStore } from "../src/stores/memory.js";
import { StaticPricingSource } from "../src/pricing.js";
import { MemoryRateLimiter } from "../src/ratelimit.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";
import type { ResolvedKeyContext } from "../src/types.js";

const config: GatewayConfig = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  PUBLIC_BASE_URL: "http://localhost:8080",
  REDIS_URL: "redis://127.0.0.1:6390", // never contacted: deps overridden, lazyConnect
  GATEWAY_FAILURE_POLICY: "FAIL_OPEN",
  GATEWAY_PORT: 0,
};

const WS = "0198c0de-0000-7000-8000-00000000w001";
const ctxBase: Omit<ResolvedKeyContext, "vkId"> = {
  workspaceId: WS,
  projectId: "0198c0de-0000-7000-8000-00000000p001",
  teamId: "0198c0de-0000-7000-8000-00000000t001",
  userId: "0198c0de-0000-7000-8000-00000000u001",
  status: "ACTIVE",
  providerAllowlist: [],
  modelAllowlist: [],
};

let mock: MockProvider;
let server: GatewayServer;
let keyStore: InMemoryKeyStore;
let credStore: InMemoryCredentialStore;
let sink: CollectingSink;
let key: string;

async function waitForEvents(count: number, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sink.events.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  mock = await startMockProvider();
  keyStore = new InMemoryKeyStore();
  credStore = new InMemoryCredentialStore();
  sink = new CollectingSink();

  const minted = mintVirtualKey();
  key = minted.token;
  keyStore.set(minted.hash, { ...ctxBase, vkId: "0198c0de-0000-7000-8000-00000000k001" });
  credStore.set(WS, "ANTHROPIC", {
    credentialId: "0198c0de-0000-7000-8000-00000000c001",
    secret: "sk-ant-mock",
    baseUrl: mock.url,
  });

  server = await buildServer(config, {
    keyStore,
    credentialStore: credStore,
    sink,
    pricing: new StaticPricingSource(),
    rateLimiter: new MemoryRateLimiter(),
  });
});

afterAll(async () => {
  await server.app.close();
  server.redis.disconnect();
  server.subscriber.disconnect();
  await mock.close();
});

beforeEach(() => {
  sink.events.length = 0;
  mock.requests.length = 0;
});

describe("gateway proxy — non-streaming", () => {
  it("proxies, swaps auth, passes the body through, and meters cost", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/anthropic/v1/messages",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: { model: "claude-sonnet-4-5", max_tokens: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-tokentrail-request-id"]).toMatch(/^req_/);
    const body = res.json() as { content: { text: string }[]; usage: { input_tokens: number } };
    expect(body.content[0]?.text).toBe("Hello from mock"); // byte passthrough
    expect(body.usage.input_tokens).toBe(1000);

    // The virtual key never reached the provider; the real key did.
    const upstream = mock.requests[0]!;
    expect(upstream.headers["x-api-key"]).toBe("sk-ant-mock");
    expect(upstream.headers.authorization).toBeUndefined();

    await waitForEvents(1);
    const event = sink.events[0]!;
    expect(event).toMatchObject({
      workspaceId: WS,
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-5",
      endpoint: "/v1/messages",
      status: "OK",
      httpStatus: 200,
      streamed: false,
      inputTokens: 1000,
      outputTokens: 500,
      costBasis: "ACTUAL",
      costUsd: "0.01050000", // 1000×$3/M + 500×$15/M
    });
    expect(event.unitPrices).toMatchObject({ in: "3", out: "15" });
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("gateway proxy — streaming", () => {
  it("passes SSE through untouched and extracts usage from frames", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/anthropic/v1/messages",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: { model: "claude-sonnet-4-5", stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: message_start");
    expect(res.body).toContain('"text":"Hello"');
    expect(res.body).toContain("event: message_stop");

    await waitForEvents(1);
    const event = sink.events[0]!;
    expect(event).toMatchObject({
      streamed: true,
      inputTokens: 25,
      outputTokens: 123,
      cacheReadTokens: 10,
      costBasis: "ACTUAL",
    });
    expect(event.ttftMs).toBeGreaterThanOrEqual(0);
  });
});

describe("gateway proxy — errors and guards", () => {
  it("passes provider errors through verbatim and records PROVIDER_ERROR", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/anthropic/v1/messages",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: { fail: true },
    });

    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { type: string } }).error.type).toBe("rate_limit_error");

    await waitForEvents(1);
    expect(sink.events[0]).toMatchObject({ status: "PROVIDER_ERROR", httpStatus: 429, costUsd: "0.00000000" });
  });

  it("rejects unknown keys with 401 and emits nothing", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/anthropic/v1/messages",
      headers: { authorization: "Bearer tt_live_000000000000000000000000", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { type: string } }).error.type).toBe("invalid_key");
    expect(sink.events).toHaveLength(0);
  });

  it("rejects revoked keys with key_revoked", async () => {
    const revoked = mintVirtualKey();
    keyStore.set(revoked.hash, { ...ctxBase, vkId: "0198c0de-0000-7000-8000-00000000k002", status: "REVOKED" });
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/anthropic/v1/messages",
      headers: { authorization: `Bearer ${revoked.token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { type: string } }).error.type).toBe("key_revoked");
  });

  it("404s when the workspace has no credential for the provider", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: { model: "gpt-4o" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { type: string } }).error.type).toBe("provider_not_configured");
  });

  it("enforces the key's model allowlist", async () => {
    const limited = mintVirtualKey();
    keyStore.set(limited.hash, {
      ...ctxBase,
      vkId: "0198c0de-0000-7000-8000-00000000k003",
      modelAllowlist: ["claude-haiku-4*"],
    });
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/anthropic/v1/messages",
      headers: { authorization: `Bearer ${limited.token}`, "content-type": "application/json" },
      payload: { model: "claude-opus-4-1" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { type: string } }).error.type).toBe("model_not_allowed");
  });

  it("enforces per-key RPM limits with retry-after and records the block", async () => {
    const limited = mintVirtualKey();
    keyStore.set(limited.hash, {
      ...ctxBase,
      vkId: "0198c0de-0000-7000-8000-00000000k004",
      rpmLimit: 2,
    });
    const send = () =>
      server.app.inject({
        method: "POST",
        url: "/gw/anthropic/v1/messages",
        headers: { authorization: `Bearer ${limited.token}`, "content-type": "application/json" },
        payload: { model: "claude-sonnet-4-5" },
      });

    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const blocked = await send();
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { error: { type: string } }).error.type).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    await waitForEvents(3);
    const blockEvent = sink.events.find((e) => e.status === "BLOCKED_RATELIMIT");
    expect(blockEvent).toMatchObject({ httpStatus: 429, inputTokens: 0, costUsd: "0.00000000" });
  });

  it("returns 502 and records the event when the upstream is unreachable", async () => {
    credStore.set(WS, "OLLAMA", { credentialId: "c-dead", baseUrl: "http://127.0.0.1:1" });
    const res = await server.app.inject({
      method: "POST",
      url: "/gw/ollama/api/chat",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: { model: "llama3.3" },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { type: string } }).error.type).toBe("upstream_unavailable");

    await waitForEvents(1);
    expect(sink.events[0]).toMatchObject({ status: "PROVIDER_ERROR", httpStatus: 502, provider: "OLLAMA" });
  });
});
