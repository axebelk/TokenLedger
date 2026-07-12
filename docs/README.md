# TokenTrail — Design Documentation

**TokenTrail** is an open-source AI Cost Governance and Usage Analytics Platform: developers point their AI SDKs at the TokenTrail Gateway instead of the provider, and the organization gets full attribution of AI spend by user, project, team, provider, and model — plus budgets, reports, and enterprise governance.

```
Developer ──tt_live_ key──▶ TokenTrail Gateway ──real key──▶ AI Provider
                                   │
                                   ▼
                    usage events → cost engine → dashboards/budgets/reports
```

**Providers:** Anthropic · OpenAI · Gemini · Minimax · OpenRouter · DeepSeek · Ollama
**Stack:** Node.js/TypeScript/Fastify/Prisma/PostgreSQL/Redis/BullMQ · React/AntD/React Query/Recharts · Docker Compose
**License model:** Open-core — Apache-2.0 community edition + commercial `ee/` (pools, budget enforcement, scheduled reports, SSO, Slack, audit logs, white labeling).

## Document Set

| # | Document | Contents |
|---|---|---|
| 01 | [Product Requirements (PRD)](01-product-requirements.md) | Vision, personas, CE/EE feature split, journeys, metrics, competitive positioning |
| 02 | [Software Requirements (SRS)](02-software-requirements-specification.md) | Numbered functional requirements (FR-*), NFRs, RBAC matrix, acceptance themes |
| 03 | [System Architecture](03-system-architecture.md) | Data-plane/control-plane split, golden request path, ADRs, failure modes, scaling |
| 04 | [Monorepo Structure](04-monorepo-structure.md) | pnpm/turbo layout, apps/packages/ee, dependency rules, EE hook pattern |
| 05 | [Database Schema](05-database-schema.md) | ERD, table groups, partitioned event store, rollups, integrity rules |
| 06 | [Prisma Models](06-prisma-models.md) | Full `schema.prisma` + raw-SQL migration companions + tenancy guard |
| 07 | [REST API](07-rest-api.md) | Control-plane endpoints by module, gateway surface, conventions, error envelope |
| 08 | [OpenAPI Specification](08-openapi.yaml) | OpenAPI 3.1 for core control-plane API |
| 09 | [Frontend Architecture](09-frontend-architecture.md) | React/AntD/React Query structure, routing, charts, white-label hook |
| 10 | [Backend Architecture](10-backend-architecture.md) | Service anatomy, gateway hot path, worker pipelines, security, testing |
| 11 | [Docker Deployment](11-docker-deployment.md) | Compose topology, full compose file, Caddyfile, env, images, ops guide |
| 12 | [Development Roadmap](12-development-roadmap.md) | Phases 0–6 to community GA and enterprise launch, risks, workstreams |

## Core design decisions at a glance

1. **Two planes:** a minimal, stateless **Gateway** (hot path, < 10 ms p99 overhead, fail-open) separated from the **API/Worker** control plane — they share only PostgreSQL and Redis.
2. **Attribution via virtual keys:** every `tt_live_…` key maps to user × project; real provider keys stay encrypted in the vault. Revocation propagates in ≤ 5 s.
3. **At-least-once metering:** gateway emits usage events to a Redis Stream; the worker batch-inserts idempotently and maintains hourly/daily rollups — dashboards never scan raw events.
4. **Immutable cost history:** prices are snapshotted onto each event at request time from a versioned pricing catalog (with workspace overrides).
5. **Open-core in one repo:** CE defines seams (precheck registry, audit sink, module loader); `ee/` fills them when a signed license is present.
