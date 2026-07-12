# TokenTrail — Backend Architecture

**Stack:** Node 22 LTS · TypeScript strict · Fastify 5 · Prisma 6 · PostgreSQL 16 · Redis 7 · BullMQ 5 · undici · zod · pino

---

## 1. Service Anatomy (shared skeleton)

Every service (`gateway`, `api`, `worker`) boots the same way:

```
config.ts   zod-parse process.env → typed frozen Config (fail fast on bad env)
telemetry   pino logger + prometheus registry + optional OTel
main.ts     build deps → start → graceful shutdown (SIGTERM: stop intake,
            drain in-flight ≤ 30 s, close pools)
```

## 2. Control-Plane API (`apps/api`)

### Module pattern
Each feature is a Fastify plugin folder: `routes.ts` (HTTP + zod schemas) → `service.ts` (business logic, transactional) → uses `packages/db` scoped client. Routes never touch Prisma directly; services never touch HTTP.

```
request lifecycle:
  onRequest   requestId, logger child
  auth plugin JWT verify (or PAT hash lookup) → req.user
  ws-context  resolve {ws} param → membership check → req.ctx = {workspaceId, role, db: scopedClient(ws)}
  rbac guard  route-declared minimum role / entitlement → 403 / 402
  handler     zod-validated body/query → service call → serialized reply
  onError     → problem+json (zod issues → 400 errors[], Prisma known codes mapped)
```

### Notable services
- **AuthService** — argon2id, JWT (15 min access / 30 d rotating refresh with reuse detection: refresh token family revoked on replay), invitation tokens (random + hash).
- **CredentialService** — AES-256-GCM envelope (`keyId‖iv‖ciphertext‖tag`); `test()` fans out to provider adapter's cheapest probe; publishes `invalidate:cred` on change.
- **VirtualKeyService** — mints `tt_live_` + 24 base62 chars (crypto random), stores SHA-256, returns plaintext once; revoke → PG update + `PUBLISH invalidate:vk:{hash}`.
- **AnalyticsService** — builds SQL over rollup tables only (see §5); enforces RBAC trimming by injecting scope predicates (allowed project/team ids) before grouping.
- **ExportService / ReportService** — ≤ 10k rows inline; else enqueue BullMQ `export-csv` and return job handle.
- **EE loader** — at boot, if license valid: registers `ee/api` plugins (pools, enforcement config, scheduled reports, SSO, Slack, audit, branding) and swaps the no-op `AuditSink` for the real hash-chained writer. Every ADMIN mutation calls `audit.record(action, resource, diff)` — a no-op in CE, persisted in EE.

## 3. Gateway (`apps/gateway`)

Design constraints: no Prisma on the hot path (raw `pg` pool for cache-miss lookups), no JSON parse of large bodies unless translation requires it, zero buffering of streams.

```
┌─ onRequest: requestId, start hrtime
├─ resolveKey(hash)          in-proc LRU(5s) → Redis → PG(one point read) → cache
├─ prechecks (Redis pipeline): status ▸ rate limit ▸ [EE] budget counters
├─ pickCredential:  CE default cred │ EE pool strategy (Redis health map)
├─ adapter.buildUpstream:    URL join, auth header swap, stream-usage injection
├─ undici.request:           pipe req body ▸ pipe resp body (backpressure-aware)
│    └─ SSE tap (Transform): pass bytes through untouched; incrementally scan
│       frame boundaries for usage payloads (adapter-provided matcher)
└─ finish/abort hook:        normalize usage → price (in-proc catalog) →
                             XADD usage:events  +  INCRBYFLOAT budget counters (EE)
                             update key lastUsed (throttled, 1/min per key)
```

- **Client abort mid-stream:** upstream socket destroyed; usage extracted from frames seen so far, `costBasis=ESTIMATED` if the terminal usage frame never arrived.
- **Unified endpoint:** `translateFromOpenAI` builds provider-native body; response translated back (non-stream: JSON map; stream: frame-by-frame SSE re-encoder). Passthrough routes skip translation entirely.
- **Fail-open machinery:** Redis ops wrapped with 50 ms timeout + circuit breaker; on open circuit, auth falls back to PG + in-proc cache, events go to a bounded in-memory ring (flushed when Redis recovers; overflow counted in `tokentrail_events_dropped_total`).

## 4. Worker (`apps/worker`)

Two consumption models, deliberately:

| Mechanism | Used for | Why |
|---|---|---|
| **Redis Streams consumer group** (`usage:events`, group `ingest`) | usage-event ingestion | high-throughput batching, replay, pending-claim recovery |
| **BullMQ queues** | `export-csv`, `notify` (email/Slack), `scheduled-report`, `pricing-sync`, `retention`, `reconcile`, `budget-rollover`, `pool-health` | scheduling (cron/repeatable), retries with backoff, per-queue concurrency |

### Ingest pipeline
```
loop: XREADGROUP COUNT 500 BLOCK 200
  → zod-validate each (invalid → dead-letter stream usage:dlq + metric)
  → single txn: batch INSERT (ON CONFLICT DO NOTHING RETURNING id)
                + rollup UPSERTs (hourly & daily) for inserted rows only
                + t-digest merge for latency sketch
  → XACK; every 60 s XAUTOCLAIM stale pending (crashed sibling recovery)
backpressure: if txn latency > 500 ms, halve batch size (adaptive)
```

