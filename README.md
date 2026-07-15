<p align="center">
  <a href="https://github.com/axebelk/TokenTrail"><img alt="TokenTrail logo" src="https://raw.githubusercontent.com/axebelk/TokenTrail/main/apps/web/public/logo.svg" width="120"></a>
</p>

<h1 align="center">TokenTrail</h1>

<p align="center">
  <strong>Open-source AI cost governance and usage analytics.</strong><br>
  Point your AI SDKs at the TokenTrail Gateway instead of the provider, and know exactly
  <em>who</em> is using AI, <em>which projects and teams</em> consume budget, and
  <em>what every provider and model costs</em> — self-hosted, with one <code>docker compose up</code>.
</p>

<p align="center">
  <a href="https://github.com/axebelk/TokenTrail/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache_2.0-green.svg"></a>
  <a href="https://github.com/axebelk/TokenTrail/releases"><img alt="Release" src="https://img.shields.io/github/v/release/axebelk/TokenTrail"></a>
  <a href="https://github.com/axebelk/TokenTrail/actions/workflows/ci.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/axebelk/TokenTrail/ci.yml?branch=main&label=tests"></a>
  <a href="https://github.com/axebelk/TokenTrail/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://img.shields.io/github/actions/workflow/status/axebelk/TokenTrail/codeql.yml?branch=main&label=codeql"></a>
  <a href="https://securityscorecards.dev/viewer/?uri=github.com/axebelk/TokenTrail"><img alt="OpenSSF Scorecard" src="https://api.securityscorecards.dev/projects/github.com/axebelk/TokenTrail/badge"></a>
  <a href="https://github.com/axebelk/TokenTrail/issues"><img alt="Issues" src="https://img.shields.io/github/issues/axebelk/TokenTrail"></a>
  <a href="https://github.com/axebelk/TokenTrail/blob/main/CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
  <a href="https://github.com/axebelk/TokenTrail/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/axebelk/TokenTrail"></a>
</p>

<p align="center">
  <a href="https://github.com/axebelk/TokenTrail/pkgs/container/tokentrail-api"><img alt="ghcr.io: api" src="https://img.shields.io/badge/ghcr.io-tokentrail--api-blue"></a>
  <a href="https://github.com/axebelk/TokenTrail/pkgs/container/tokentrail-gateway"><img alt="ghcr.io: gateway" src="https://img.shields.io/badge/ghcr.io-tokentrail--gateway-blue"></a>
  <a href="https://github.com/axebelk/TokenTrail/pkgs/container/tokentrail-worker"><img alt="ghcr.io: worker" src="https://img.shields.io/badge/ghcr.io-tokentrail--worker-blue"></a>
  <a href="https://github.com/axebelk/TokenTrail/pkgs/container/tokentrail-web"><img alt="ghcr.io: web" src="https://img.shields.io/badge/ghcr.io-tokentrail--web-blue"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> · <a href="#features">Features</a> · <a href="#supported-providers">Providers</a> · <a href="INSTALL.md">Install</a> · <a href="DEPLOY.md">Deploy</a> · <a href="docs/">Docs</a> · <a href="#quality--security">Security</a>
</p>

---

## What is TokenTrail?

Most teams adopting LLMs have **no idea who is using them, what they're costing, or
which projects are burning budget**. TokenTrail is an open-source, self-hostable
control plane that sits between your application and the AI provider:

```
┌─────────────────┐      tt_live_ key        ┌──────────────────┐    real key    ┌────────────┐
│  Your app / SDK │ ───────────────────────▶ │ TokenTrail       │ ─────────────▶ │  Provider  │
│                 │                          │ Gateway :4100     │               │ (Anthropic │
│                 │ ◀── streamed response ── │ (+ API :4000,     │ ◀───────────── │ / OpenAI…) │
│                 │                          │   Web :3000)      │               └────────────┘
└─────────────────┘                          └─────────┬─────────┘
                                                       │ exact usage events
                                                       ▼
                                          Postgres ─► rollups ─► dashboard
```

