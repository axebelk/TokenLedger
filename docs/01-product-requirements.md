# TokenTrail — Product Requirements Document (PRD)

**Version:** 1.0 · **Status:** Draft for review · **Owner:** Product/Architecture · **License model:** Open-core (Apache-2.0 community + commercial `ee/`)

---

## 1. Product Vision

TokenTrail is the open-source control plane for AI spend. Every AI request an organization makes flows through the TokenTrail Gateway, which attributes it to a **user**, **project**, **team**, and **workspace**, prices it against a versioned model-pricing catalog, and turns it into governance data: dashboards, budgets, alerts, and reports.

> **One-line pitch:** "Point your AI SDKs at TokenTrail instead of the provider, and you instantly know who is spending what, where, and why."

### Why now
- AI spend is the fastest-growing, least-attributed line item in engineering budgets.
- Provider dashboards show *aggregate* spend per API key — they cannot answer "which team?", "which project?", "which developer?".
- Existing proxies (LiteLLM, Helicone, OpenRouter) solve routing or observability; none is a governance-first, self-hostable, org-structured platform.

### Product principles
1. **Attribution is the atom.** Every token is attributed to user × project × team × provider × model. No anonymous spend.
2. **Zero-friction adoption.** Change a base URL and an API key; no SDK, no code changes.
3. **Self-hosted first.** One `docker compose up`. Your keys and usage data never leave your infrastructure.
4. **Open core, honest split.** Everything an individual team needs to see and control spend is free forever. Org-scale controls (SSO, budget enforcement pools, audit, white-label) are enterprise.
5. **Never in the blast radius.** The gateway must not break AI traffic: streaming passthrough, fail-open option, sub-10 ms added latency budget.

## 2. Target Users & Personas

| Persona | Role | Core question | Primary surface |
|---|---|---|---|
| **CTO / VP Eng** | Buyer, exec sponsor | "What is AI costing us and is it worth it?" | Executive dashboard, monthly reports |
| **Engineering Manager** | Daily operator | "Which of my teams/projects are burning budget?" | Team/project dashboards, budgets, alerts |
| **Platform / DevOps Engineer** | Installer, admin | "How do I deploy, connect providers, and issue keys safely?" | Admin console, provider config, gateway |
| **Developer** | End user of gateway | "Give me a key that works with every provider and stays out of my way." | Virtual keys, personal usage page |
| **Finance / FinOps** | Consumer of reports | "Give me cost per team/project for chargeback." | CSV export, scheduled reports |

## 3. Problems Solved

1. **No attribution:** Provider consoles report per-API-key spend; organizations share keys, so spend is unattributable.
2. **Key sprawl & leakage:** Raw provider keys are pasted into repos and laptops. TokenTrail issues revocable **virtual keys**; real provider keys live only in the vault.
3. **Multi-provider chaos:** Seven providers × N models × changing prices = no single source of truth. TokenTrail normalizes usage and maintains a versioned pricing catalog.
4. **No guardrails:** Nothing stops a runaway agent from spending $30k overnight. Budgets alert (community) or hard-block at the gateway (enterprise).
5. **No reporting:** Finance asks "cost per project this quarter" and gets a shrug. TokenTrail answers in one click or one scheduled email.

## 4. Feature Requirements

### 4.1 Community Edition (Apache-2.0)

| # | Feature | Requirement summary | Priority |
|---|---|---|---|
| C1 | **Workspace Management** | Create/manage workspaces (tenant root); workspace settings, invitations, roles (Owner/Admin/Member/Viewer) | P0 |
| C2 | **User Management** | Email+password auth, invitations, profile, role assignment, deactivation | P0 |
| C3 | **Team Management** | Create teams, assign members (Lead/Member), teams own projects | P0 |
| C4 | **Project Management** | Projects belong to a workspace, optionally owned by a team; project keys; archive | P0 |
| C5 | **API Gateway** | Proxy to Anthropic, OpenAI, Gemini, Minimax, OpenRouter, DeepSeek, Ollama; native passthrough per provider + OpenAI-compatible unified endpoint; SSE streaming; virtual-key auth | P0 |
| C6 | **Cost Tracking** | Versioned pricing catalog (input/output/cache tokens per model); cost computed per request at event time; custom price overrides (e.g., negotiated rates, Ollama = $0) | P0 |
| C7 | **Usage Tracking** | Per-request usage events (tokens, latency, status, model); hourly/daily rollups by every dimension | P0 |
| C8 | **Dashboard** | Spend over time, by provider/model/team/project/user; top-N leaderboards; request volume, error rate, latency | P0 |
| C9 | **Reports** | On-demand cost & usage reports with date range + dimension filters | P1 |
| C10 | **CSV Export** | Export any report/table view to CSV (async job for large exports) | P1 |
| C11 | **Budget alerts (soft)** | Per-scope monthly budget with email alert thresholds (50/80/100%) — *alerting only*; enforcement is EE | P1 |

