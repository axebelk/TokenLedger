# TokenTrail

**Open-source AI cost governance and usage analytics.** Point your AI SDKs at the TokenTrail Gateway instead of the provider, and instantly know **who** is using AI, **which projects and teams** consume budget, and **what every provider and model costs** — self-hosted, with one `docker compose up`.

```
Developer ──tt_live_ key──▶ TokenTrail Gateway ──real key──▶ Anthropic / OpenAI / Gemini /
                                    │                        Minimax / OpenRouter / DeepSeek / Ollama
                                    ▼
                     usage events → cost engine → dashboards · budgets · reports
```

> **Status: alpha (Phase 1 feature-complete).** End-to-end: virtual-key auth → streaming gateway (Anthropic/OpenAI/Ollama) with exact cost metering and per-key rate limits → idempotent rollup ingestion → dashboard, onboarding wizard, key management, usage explorer, and team invitations. Ships with production Dockerfiles and a single `docker compose up`. Gemini/Minimax/OpenRouter/DeepSeek adapters and the analytics explorer arrive in Phase 2 — see [docs/12-development-roadmap.md](docs/12-development-roadmap.md).

## Design documentation

The complete product and technical design lives in [`docs/`](docs/README.md): PRD, SRS, system architecture, database schema, Prisma models, REST API + OpenAPI, frontend/backend architecture, Docker deployment, and roadmap.

## Repository layout

```
apps/gateway     Data plane — AI request proxy (Fastify, streaming, usage metering)
apps/api         Control plane — REST API (auth, org, analytics, reports)
apps/worker      Background plane — event ingestion, rollups, jobs (BullMQ + Redis Streams)
apps/web         Console — React 18 + Ant Design 5 + React Query + Recharts
packages/*       Shared: db (Prisma), shared, providers, pricing, auth, queue, telemetry, config
ee/              Enterprise features (commercial license — see ee/LICENSE)
docs/            Full design documentation
```

## Development

Prereqs: Node ≥ 22, pnpm ≥ 9 (`corepack enable`), Docker.

```bash
cp .env.example .env          # fill in POSTGRES_PASSWORD at minimum
pnpm install
pnpm dev:infra                # postgres + redis + mailpit via docker compose
pnpm db:migrate               # create schema
pnpm db:seed                  # pricing catalog
pnpm dev                      # all apps in watch mode
```

| Service | URL |
|---|---|
| Console (web) | http://localhost:3000 |
| Control-plane API | http://localhost:4000 (`/healthz`, `/metrics`, `/api/v1/meta/version`) |
| Gateway | http://localhost:4100 (`/gw/{provider}/…`) |
| Mailpit (dev email) | http://localhost:8025 |

Common commands: `pnpm typecheck` · `pnpm test` · `pnpm lint` · `pnpm build` · `pnpm db:studio`

## License

Apache-2.0 for everything outside [`ee/`](ee/LICENSE). Community edition is free forever: workspaces, teams, projects, the gateway for all 7 providers, cost & usage tracking, dashboards, reports, and CSV export.