Every request is priced against the **model catalog**, attributed to the
presenting virtual key (which you already scope to a developer, project,
or team), and rolled up into daily/monthly analytics. No sampling, no
approximation, no per-call fees — TokenTrail stores every usage event
and queries are exact.

## Features

- **All 7 supported providers out of the box** — Anthropic, OpenAI, Gemini, MinMax, OpenRouter, DeepSeek, Ollama.
- **Two gateway surfaces:**
  - `/gw/{provider}/...` — native passthrough, byte-for-byte upstream compatibility.
  - `/gw/v1/chat/completions` — OpenAI-compatible unified endpoint; model field is `provider/model`, server translates to Anthropic/Gemini shapes when needed.
- **Exact cost metering** — input + output + cache-read + cache-write tokens priced against a refreshable model catalog, scoped per workspace.
- **Virtual keys** (`tt_live_…`) — rotate, revoke, rate-limit per key, pin to a specific provider credential (so multiple Anthropic accounts shared across developers stay distinguishable).
- **Workspaces, teams, projects, members** with role-based access (OWNER / ADMIN / MEMBER / VIEWER) and email-or-link invitations.
- **Per-key rate limits**, per-credential provider pinning, key expiry.
- **Cost & usage analytics** — daily/monthly per workspace, project, team, user, provider, and model. Filters, breakdowns, charts. CSV exports with datewise rows for spreadsheets.
- **Streaming-first** — SSE/NDJSON pass through token-by-token; events are metered as they stream.
- **Multi-tenant by default** — every row is `workspaceId`-scoped; super-admin platform view spans all tenants.
- **Self-hosted, single-tenant data** — your requests, your Postgres, your Redis. No telemetry leaves your box.
- **OpenAPI spec** + **PostgreSQL schema** are first-class artifacts (in `docs/`).

## Supported providers

| Provider | Native surface | Unified surface (`/gw/v1/...`) | Streaming |
|---|---|---|---|
| **Anthropic** (Claude) | ✅ | ✅ translated | ✅ |
| **OpenAI** (GPT-4o, GPT-4.1, o3, …) | ✅ | ✅ | ✅ |
| **Google Gemini** | ✅ | ✅ translated | ✅ (non-streaming only on unified) |
| **MinMax** | ✅ | ✅ | ✅ |
| **OpenRouter** (passthrough) | ✅ | ✅ | ✅ |
| **DeepSeek** | ✅ | ✅ | ✅ |
| **Ollama** (self-hosted) | ✅ | ✅ | ✅ |

## Quick start

The fastest way up. (~5 min, with HTTPS automatic.)

```bash
git clone https://github.com/axebelk/TokenTrail.git
cd TokenTrail
cp .env.example .env

# Generate the three required secrets:
printf 'POSTGRES_PASSWORD=%s\nTOKENTRAIL_MASTER_KEY=%s\nJWT_SECRET=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -base64 32)" "$(openssl rand -base64 48)" >> .env

# Set your domain (Caddy will auto-issue a Let's Encrypt cert):
echo 'DOMAIN=tokentrail.example.com' >> .env
echo 'PUBLIC_BASE_URL=https://tokentrail.example.com' >> .env

docker compose --profile caddy up -d --build
```

Open `https://<your-domain>`, register, and add a provider credential from
**Providers → Add credential**. Then point your SDKs at
`https://<your-domain>/gw/{provider}/...`.

For other installs (existing reverse proxy on the host, from-source on
Node, behind nginx instead of Caddy) see **[INSTALL.md](INSTALL.md)**.

## Architecture (60-second tour)

```
apps/gateway   ─ Data plane  ─ Fastify, streaming SSE/NDJSON, tt_live_ auth, exact metering
apps/api       ─ Control plane ─ REST API, auth, org, analytics, reports
apps/worker    ─ Background plane ─ BullMQ jobs: event ingestion, daily rollups,
                                       async CSV export, housekeeping, budget engine
apps/web       ─ Console ─ React 18 + Ant Design 5 + React Query + Recharts
packages/*     ─ Shared: db (Prisma), shared, providers, pricing, auth, queue, telemetry
ee/            ─ Enterprise features (commercial license — see ee/LICENSE)
docs/          ─ Full design documentation (PRD, SRS, architecture, schema, API, …)
```