### 4.2 Enterprise Edition (`ee/`, commercial license key)

| # | Feature | Requirement summary | Priority |
|---|---|---|---|
| E1 | **Provider Pools** | Group multiple provider credentials; weighted/round-robin/priority routing, health-checks, automatic failover, per-credential rate limits | P0 |
| E2 | **Budget Controls** | Hard enforcement at the gateway (HTTP 429/402 on exceed), soft-block grace, per user/team/project/workspace, daily→quarterly periods | P0 |
| E3 | **Scheduled Reports** | Cron-scheduled PDF/CSV reports emailed or posted to Slack | P1 |
| E4 | **SSO** | OIDC + SAML 2.0, SCIM-lite user provisioning, enforced-SSO mode | P0 |
| E5 | **Slack Integration** | Budget alerts, anomaly alerts, weekly digests to channels | P1 |
| E6 | **Audit Logs** | Immutable log of every admin/config action; filter/search/export; retention policy | P0 |
| E7 | **White Labeling** | Custom logo, colors, product name, email templates, custom domain | P2 |

### 4.3 Explicit non-goals (v1)
- Not a prompt/eval observability tool (no prompt content storage by default — metadata only; opt-in payload logging later).
- Not an LLM router optimizing for quality (routing is credential-level failover, not model choice).
- No fine-tuning/training cost tracking in v1 (inference only).
- No agent framework; TokenTrail is infrastructure.

## 5. Key User Journeys

**J1 — Install to first insight (< 15 min):** Platform engineer runs `docker compose up` → creates workspace → adds an Anthropic key → creates project "checkout-bot" → issues virtual key → developer swaps `ANTHROPIC_BASE_URL` → requests appear on the dashboard within seconds.

**J2 — Monthly chargeback:** Finance opens Reports → Cost by Project, selects last month → exports CSV → uploads to ERP. (EE: this arrives automatically by scheduled email.)

**J3 — Runaway spend contained:** An agent loop starts burning tokens at 2 a.m. Budget hits 80% → Slack alert (EE); hits 100% → gateway returns `402 budget_exceeded` on that project's keys (EE) while other projects continue unaffected.

**J4 — Provider outage absorbed (EE):** OpenAI credential returns 529s → pool health-check marks it degraded → traffic shifts to the secondary credential; the dashboard annotates the failover event.

## 6. Success Metrics

| Metric | Target (12 mo post-GA) |
|---|---|
| Time from `docker compose up` to first tracked request | < 15 minutes |
| Gateway added latency (p99, non-streaming) | < 10 ms |
| Gateway availability (self-hosted reference) | 99.9% |
| Attribution coverage (requests with user+project) | 100% of gateway traffic |
| GitHub stars / production deployments | 10k stars / 500 tracked deployments |
| EE conversion of active workspaces > 50 users | > 5% |

## 7. Competitive Landscape

| | TokenTrail | LiteLLM | Helicone | Langfuse | Portkey |
|---|---|---|---|---|---|
| Org structure (teams/projects) | ✅ first-class | partial | ❌ | ❌ | partial |
| Self-hosted, single compose | ✅ | ✅ | partial | ✅ | ❌ |
| Governance (budgets, audit, SSO) | ✅ | partial | ❌ | partial | ✅ (SaaS) |
| Finance-grade reporting/export | ✅ | ❌ | partial | ❌ | partial |
| Prompt observability | ❌ (non-goal) | ❌ | ✅ | ✅ | ✅ |

**Positioning:** LiteLLM is a router with admin features bolted on; observability tools attribute to traces, not to org structure. TokenTrail is *governance-first*: the org chart and the budget are the primary objects, the proxy is the sensor.

## 8. Constraints & Assumptions
- Prompt/response bodies are **not persisted** by default (privacy, storage); only usage metadata.
- Pricing catalog ships with best-effort published prices; admins can override. Cost figures are estimates until provider invoices reconcile.
- Ollama is priced at $0 by default (self-hosted) but tracked for usage/capacity; admins may assign an internal $/1M-token rate.
- Single-region PostgreSQL; horizontal scale via read replicas and gateway/worker replicas (see Architecture doc).

## 9. Release Criteria (GA)
1. All P0 community features complete with > 80% test coverage on gateway + cost engine.
2. Load test: 500 RPS sustained through gateway on 4-core reference box, p99 overhead < 10 ms.
3. Streaming verified against all 7 providers' current APIs.
4. Docs: install, provider setup, key issuance, API reference (OpenAPI), upgrade guide.
5. Security review: virtual-key hashing, provider-key encryption at rest, OWASP top-10 pass.