### Scheduled jobs (BullMQ repeatables)
| Job | Cadence | Function |
|---|---|---|
| `budget-refresh` | 1 min | recompute spent-counters for active budget scopes from hourly rollups → Redis; evaluate thresholds → enqueue `notify` (deduped via budget_notification) |
| `budget-rollover` | per-timezone midnights | reset period counters, unblock, audit entry |
| `pool-health` (EE) | 10 s | probe degraded members (half-open), tiny canary for healthy ones; publish health map |
| `pricing-sync` | daily | fetch signed pricing bundle (if enabled) → new `model_price` rows with `effectiveFrom` |
| `retention` | daily | create next month's partitions; drop expired event partitions; purge expired export files |
| `reconcile` | hourly/daily | Σ raw vs rollup consistency check (repair + alert on drift); budget counter drift repair |
| `scheduled-report` (EE) | per cron | run saved report → CSV/PDF (headless render) → email/Slack |

## 5. Analytics Query Layer

Rollup tables are the only analytics source (raw events only for the event explorer, ≤ 90 d, cursor-paginated by `(occurred_at, id)`).

```sql
-- breakdown by team, month-to-date
SELECT team_id, SUM(cost_usd) cost, SUM(requests) requests,
       SUM(input_tokens+output_tokens) tokens,
       SUM(errors)::float / NULLIF(SUM(requests),0) error_rate
FROM usage_rollup_daily
WHERE workspace_id = $1 AND bucket >= $2 AND bucket < $3
  AND project_id = ANY($4)          -- RBAC trim, only when caller is scoped
GROUP BY team_id ORDER BY cost DESC;
```
Granularity picker: `hour` → hourly table (range ≤ 14 d), else daily table with `date_trunc` for week/month. p95 latency via t-digest merge function (`packages/telemetry` provides the codec).

## 6. Cross-Cutting Concerns

- **Transactions:** service methods that mutate multiple rows use `db.$transaction` with explicit isolation; ingestion uses plain `pg` for COPY-speed batches.
- **Idempotency:** `Idempotency-Key` → Redis SETNX(key→response hash, 24 h); duplicate POST replays stored response.
- **Rate limiting (control plane):** `@fastify/rate-limit` on auth endpoints (brute-force guard).
- **Clock:** all business logic takes `now: Date` injected — deterministic tests for periods/rollovers.
- **Error taxonomy (`packages/shared/errors`):** `DomainError(code, httpStatus)` subclasses (`NotFound`, `Forbidden`, `LicenseRequired`, `BudgetExceeded`, `ValidationFailed`) — single onError mapper per app.
- **Config surface (excerpt):** `DATABASE_URL`, `REDIS_URL`, `TOKENTRAIL_MASTER_KEY` (32 B base64), `JWT_SECRET`, `PUBLIC_BASE_URL`, `SMTP_URL`, `GATEWAY_FAILURE_POLICY`, `EVENT_RETENTION_DAYS`, `LICENSE_KEY?`.

## 7. Security Posture

| Concern | Control |
|---|---|
| Provider secrets | AES-256-GCM at rest, key-id envelopes for rotation; decrypt only in gateway/credential-test paths; never logged (pino redact paths) |
| VK/PAT/invite tokens | high-entropy random, SHA-256 stored, constant-time compare |
| Passwords | argon2id (m=64 MiB, t=3, p=4) |
| JWT | HS256 (single-instance) with 15-min TTL; refresh rotation + family reuse detection |
| SSRF (Ollama/base URLs) | admin-set base URLs validated (scheme allowlist, no link-local/metadata IPs unless `ALLOW_PRIVATE_UPSTREAMS=true` — default true for self-host, documented) |
| Injection | Prisma parameterization; analytics SQL built from enum-checked identifiers only |
| Headers | @fastify/helmet on api/web; strict CORS (console origin only); gateway CORS open by config (SDKs are server-side; browser use opt-in) |
| Audit (EE) | hash-chained append-only rows; secrets redacted from diffs |
| Supply chain | lockfile, provenance builds, `npm audit` gate, distroless non-root images |

## 8. Testing Strategy

| Layer | Approach |
|---|---|
| `packages/providers` | pure unit tests against recorded fixtures (JSON + SSE transcripts per provider, incl. abort/malformed cases) |
| `packages/pricing` | table-driven: model matching precedence, validity windows, override wins, UNPRICED fallback |
| gateway | integration vs `scripts/mock-provider` (configurable latency/errors/stream shapes); asserts passthrough byte-equality, usage extraction, event emission |
| worker | testcontainers (PG+Redis): property test `Σ events == rollups`, duplicate-delivery idempotency, pending-claim recovery |
| api | supertest route suites: RBAC matrix walk, tenancy isolation (workspace A token vs B resources → 404), license gating |
| e2e | compose stack + Playwright golden paths; k6 load profile for NFR-1/2 in nightly CI |