The hot path (gateway) never touches Prisma — it uses raw `pg` with prepared
statements, with a Redis-fronted 5s/60s two-tier cache for virtual-key
resolution so the per-request overhead is a single Redis GET in the common
case.

## Run it

### From source (development)

```bash
pnpm install
pnpm db:migrate       # runs migrations + seeds the pricing catalog
pnpm dev              # all apps in watch mode; console :3000, api :4000, gateway :4100
```

### Production

See **[INSTALL.md](INSTALL.md)** for the three deployment paths, and
**[DEPLOY.md](DEPLOY.md)** for the production reference (secrets, upgrades,
backups, scaling, troubleshooting).

## Documentation

| Document | What's in it |
|----------|--------------|
| **[INSTALL.md](INSTALL.md)** | Zero-to-running guide (Docker Path A/B, from source) |
| **[DEPLOY.md](DEPLOY.md)** | Production reference (secrets, upgrades, backups, troubleshooting) |
| **[docs/](docs/README.md)** | Full design set: PRD, SRS, system architecture, DB schema, Prisma models, REST API + OpenAPI, frontend/backend architecture, Docker deployment, roadmap |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | How to set up a dev environment, run tests, file PRs |
| **[SECURITY.md](SECURITY.md)** | Vulnerability disclosure policy |
| **[LICENSE](LICENSE)** | Apache-2.0 for everything outside `ee/` |

## Contributing

Issues and PRs welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for
the dev workflow, test commands, and PR conventions. Use the issue
templates for bugs and feature requests.

If you're adding a new provider, start from the existing
`apps/gateway/src/providers/` adapter shape — each provider is one file
implementing the `ProviderAdapter` interface, and the rest of the system
(intake, metering, credential resolution, pricing) reuses it.

## Releases

Versions follow [SemVer](https://semver.org/) and are cut automatically by
[Release Please](https://github.com/googleapis/release-please) from
conventional commit messages — see the [Releases page](https://github.com/axebelk/TokenTrail/releases)
for the changelog. To upgrade, change `TAG` in `.env` and `docker compose pull && up -d`.

Every push to `main` builds and publishes four versioned images to GHCR —
`tokentrail-api`, `tokentrail-gateway`, `tokentrail-worker`, `tokentrail-web`
(see the package badges above) — via `.github/workflows/docker-publish.yml`.

## Quality & security

- **CI** (`.github/workflows/ci.yml`) — typecheck, unit tests, and a full
  build run on every push and PR to `main`. The badge above reflects the
  latest run on `main`.
- **CodeQL** (`.github/workflows/codeql.yml`) — static analysis (SAST) for
  JS/TS on every push/PR plus a weekly scheduled scan; results land under
  the repo's **Security → Code scanning** tab.
- **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) — a weekly,
  automated security-posture score (branch protection, pinned dependencies,
  dangerous workflow patterns, review coverage, …) published to the public
  [Scorecard API](https://securityscorecards.dev) so anyone can audit it
  independently, not just take our word for it.
- **Dependabot** (`.github/dependabot.yml`) — weekly automated PRs for npm
  packages, Docker base images, and GitHub Actions versions, grouped by
  vendor to keep the PR volume sane.
- **Vulnerability disclosure** — see [SECURITY.md](SECURITY.md) for the
  private reporting process and supported-versions policy.

## License

- Everything outside `ee/` is **Apache-2.0** — see [LICENSE](LICENSE).
- `ee/` is the **TokenTrail Enterprise License** (commercial) — see [ee/LICENSE](ee/LICENSE).

The community edition is **free forever** and includes everything most
self-hosted teams need: workspaces, teams, projects, the gateway for all 7
providers, cost & usage tracking, dashboards, reports, and CSV export.

---

<p align="center">
  Built by <a href="https://github.com/axebelk">Axebelk</a> · Star ⭐ if it's useful
</p>