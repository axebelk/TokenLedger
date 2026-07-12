# TokenTrail

**Open-source AI cost governance and usage analytics.** Point your AI SDKs at the TokenTrail Gateway instead of the provider, and instantly know **who** is using AI, **which projects and teams** consume budget, and **what every provider and model costs** — self-hosted, with one `docker compose up`.

```
Developer ──tt_live_ key──▶ TokenTrail Gateway ──real key──▶ Anthropic / OpenAI / Gemini /
                                    │                        Minimax / OpenRouter / DeepSeek / Ollama
                                    ▼
                     usage events → cost engine → dashboards · budgets · reports
```

> **Status: alpha (Phase 2 in progress).** End-to-end: virtual-key auth → streaming gateway for **all seven providers** (Anthropic, OpenAI, Gemini, Minimax, OpenRouter, DeepSeek, Ollama) with exact cost metering and per-key rate limits → idempotent rollup ingestion → dashboard, onboarding wizard, key management, usage explorer, and team invitations. Both a native passthrough surface (`/gw/{provider}/…`) and a unified OpenAI-compatible endpoint (`/gw/v1/chat/completions` with model-prefix routing and Anthropic/Gemini translation) are live. Ships with production Dockerfiles and a single `docker compose up`. The analytics explorer and CSV export are next — see [docs/12-development-roadmap.md](docs/12-development-roadmap.md).

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

## Run it

### Option A — Docker (one command)

Prereqs: Docker. Builds all images, runs migrations + pricing seed, and serves
everything behind Caddy on `:8080`.

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, TOKENTRAIL_MASTER_KEY, JWT_SECRET
docker compose up -d
```

Open http://localhost:8080. Set `DOMAIN=…` in `.env` for automatic HTTPS.

### Option B — from source (no Docker)

Prereqs: Node ≥ 22, pnpm ≥ 9 (`corepack enable`), and a reachable **PostgreSQL 16+**
and **Redis 7+** (Redis 5+ works). Point `.env` at them, then:

```bash
cp .env.example .env    # DATABASE_URL, REDIS_URL, JWT_SECRET, TOKENTRAIL_MASTER_KEY
pnpm install
pnpm start:local        # migrate + seed + build console + run everything on :8080
```

`pnpm start:local` serves the console single-origin on `:8080` (proxying `/api`
and `/gw`), so no separate reverse proxy is needed. Ctrl-C stops the stack.

### Developer watch mode

```bash
pnpm install
pnpm dev:infra          # postgres + redis + mailpit via docker compose (dev only)
pnpm db:migrate && pnpm db:seed
pnpm dev                # all apps in watch mode
```

| Surface | URL |
|---|---|
| Console | http://localhost:8080 (watch mode: :3000) |
| Gateway (point your SDKs here) | `http://localhost:8080/gw/{provider}/…` |
| Control-plane API | `…/api/v1` (`/healthz`, `/metrics`, `/api/v1/meta/version`) |

First run: open the console → the onboarding wizard walks you from a provider
key to your first tracked request in a few minutes.

Common commands: `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm db:studio`

## License

Apache-2.0 for everything outside [`ee/`](ee/LICENSE). Community edition is free forever: workspaces, teams, projects, the gateway for all 7 providers, cost & usage tracking, dashboards, reports, and CSV export.
