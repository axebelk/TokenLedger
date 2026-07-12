# TokenTrail — Development Roadmap

**Team assumption:** 3–4 engineers (1 platform/backend-heavy, 1 backend, 1 frontend, 1 full-stack/DevX). Phases are sequential milestones; each ends in a tagged, demoable release.

---

## Phase 0 — Foundations (Weeks 1–2)
**Goal:** empty-but-running skeleton with CI, so every later PR lands on rails.

- Monorepo scaffold (pnpm + turbo + tsconfig refs + eslint boundaries), `packages/{shared,config,telemetry,db}` stubs.
- Prisma schema v1 (identity/org/credentials/keys tables), migrations, seed script.
- `docker-compose.dev.yml` (pg/redis/mailpit); CI: lint → typecheck → test → build → images.
- Fastify service skeletons (api/gateway/worker) with health, metrics, problem+json, graceful shutdown.
- ADR log started; CONTRIBUTING.md, code of conduct, DCO.

**Exit:** `pnpm dev` boots all services green; CI publishes images from `main`.

## Phase 1 — Gateway MVP: the sensor (Weeks 3–6)
**Goal:** requests flow through TokenTrail and become priced usage events. *Anthropic + OpenAI + Ollama first* (covers the three auth/usage archetypes).

- Auth: register/login/JWT/refresh; workspace bootstrap; invitations (email via mailpit).
- Credentials vault (AES-GCM), test-connection; virtual keys (issue/reveal-once/revoke + pub/sub invalidation).
- Gateway: native passthrough for Anthropic/OpenAI/Ollama; SSE streaming with usage tap; abort handling.
- Pricing package: catalog seed, matcher, calculator, snapshot-on-event.
- Redis Stream emission → worker ingest → `usage_event` (partitioned) + hourly/daily rollups; reconcile job.
- Minimal console: onboarding wizard, key management, raw event list ("waiting for first request" moment).

**Exit criteria:** J1 journey < 15 min; streaming cost matches provider dashboards ±2% in a week-long soak; duplicate-delivery property test green.

## Phase 2 — Analytics & Org Structure (Weeks 7–10)
**Goal:** the dashboard a manager screenshots into a slide deck.

- Teams, projects (+archive), project members, RBAC matrix enforcement + tests.
- Analytics API (summary/timeseries/breakdown/leaderboard) on rollups with RBAC trimming.
- Dashboard (stat cards, stacked spend timeseries, provider donut, top projects/users), analytics explorer with URL-state filters.
- Remaining providers: **Gemini, OpenRouter, DeepSeek, Minimax** adapters + fixtures + pricing entries.
- Unified OpenAI-compatible endpoint with translation (Anthropic + Gemini translators first).
- Raw usage explorer (virtualized) + event detail.

**Exit:** all 7 providers pass the adapter conformance suite; dashboard p95 < 500 ms on 10M-event dataset.

## Phase 3 — Governance CE + Launch Prep (Weeks 11–14)
**Goal:** community feature-complete → **v1.0 public launch**.

- Budgets (ALERT mode): CRUD, live status, email threshold alerts (deduped), dashboard widget.
- Reports: report builder, CSV export (sync + async jobs + signed downloads), export history.
- Rate limiting (per-key/workspace), fail-open/fail-closed machinery + chaos drill, gateway load test vs NFR-1/2.
- Pricing overrides UI + unpriced-model surfacing; PATs; `/meta/version`.
- Docs site (install, per-SDK gateway snippets, API reference from OpenAPI), demo instance, launch blog + Show HN.

**Exit:** GA checklist (PRD §9) green. **🚀 v1.0 (Community GA).**

## Phase 4 — Enterprise Core (Weeks 15–20)
**Goal:** first paying customers. Ship `ee/` behind license keys.

- Licensing (Ed25519 offline verify, entitlement gates, graceful expiry).
- **Budget enforcement** (Redis counters, gateway 402, SOFT grace, rollover, reconciliation) — flagship EE feature.
- **Provider pools** (strategies, health checks, failover, cooldown/half-open) + pool observability UI.
- **Audit logs** (hash-chained, viewer, export) wired into every ADMIN mutation.
- **SSO**: OIDC first, SAML second; enforced-SSO mode; JIT provisioning.

**Exit:** overshoot bound verified under 100 RPS burn test; failover drill < 5 s traffic disruption; **v1.1 (Enterprise launch)**.

## Phase 5 — Enterprise Comfort & Scale (Weeks 21–26)
- **Slack integration** (alerts, digests) and **scheduled reports** (cron, CSV/PDF, email/Slack).
- **White labeling** (branding → AntD tokens + email templates).
- Anomaly detection alerts (spend spikes); webhooks.
- Scale work: `pg_partman`, PG read-replica support for analytics, k6 regression suite in nightly CI, Helm chart (K8s).
- SCIM-lite deprovisioning.

**Exit:** **v1.2**; reference deployment at 1k RPS documented.

## Phase 6 — Ecosystem (Months 7–12, thematic)
- More providers (Bedrock, Azure OpenAI, Vertex, Mistral, Groq) via community adapter SDK + conformance kit.
- Optional ClickHouse event sink for very high volume; Grafana dashboard pack.
- Cost allocation exports to FinOps tooling (FOCUS format), Terraform provider for config-as-code.
- Embeddings/image/audio pricing units (per-image, per-second) beyond token pricing.
- Public roadmap voting; plugin hooks for custom prechecks (e.g., PII redaction gateways).

---

## Cross-cutting workstreams (continuous)
| Stream | Cadence |
|---|---|
| Pricing catalog updates | weekly review; signed bundle release |
| Security | dependency audit each release; external pentest before v1.1; responsible-disclosure policy at v1.0 |
| Community | issue triage SLA 48 h; monthly release train; good-first-issues curated from Phase 2 onward |
| Docs | every feature PR ships docs or fails review |

## Top risks & mitigations
1. **Provider API drift** (usage fields/SSE shapes change) → adapter conformance suite runs nightly against live providers with canary keys; adapters versioned independently.
2. **Cost accuracy trust** — the product is dead if numbers are doubted → snapshot pricing, reconcile jobs, ±2% invoice validation program with design partners.
3. **Gateway in the critical path** — fail-open default, chaos drills in CI, "bypass mode" documented escape hatch (point SDK back at provider) keeps adoption risk low.
4. **Open-core boundary disputes** → the rule is written down: *individual/team visibility = CE; organizational control & compliance = EE*; applied in PR review via `ee/` placement.
5. **Scope creep into observability** (prompt logging, evals) → PRD non-goals enforced; integrate with Langfuse/Helicone rather than rebuild.
```
