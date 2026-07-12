# TokenTrail — Software Requirements Specification (SRS)

**Version:** 1.0 · Follows IEEE 830 structure, adapted.

---

## 1. Introduction

### 1.1 Purpose
Defines functional and non-functional requirements for TokenTrail v1.0: an AI cost-governance and usage-analytics platform consisting of a control-plane API, a data-plane gateway, background workers, and a web console.

### 1.2 Scope
In scope: multi-tenant workspaces, org modeling (teams/projects/users), provider credential vault, AI request proxying for 7 providers, usage metering, cost computation, analytics, reporting, exports, and the enterprise feature set (pools, budget enforcement, scheduled reports, SSO, Slack, audit logs, white labeling).
Out of scope: prompt content analytics, model quality evaluation, training/fine-tuning cost.

### 1.3 Definitions
| Term | Meaning |
|---|---|
| **Workspace** | Tenant root. All data is workspace-scoped. |
| **Virtual Key (VK)** | TokenTrail-issued API key (`tt_live_…`) used by developers against the gateway. Maps to user + project + allowed providers/models. |
| **Provider Credential** | A real upstream API key (encrypted at rest), owned by a workspace. |
| **Provider Pool (EE)** | Ordered/weighted set of credentials for one provider with failover. |
| **Usage Event** | Immutable per-request record: tokens, model, cost, latency, attribution. |
| **Rollup** | Pre-aggregated hourly/daily usage per dimension tuple. |
| **Budget** | Spend limit on a scope (workspace/team/project/user) per period. |

### 1.4 System context
```
Developer SDK ──(VK)──▶ Gateway ──(real key)──▶ AI Provider
                          │ usage events (queue)
                          ▼
                   Worker ──▶ PostgreSQL (events + rollups)
Console (React) ──▶ Control-plane API ──▶ PostgreSQL / Redis
```

## 2. Functional Requirements

Notation: `FR-<area>-<n>`. Priority: **M**ust / **S**hould / **C**ould. Edition: CE / EE.

