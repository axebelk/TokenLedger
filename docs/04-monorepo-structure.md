# TokenTrail — Monorepo Structure

**Tooling:** pnpm workspaces + Turborepo · TypeScript project references · Node 22 LTS · ESM throughout.

```
tokentrail/
├── package.json                    # root: scripts, engines, pnpm workspace root
├── pnpm-workspace.yaml             # apps/*, packages/*, ee/*
├── turbo.json                      # build/test/lint pipelines, remote-cache ready
├── tsconfig.base.json              # strict, NodeNext, paths for @tokentrail/*
├── .env.example                    # every variable documented
├── LICENSE                         # Apache-2.0
├── ee/LICENSE                      # TokenTrail Enterprise License (source-visible, commercial)
├── docker-compose.yml              # full stack (doc 11)
├── docker-compose.dev.yml          # infra only (pg, redis, mailpit) for local dev
│
├── apps/
│   ├── gateway/                    # DATA PLANE — deliberately minimal deps
│   │   ├── src/
│   │   │   ├── main.ts             # bootstrap, graceful drain
│   │   │   ├── server.ts           # Fastify instance, plugins, routes
│   │   │   ├── auth/               # VK resolution + caching (Redis + in-proc LRU)
│   │   │   ├── prechecks/          # rate-limit, status, budget (EE hook point)
│   │   │   ├── proxy/              # undici streaming pipeline, SSE tap
│   │   │   ├── usage/              # usage extraction → pricing → event emit
│   │   │   ├── routes/
│   │   │   │   ├── native.ts       # /gw/{provider}/*  passthrough
│   │   │   │   └── unified.ts      # /gw/v1/chat/completions (OpenAI-compatible)
│   │   │   └── config.ts           # zod-validated env
│   │   ├── test/                   # fixtures per provider incl. SSE recordings
│   │   └── Dockerfile
│   │
│   ├── api/                        # CONTROL PLANE
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── server.ts           # Fastify + @fastify/swagger (serves OpenAPI)
│   │   │   ├── plugins/            # auth (JWT/PAT), rbac, workspace-context, problem-json
│   │   │   ├── modules/            # feature modules: routes + service + schemas (zod)
│   │   │   │   ├── auth/  users/  workspaces/  teams/  projects/
│   │   │   │   ├── providers/  virtual-keys/  pricing/
│   │   │   │   ├── analytics/  reports/  exports/  budgets/
│   │   │   │   └── ee-loader.ts    # mounts ee modules when licensed
│   │   │   └── config.ts
│   │   └── Dockerfile
│   │
│   ├── worker/                     # BACKGROUND PLANE
│   │   ├── src/
│   │   │   ├── main.ts             # starts consumers + BullMQ workers + schedulers
│   │   │   ├── ingest/             # Redis Stream consumer group → batch insert + rollups
│   │   │   ├── jobs/               # BullMQ processors:
│   │   │   │   ├── export-csv.ts   notify.ts   retention.ts
│   │   │   │   ├── reconcile.ts    pricing-sync.ts
│   │   │   │   └── budget-rollover.ts
│   │   │   └── schedules.ts        # repeatable job registration
│   │   └── Dockerfile
│   │
│   └── web/                        # CONSOLE (React 18 + Vite + AntD 5)
│       ├── src/                    # detailed in doc 09
│       ├── vite.config.ts
│       └── Dockerfile              # build → nginx static
│
├── packages/
│   ├── db/                         # Prisma schema, migrations, seed, scoped-client extension
│   │   ├── prisma/schema.prisma
│   │   ├── prisma/migrations/
│   │   ├── src/index.ts            # exports PrismaClient factory + tenancy extension
│   │   └── src/seed/               # pricing catalog seed, demo data
│   ├── shared/                     # zod schemas, DTO types, enums, errors, constants
│   │   └── src/{schemas,types,errors,rbac}/
│   ├── providers/                  # provider adapters (pure, zero-IO, unit-testable)
│   │   └── src/{anthropic,openai,gemini,minimax,openrouter,deepseek,ollama}.ts
│   ├── pricing/                    # catalog loader, matcher, cost calculator, bundled seed JSON
│   ├── auth/                       # jwt/pat/vk token utils, argon2 wrappers, crypto (AES-GCM)
│   ├── queue/                      # Redis Stream + BullMQ typed wrappers, queue/job name registry
│   ├── telemetry/                  # pino logger factory, prometheus registry, otel setup
│   └── config/                     # shared env schema fragments (zod)
│
├── ee/                             # ENTERPRISE (separate license — see ee/LICENSE)
│   ├── licensing/                  # Ed25519 license verify, feature gate helper `entitled()`
│   ├── api/                        # modules mounted by ee-loader:
│   │   └── src/{pools,budget-enforcement,scheduled-reports,sso,slack,audit,white-label}/
│   ├── gateway/                    # budget precheck impl, pool router (injected via hook registry)
│   └── worker/                     # scheduled-report runner, slack notifier, audit writer
│
├── docs/                           # this documentation set + ADRs
├── scripts/                        # dev bootstrap, license tooling, load tests (autocannon/k6)
└── .github/workflows/              # ci.yml (lint→typecheck→test→build), release.yml (images)
```

## Dependency rules (enforced via eslint-plugin-boundaries)

```
apps/*      → packages/*            (never app → app)
apps/gateway→ db read-only usage; NEVER imports api modules
ee/*        → packages/*, and registers into apps via explicit hook registries
packages/*  → packages/* (no cycles; shared/config at the bottom)
web         → shared (types only) — no server code
```

**EE hook pattern:** CE code defines seams, EE fills them; CE never imports `ee/`:
```ts
// apps/gateway/src/prechecks/registry.ts (CE)
export const prechecks: GatewayPrecheck[] = [statusCheck, rateLimitCheck];
// ee/gateway/src/index.ts (EE, loaded only when licensed)
prechecks.push(budgetEnforcementCheck);
```

## Root scripts

| Script | Does |
|---|---|
| `pnpm dev` | `docker compose -f docker-compose.dev.yml up -d` + turbo dev (all apps, watch) |
| `pnpm build` / `test` / `lint` / `typecheck` | turbo across workspace, cached |
| `pnpm db:migrate` / `db:seed` / `db:studio` | Prisma via `packages/db` |
| `pnpm e2e` | Playwright (web) + supertest API suites against dev stack |

## Conventions
- **One image per app**, multi-stage Dockerfiles, distroless runtime, non-root.
- **Changesets** for versioning; conventional commits; CI publishes `ghcr.io/tokentrail/{gateway,api,worker,web}`.
- **Testing pyramid:** adapters & pricing = pure unit tests with recorded fixtures; gateway = integration against mock provider server (`scripts/mock-provider`); e2e = compose-based smoke in CI.
