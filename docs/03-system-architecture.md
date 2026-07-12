# TokenTrail — System Architecture

**Version:** 1.0

---

## 1. Architecture Overview

TokenTrail is split into a latency-critical **data plane** (Gateway) and a consistency-critical **control plane** (API + Worker + Console), sharing PostgreSQL and Redis. The split lets the hot path stay minimal and stateless while all heavy logic lives off the request path.

```
                        ┌────────────────────────────────────────────────────────┐
                        │                     TokenTrail                          │
                        │                                                        │
 Developer SDKs         │  ┌──────────────┐   proxy    ┌─────────────────────┐   │      AI Providers
 (Anthropic/OpenAI/…) ──┼─▶│   GATEWAY    │───────────▶│ provider adapters   │───┼──▶  Anthropic
      tt_live_… key     │  │  (Fastify)   │◀───────────│ (7 providers)       │◀──┼───  OpenAI
                        │  └──────┬───────┘  stream    └─────────────────────┘   │      Gemini
                        │         │ XADD usage event                             │      Minimax
                        │         ▼                                              │      OpenRouter
                        │  ┌──────────────┐  consume   ┌──────────────┐          │      DeepSeek
                        │  │ Redis        │───────────▶│   WORKER     │          │      Ollama
                        │  │ streams/cache│            │ (BullMQ)     │          │
                        │  └──────▲───────┘            └──────┬───────┘          │
                        │         │ key/budget cache          │ batch insert +   │
                        │         │ pub/sub invalidation      │ rollup upsert    │
                        │  ┌──────┴───────┐            ┌──────▼───────┐          │
 Browser (Console) ─────┼─▶│  API         │───────────▶│  PostgreSQL  │          │
 React + AntD           │  │ (Fastify)    │  Prisma    │  (partitioned │          │
                        │  └──────────────┘            │   events)     │          │
                        │                               └──────────────┘          │
                        └────────────────────────────────────────────────────────┘
```

### Services

| Service | Package | Responsibility | Scaling |
|---|---|---|---|
| **gateway** | `apps/gateway` | VK auth, budget/rate pre-checks, provider proxying, streaming, usage extraction, event emission | Stateless, N replicas behind LB |
| **api** | `apps/api` | Auth, org CRUD, credentials vault, analytics queries, reports, exports, EE admin | Stateless, N replicas |
| **worker** | `apps/worker` | Event ingestion (Redis Stream → PG), rollups, budget counters, exports, scheduled reports, alerts, pricing sync, retention | 1..N (BullMQ concurrency + stream consumer groups) |
| **web** | `apps/web` | React console (static, served by nginx or `api` in dev) | CDN/static |

## 2. The Golden Path: A Gateway Request

```
1. POST /gw/anthropic/v1/messages   Authorization: Bearer tt_live_abc…
2. Gateway: SHA-256(key) → Redis cache lookup `vk:{hash}`
   miss → PG fetch → cache 60 s (invalidated by pub/sub on revoke)
   → resolved context {vkId, userId, projectId, teamId, workspaceId, scopes}
3. Pre-checks (all Redis, pipelined, ~1 ms):
   a. key/project/workspace status active
   b. rate limits (sliding window)                → 429
   c. [EE] budget counters for user/project/team/ws → 402 if HARD-exceeded
4. Credential resolution:
   CE: workspace default credential for provider
   EE: pool strategy (priority/weighted/RR) skipping unhealthy members
5. Proxy: swap auth header, inject stream usage options if needed,
   pipe request body upstream (undici), pipe response back unbuffered.
6. On response finish (or stream end / client abort):
   parse usage (adapter-specific) → price via in-memory catalog →
   XADD to Redis Stream `usage:events` (fire-and-forget)
   + INCRBYFLOAT budget counters (EE) so enforcement lag stays ≤ seconds.
7. Worker (consumer group): batch XREADGROUP → validate → INSERT events
   (COPY-style batch) → UPSERT hourly/daily rollups → XACK.
```

**Latency budget (target):** auth cache 0.3 ms + prechecks 1 ms + header rewrite 0.1 ms + event emit 0.2 ms (async) ⇒ < 3 ms typical added overhead; provider time dominates.

## 3. Key Architectural Decisions (ADRs, abridged)

| # | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| ADR-1 | **Separate gateway process** from control-plane API | Hot path isolation: an expensive analytics query must never slow proxying; independent scaling & deploys | Single app with route separation (shared event loop = shared fate) |
| ADR-2 | **Redis Streams** (not plain BullMQ queue) for usage events, BullMQ for jobs | Streams give consumer groups, replay, at-least-once with pending-entry recovery; BullMQ retained for scheduled/one-off jobs (exports, reports, emails) where its semantics shine | BullMQ-only (job-per-event too heavy at 500 RPS); Kafka (operational cost vs compose-first goal) |
| ADR-3 | **PostgreSQL for events with monthly partitions + rollup tables** | One database to operate; rollups make dashboards O(dimensions), not O(events); partitions make retention `DROP PARTITION` | ClickHouse/Timescale (better at huge scale but breaks "one compose, one DB" simplicity — kept as post-v1 optional sink) |
| ADR-4 | **At-least-once events + idempotent insert** (`ON CONFLICT (id) DO NOTHING`, UUIDv7 ids minted at gateway) | Duplicates from stream redelivery must not double-charge; rollup increments applied only for rows actually inserted (same txn) | Exactly-once (impossible), at-most-once (loses money data) |
| ADR-5 | **Cost computed at gateway, prices snapshotted on event** | Immutable history; catalog updates never rewrite past spend; worker re-verifies (`costBasis` flag on divergence) | Compute-at-read (slow, mutable history) |
| ADR-6 | **Provider adapters as pure modules** with a common interface (`buildUpstreamRequest`, `parseUsage`, `parseStreamUsage`, `mapError`) | New provider = one module + pricing entries + fixtures; core proxy code provider-agnostic | Per-provider route handlers (duplication) |
| ADR-7 | **Open-core via `ee/` directory** (Cal.com/GitLab model), single build, feature-gated by signed license | One codebase, one image, no forked builds; legal clarity (Apache-2.0 everywhere except `ee/`) | Separate EE repo (merge pain), feature flags without license (unenforceable) |
| ADR-8 | **JWT access + rotating refresh cookie** for console; PATs for automation; VKs only ever valid at gateway | Clear separation: console identity ≠ machine traffic; a leaked VK cannot read analytics or admin APIs | Session-only (poor for API), VK-as-universal-key (blast radius) |
| ADR-9 | **Budget enforcement on Redis counters, reconciled by worker** | Enforcement must be O(1) on hot path; small documented overshoot accepted vs adding PG to request path | Synchronous PG check (latency), no enforcement (product gap) |
| ADR-10 | **No prompt bodies stored** by default | Privacy/GDPR posture, storage cost, trust for self-hosters; metadata suffices for governance | Full logging (scope creep into observability) |

## 4. Data Flows

### 4.1 Ingestion & aggregation
```
Gateway ─XADD─▶ usage:events (Redis Stream, maxlen ~1M)
Worker consumer group "ingest" (N consumers):
  batch 500 or 200 ms →
  BEGIN
    INSERT INTO usage_event … ON CONFLICT DO NOTHING RETURNING id
    UPSERT usage_rollup_hourly / usage_rollup_daily (only inserted rows)
  COMMIT → XACK
Crash recovery: XAUTOCLAIM pending > 60 s.
Nightly: reconcile job (Σ raw vs rollups per day) + retention pruning.
```

### 4.2 Budget lifecycle (EE)
```
Worker maintains Redis: budget:{scopeType}:{scopeId}:{period} = spent
Gateway: pipelined GET on governing scopes → compare vs cached limits
Threshold crossings → BullMQ "notify" job → email/Slack
Rollover: cron per timezone → reset counters, unblock keys, audit entry
Reconciliation: hourly job recomputes counters from rollups (drift repair)
```

### 4.3 Cache & invalidation
| Cache | Store | TTL | Invalidation |
|---|---|---|---|
| VK → context | Redis hash + in-proc LRU (5 s) | 60 s | pub/sub `invalidate:vk:{hash}` on revoke/edit |
| Pricing catalog | in-proc, full load | 5 min poll | version key bump |
| Budget limits/status | Redis | none (authoritative-ish) | worker writes |
| Pool health | Redis | 10 s probe cycle | health-checker job |

## 5. Provider Adapter Layer