### 2.1 Authentication & Users (AUTH)
- **FR-AUTH-1 (M, CE)** Email+password signup/login; passwords hashed with argon2id; session via short-lived JWT access token (15 min) + rotating refresh token (httpOnly cookie).
- **FR-AUTH-2 (M, CE)** Invitation flow: admin invites by email with role; invite token expires in 7 days; accepting creates/links the user.
- **FR-AUTH-3 (M, CE)** Workspace roles: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`. Role matrix in §2.10.
- **FR-AUTH-4 (M, CE)** Users may belong to multiple workspaces; every API call carries a workspace context.
- **FR-AUTH-5 (S, CE)** Personal access tokens (PATs) for the admin REST API, scoped and revocable.
- **FR-AUTH-6 (M, EE)** OIDC login (authorization-code + PKCE) and SAML 2.0 SP-initiated SSO; JIT user provisioning with default role; optional "SSO required" enforcement per workspace.
- **FR-AUTH-7 (S, EE)** SCIM-lite: deactivate user on IdP deprovision webhook.

### 2.2 Workspace / Team / Project (ORG)
- **FR-ORG-1 (M, CE)** CRUD workspaces; first user becomes `OWNER`; soft-delete with 30-day retention.
- **FR-ORG-2 (M, CE)** CRUD teams within a workspace; team roles `LEAD`, `MEMBER`; a user may join many teams.
- **FR-ORG-3 (M, CE)** CRUD projects; a project belongs to a workspace and optionally to one owning team; projects have slug, description, tags, status (`ACTIVE`/`ARCHIVED`).
- **FR-ORG-4 (M, CE)** Archiving a project revokes its virtual keys and hides it from default views; historical usage remains reportable.
- **FR-ORG-5 (S, CE)** Project membership defaults to owning-team members; additional users may be granted access explicitly.

### 2.3 Provider Credentials (PROV)
- **FR-PROV-1 (M, CE)** Register credentials for providers: `ANTHROPIC`, `OPENAI`, `GEMINI`, `MINIMAX`, `OPENROUTER`, `DEEPSEEK`, `OLLAMA` (Ollama credential = base URL, no secret required).
- **FR-PROV-2 (M, CE)** Secrets encrypted at rest with AES-256-GCM using a key derived from `TOKENTRAIL_MASTER_KEY`; plaintext never returned by any API (last-4 display only).
- **FR-PROV-3 (M, CE)** "Test connection" action validates a credential against the provider (cheap list-models or 1-token call).
- **FR-PROV-4 (M, EE)** Provider Pools: ordered members with weight, strategy (`PRIORITY`, `ROUND_ROBIN`, `WEIGHTED`), per-member RPM/TPM caps, health status; automatic failover on 401/429/5xx per policy; cooldown + half-open recovery probes.
- **FR-PROV-5 (S, CE)** Per-credential model allowlist/denylist.

### 2.4 Virtual Keys (KEY)
- **FR-KEY-1 (M, CE)** Issue VKs bound to (user, project); optional expiry; optional provider/model allowlist; optional per-key RPM limit.
- **FR-KEY-2 (M, CE)** VK format `tt_live_<24-char base62>`; only SHA-256 hash stored; full key shown once at creation.
- **FR-KEY-3 (M, CE)** Revoke immediately (gateway cache invalidated ≤ 5 s via Redis pub/sub).
- **FR-KEY-4 (S, CE)** Last-used timestamp and per-key usage visible to key owner and admins.

### 2.5 Gateway (GW)
- **FR-GW-1 (M, CE)** Native passthrough routes: `POST /gw/{provider}/…` mirrors each provider's API surface (e.g., `/gw/anthropic/v1/messages`, `/gw/openai/v1/chat/completions`, `/gw/gemini/v1beta/models/{model}:generateContent`). Request/response bodies pass through unmodified except auth headers.
- **FR-GW-2 (M, CE)** Unified OpenAI-compatible route: `POST /gw/v1/chat/completions` with model prefix routing (`anthropic/claude-sonnet-5`, `deepseek/deepseek-chat`); gateway translates request/response formats.
- **FR-GW-3 (M, CE)** Auth: `Authorization: Bearer tt_…` (also accepts `x-api-key` for Anthropic SDK compatibility). Invalid/revoked/expired ⇒ `401`.
- **FR-GW-4 (M, CE)** SSE and chunked streaming pass through with zero buffering; usage extracted from terminal SSE events (e.g., Anthropic `message_delta.usage`, OpenAI `stream_options.include_usage` injected automatically).
- **FR-GW-5 (M, CE)** For providers that omit usage in stream responses, gateway falls back to local tokenization estimates and flags the event `costBasis=ESTIMATED`.
- **FR-GW-6 (M, CE)** Every request produces a Usage Event (§2.6) published to BullMQ; queue publish is fire-and-forget off the response path.
- **FR-GW-7 (M, CE)** Attribution headers (optional overrides, validated against VK scope): `x-tokentrail-project`, `x-tokentrail-tags`.
- **FR-GW-8 (M, CE)** Failure policy configurable per workspace: `FAIL_CLOSED` (metering DB down ⇒ still proxy, buffer events in Redis; Redis down ⇒ 503) vs `FAIL_OPEN` (always proxy; drop events as last resort, increment loss counter).
- **FR-GW-9 (M, EE)** Budget enforcement pre-check: if any governing budget is exhausted with `enforcement=HARD`, respond `402 {"error":{"type":"budget_exceeded",…}}` without contacting the provider.
- **FR-GW-10 (S, CE)** Per-key and per-workspace rate limiting (sliding window in Redis) ⇒ `429` with `retry-after`.
- **FR-GW-11 (M, CE)** Request ID (`x-tokentrail-request-id`) returned on every response; provider errors passed through verbatim with provider status code.

### 2.6 Usage Metering (USE)
- **FR-USE-1 (M, CE)** Usage Event fields: id (UUIDv7), timestamp, workspaceId, projectId, teamId (denormalized from project at event time), userId, virtualKeyId, provider, credentialId, model (raw + normalized), endpoint, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, latencyMs, timeToFirstTokenMs (streams), status (`OK`/`PROVIDER_ERROR`/`BLOCKED_BUDGET`/`BLOCKED_RATELIMIT`/`AUTH_ERROR`), httpStatus, streamed flag, costBasis (`ACTUAL`/`ESTIMATED`/`OVERRIDDEN`), unit prices snapshot, costUsd (decimal 12,6), tags.
- **FR-USE-2 (M, CE)** Events are immutable; corrections happen via compensating adjustment events (`kind=ADJUSTMENT`).
- **FR-USE-3 (M, CE)** Worker persists events in batches (≤ 500/insert) and increments hourly + daily rollups transactionally.
- **FR-USE-4 (M, CE)** Rollup dimensions: (workspace, day/hour, project, team, user, provider, model) with additive measures: requests, errors, tokens by class, costUsd, latency sum/count, p95 via t-digest sketch column.
- **FR-USE-5 (S, CE)** Retention: raw events 90 days default (configurable), rollups indefinite. Nightly job prunes and verifies rollup/raw consistency.

### 2.7 Cost Engine (COST)
- **FR-COST-1 (M, CE)** Pricing catalog: per (provider, model-pattern) prices in USD per 1M tokens for input/output/cacheRead/cacheWrite, with `effectiveFrom`/`effectiveTo` validity windows; seeded and updatable via signed JSON bundle or admin UI.
- **FR-COST-2 (M, CE)** Model matching: exact id, then prefix pattern (`claude-sonnet-5*`), else `UNPRICED` (cost 0 + flagged on dashboard for admin action).
- **FR-COST-3 (M, CE)** Workspace price overrides (negotiated rates, internal Ollama rates) take precedence over catalog.
- **FR-COST-4 (M, CE)** Cost computed at event time; unit prices snapshotted onto the event so later catalog changes never mutate history.
- **FR-COST-5 (S, CE)** Currency: store USD; display currency conversion (static configurable rate) is presentation-only.

### 2.8 Analytics, Dashboard, Reports, Export (RPT)
- **FR-RPT-1 (M, CE)** Dashboard widgets: total spend (period vs previous), spend timeseries, spend by provider / model / team / project / top users, request volume, error rate, avg & p95 latency, unpriced-model warnings, budget status list.
- **FR-RPT-2 (M, CE)** All analytics queries hit rollups (never raw events) for ranges > 48 h; ≤ 48 h may hit raw for live view.
- **FR-RPT-3 (M, CE)** Filters: date range, granularity (hour/day/week/month), and any dimension; group-by any single dimension; RBAC-trimmed (a member sees own teams/projects unless Viewer+ of workspace analytics — see role matrix).
- **FR-RPT-4 (M, CE)** CSV export of any report: synchronous ≤ 10k rows; async BullMQ job with signed download URL (24 h expiry) beyond.
- **FR-RPT-5 (M, EE)** Scheduled reports: cron expression, recipients (emails / Slack channel), format (CSV/PDF), saved-report template; timezone-aware.
- **FR-RPT-6 (S, EE)** Anomaly alert: day-over-day spend spike > configurable % on any scope triggers alert channel.

### 2.9 Budgets (BUD)
- **FR-BUD-1 (M, CE)** Budgets on scope (WORKSPACE|TEAM|PROJECT|USER) × period (DAILY|WEEKLY|MONTHLY|QUARTERLY), amount USD, alert thresholds (default 50/80/100%), notification channels (email CE; Slack EE).
- **FR-BUD-2 (M, CE)** Community edition: alerting only (`enforcement=ALERT`).
- **FR-BUD-3 (M, EE)** Enforcement modes: `ALERT`, `SOFT` (grace % overrun then block), `HARD` (block at 100%). Enforcement decision at gateway using Redis-maintained running counters (eventually-consistent, ≤ 5 s lag; documented overshoot bound = lag × burn rate).
- **FR-BUD-4 (M, EE)** Period rollover resets counters at scope timezone midnight; blocked keys auto-unblock on rollover or budget raise.

### 2.10 Authorization matrix (summary)
| Action | OWNER | ADMIN | MEMBER | VIEWER |
|---|---|---|---|---|
| Manage workspace/billing/license | ✅ | ❌ | ❌ | ❌ |
| Manage users, teams, projects, providers, budgets | ✅ | ✅ | ❌ | ❌ |
| Issue own VK on permitted projects | ✅ | ✅ | ✅ | ❌ |
| View workspace-wide analytics | ✅ | ✅ | config-flag | ✅ |
| View own/team analytics | ✅ | ✅ | ✅ | ✅ |
| Export CSV | ✅ | ✅ | ✅ (own scope) | ✅ |
| View audit logs (EE) | ✅ | ✅ | ❌ | ❌ |

### 2.11 Audit Logs (AUD, EE)
- **FR-AUD-1 (M)** Append-only record of every mutating admin action: actor, action, resource type/id, before/after diff (secrets redacted), IP, user agent, timestamp.
- **FR-AUD-2 (M)** Search/filter by actor, action, resource, date; CSV export; API access.
- **FR-AUD-3 (S)** Retention policy configurable (default 400 days); hash-chained rows for tamper evidence.

### 2.12 Integrations (INT)
- **FR-INT-1 (M, EE)** Slack: workspace-level OAuth install; route budget alerts, anomaly alerts, scheduled digests to chosen channels.
- **FR-INT-2 (S, CE)** SMTP email (invites, alerts, exports) — required infra dependency, configurable.
- **FR-INT-3 (C, CE)** Outbound webhooks for `budget.threshold`, `key.revoked`, `report.completed` events (HMAC-signed).

### 2.13 White Labeling (WL, EE)
- **FR-WL-1 (S)** Custom logo, favicon, primary/secondary colors, product name; applied to console + emails.
- **FR-WL-2 (C)** Custom domain guidance (reverse-proxy level) + configurable public base URL.

### 2.14 Licensing (LIC)
- **FR-LIC-1 (M)** EE features gated by a signed license key (Ed25519, offline verification): plan, seat count, expiry. Absent/expired license ⇒ EE features disabled, CE unaffected, EE data retained read-only.

## 3. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Performance | Gateway added latency p50 < 3 ms, p99 < 10 ms (non-streaming, warm cache); TTFB overhead for streams < 15 ms |
| NFR-2 | Throughput | 500 RPS/gateway replica on 2 vCPU; linear horizontal scaling (stateless) |
| NFR-3 | Availability | Gateway 99.9% self-hosted reference; control-plane outage must not stop proxying (fail-open per FR-GW-8) |
| NFR-4 | Durability | ≤ 0.01% usage-event loss under normal operation; Redis Stream buffer absorbs 15 min of worker downtime |
| NFR-5 | Security | Argon2id passwords; AES-256-GCM secrets; VKs stored hashed; TLS termination at proxy; OWASP ASVS L2 |
| NFR-6 | Privacy | No prompt/response bodies persisted by default; PII limited to name/email; GDPR delete = user anonymization preserving aggregates |
| NFR-7 | Auditability | All admin mutations audit-logged (EE); event immutability (append-only + adjustments) |
| NFR-8 | Scalability | 10M usage events/month on reference deployment (4 vCPU DB); monthly partitioning of event table |
| NFR-9 | Portability | Single `docker compose up`; amd64+arm64 images; Postgres 16+, Redis 7+, Node 22 LTS |
| NFR-10 | Observability | Structured JSON logs (pino), Prometheus `/metrics` on every service, health/readiness endpoints, OpenTelemetry traces (optional exporter) |
| NFR-11 | Accuracy | Cost within ±2% of provider invoice for `ACTUAL` cost-basis traffic (measured monthly) |
| NFR-12 | i18n | Console strings externalized; en-US at GA |
| NFR-13 | Compatibility | Works unmodified with official Anthropic/OpenAI/Google SDKs via base-URL override |
| NFR-14 | Upgradability | Prisma migrations forward-only; zero-downtime deploys for gateway (drain + rolling) |

## 4. External Interface Requirements
- **Console → API:** REST/JSON over HTTPS, OpenAPI 3.1 contract (doc 08), cursor pagination, RFC 9457 problem+json errors.
- **Developer → Gateway:** provider-native HTTP surfaces + unified OpenAI-compatible surface (§2.5).
- **API → Providers:** outbound HTTPS; per-provider adapter normalizes auth header, usage parsing, error mapping.
- **Email:** SMTP. **Slack:** OAuth v2 + Web API (EE). **IdP:** OIDC/SAML (EE).

## 5. Acceptance Test Themes (traceability)
1. VK lifecycle: issue → use → revoke → 401 within 5 s (FR-KEY-1..3, FR-GW-3).
2. Streaming cost accuracy vs provider dashboard across all 7 providers (FR-GW-4/5, NFR-11).
3. Rollup = Σ raw events property test (FR-USE-3/4).
4. Budget hard-block overshoot ≤ documented bound under 100 RPS burn (FR-BUD-3).
5. Fail-open drill: kill Postgres, traffic continues, events replay from Redis on recovery (FR-GW-8, NFR-4).
6. RBAC matrix walk (FR-ORG-*, §2.10).
7. License expiry flips EE off without CE disruption (FR-LIC-1).