Common interface (in `packages/providers`):
```ts
interface ProviderAdapter {
  id: Provider;                       // ANTHROPIC | OPENAI | …
  buildUpstream(req, credential): UpstreamRequest;   // URL, headers, body passthrough or translate
  ensureUsageInStream(body): body;    // e.g. inject stream_options.include_usage (OpenAI)
  parseUsage(json): NormalizedUsage;  // non-streaming
  streamUsageExtractor(): TransformObserver; // taps SSE frames w/o buffering
  mapError(status, body): GatewayError;
  translateFromOpenAI?(body): body;   // for unified endpoint
  translateToOpenAI?(json|sse): json|sse;
}
```
Notes per provider:
- **Anthropic:** usage in `message_start`/`message_delta`; cache tokens (`cache_creation_input_tokens`, `cache_read_input_tokens`) mapped to cacheWrite/cacheRead.
- **OpenAI:** inject `stream_options: {include_usage: true}` when streaming; `reasoning_tokens` from `completion_tokens_details`.
- **Gemini:** `usageMetadata` on final chunk; path-based model in URL; API key via query/header.
- **OpenRouter:** passthrough OpenAI-compatible; prefer OpenRouter-reported cost when present (`costBasis=ACTUAL` from upstream).
- **DeepSeek / Minimax:** OpenAI-compatible surfaces, distinct auth + usage field quirks (Minimax `base_resp` error envelope).
- **Ollama:** no auth by default; usage from `prompt_eval_count`/`eval_count`; price $0 unless workspace override.

## 6. Multi-Tenancy & Security Model

- **Tenant boundary:** every table carries `workspaceId`; every Prisma query goes through a scoped client extension that injects `workspaceId` from request context (defense-in-depth against missing WHERE clauses).
- **Secrets:** provider credentials AES-256-GCM (key from `TOKENTRAIL_MASTER_KEY`, supports key rotation via key-id prefix). VKs hashed (SHA-256) — they are high-entropy random, so no slow hash needed.
- **AuthN surfaces:** Console = JWT (15 min) + refresh rotation; Automation = PAT (`ttp_…`, hashed); Gateway = VK. Three token classes, three prefixes, zero overlap.
- **AuthZ:** role matrix (SRS §2.10) enforced by route-level policy guards + query-level scope trimming for analytics.
- **Transport:** TLS terminates at the fronting proxy (Caddy/nginx in compose); service-to-service on the compose network.

## 7. Scalability Path

| Stage | Load | Topology |
|---|---|---|
| 1 | ≤ 50 RPS, ≤ 1M events/mo | Single compose host, 1× each service |
| 2 | ≤ 500 RPS | 2–4 gateway replicas, 2 workers, same PG with tuned pool; Redis persistent (AOF) |
| 3 | ≤ 5k RPS | Gateway on separate hosts/K8s (Helm chart, post-v1), PG read replica for analytics, partition pruning + `pg_partman` |
| 4 | beyond | Optional ClickHouse sink for events (worker dual-writes), PG remains system of record for org/config |

Stateless services scale horizontally; the only stateful components are PostgreSQL and Redis, both standard to operate.

## 8. Observability

- **Metrics (Prometheus):** gateway: request count/latency histograms by provider/status, event-emit failures, cache hit ratio, budget blocks; worker: stream lag, batch size, rollup latency; api: route latencies.
- **Logs:** pino JSON, request-id correlation from gateway → worker (event carries requestId).
- **Tracing:** optional OTLP exporter; gateway creates a span per proxy with provider timing.
- **Health:** `/healthz` (liveness), `/readyz` (deps: PG for api/worker, Redis for gateway — PG deliberately *not* in gateway readiness, per fail-open design).

## 9. Failure Modes & Behavior

| Failure | Gateway behavior | Data behavior |
|---|---|---|
| Redis down | FAIL_OPEN: proxy continues, VK auth falls back to direct PG with in-proc cache; events buffered in local ring then dropped w/ loss metric. FAIL_CLOSED: 503 | possible bounded loss (counted) |
| Postgres down | proxying unaffected (Redis-cached auth); control plane degraded | events accumulate in Redis Stream (maxlen bound); replay on recovery |
| Worker down | none | stream backlog grows; alerts at lag threshold |
| Provider down | error passthrough; EE pools fail over | events recorded with `PROVIDER_ERROR` |
| License expired | EE gates off; CE proxying continues | EE config retained read-only |
