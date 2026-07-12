# TokenTrail — Docker Deployment

**Goal:** `git clone && cp .env.example .env && docker compose up -d` → working platform on `http://localhost:8080` in under 5 minutes.

---

## 1. Topology

```
                 :8080                    :8081
                ┌──────┐                 ┌──────┐
   Browser ───▶ │caddy │◀─── SDKs ──────▶│(same)│   caddy routes:
                └──┬───┘                 └──────┘     /api/*  → api:4000
        ┌──────────┼──────────────┐                   /gw/*   → gateway:4100
        ▼          ▼              ▼                   /*      → web:80
     web:80     api:4000     gateway:4100
                   │              │
              ┌────┴────┐   ┌────┴────┐
              ▼         ▼   ▼         ▼
          postgres:5432    redis:6379
                   ▲
              worker (no ports)
```
Single entrypoint (Caddy) gives automatic HTTPS when `DOMAIN` is set, and keeps console + gateway same-origin (no CORS pain). Gateway can optionally be exposed on a dedicated port/host for traffic isolation.

## 2. `docker-compose.yml`

```yaml
name: tokentrail

x-app-env: &app-env
  DATABASE_URL: postgresql://tokentrail:${POSTGRES_PASSWORD}@postgres:5432/tokentrail
  REDIS_URL: redis://redis:6379
  TOKENTRAIL_MASTER_KEY: ${TOKENTRAIL_MASTER_KEY}      # openssl rand -base64 32
  JWT_SECRET: ${JWT_SECRET}
  PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-http://localhost:8080}
  LOG_LEVEL: ${LOG_LEVEL:-info}
  LICENSE_KEY: ${LICENSE_KEY:-}

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: tokentrail
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: tokentrail
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tokentrail"]
      interval: 5s
      timeout: 3s
      retries: 12
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "512mb",
              "--maxmemory-policy", "noeviction"]     # streams must not be evicted
    volumes: [redisdata:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 12
    restart: unless-stopped

  migrate:                       # one-shot: schema migrations + pricing seed
    image: ghcr.io/tokentrail/api:${TOKENTRAIL_VERSION:-latest}
    command: ["node", "node_modules/.bin/prisma", "migrate", "deploy"]
    environment: *app-env
    depends_on:
      postgres: { condition: service_healthy }
    restart: "no"

  api:
    image: ghcr.io/tokentrail/api:${TOKENTRAIL_VERSION:-latest}
    environment:
      <<: *app-env
      PORT: "4000"
      SMTP_URL: ${SMTP_URL:-}
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    healthcheck: { test: ["CMD", "node", "healthcheck.js"], interval: 10s, retries: 6 }
    restart: unless-stopped

  gateway:
    image: ghcr.io/tokentrail/gateway:${TOKENTRAIL_VERSION:-latest}
    environment:
      <<: *app-env
      PORT: "4100"
      GATEWAY_FAILURE_POLICY: ${GATEWAY_FAILURE_POLICY:-FAIL_OPEN}
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    deploy:
      replicas: ${GATEWAY_REPLICAS:-1}
    healthcheck: { test: ["CMD", "node", "healthcheck.js"], interval: 10s, retries: 6 }
    restart: unless-stopped

  worker:
    image: ghcr.io/tokentrail/worker:${TOKENTRAIL_VERSION:-latest}
    environment:
      <<: *app-env
      SMTP_URL: ${SMTP_URL:-}
    volumes: [exports:/data/exports]        # generated CSV/PDF files
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    restart: unless-stopped

  web:
    image: ghcr.io/tokentrail/web:${TOKENTRAIL_VERSION:-latest}   # nginx static
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports: ["8080:8080", "8443:8443"]
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
    depends_on: [api, gateway, web]
    restart: unless-stopped

volumes:
  pgdata: {}
  redisdata: {}
  exports: {}
  caddydata: {}
```

### `deploy/Caddyfile`
```
{$DOMAIN::8080} {
    handle /api/* { reverse_proxy api:4000 }
    handle /gw/* {
        reverse_proxy gateway:4100 {
            flush_interval -1          # never buffer SSE
            transport http { read_timeout 10m }
        }
    }
    handle { reverse_proxy web:80 }
}
```
Set `DOMAIN=tokentrail.example.com` in `.env` → Caddy provisions Let's Encrypt automatically.

## 3. `.env.example` (excerpt)

```bash
# ── Required secrets (generate once, keep safe) ─────────────────
POSTGRES_PASSWORD=change-me
TOKENTRAIL_MASTER_KEY=            # openssl rand -base64 32  (encrypts provider keys — losing it orphans them)
JWT_SECRET=                       # openssl rand -base64 48

# ── Instance ────────────────────────────────────────────────────
PUBLIC_BASE_URL=http://localhost:8080
TOKENTRAIL_VERSION=latest
GATEWAY_REPLICAS=1
GATEWAY_FAILURE_POLICY=FAIL_OPEN  # FAIL_OPEN | FAIL_CLOSED
EVENT_RETENTION_DAYS=90

# ── Email (invites, alerts, exports) ───────────────────────────
SMTP_URL=smtp://user:pass@smtp.example.com:587

# ── Enterprise ──────────────────────────────────────────────────
LICENSE_KEY=

# ── Optional TLS via Caddy ─────────────────────────────────────
# DOMAIN=tokentrail.example.com
```

## 4. Image Build (multi-stage, per app)

```dockerfile
# apps/gateway/Dockerfile — pattern shared by api/worker
FROM node:22-alpine AS base
RUN corepack enable
FROM base AS build
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY ee ./ee
RUN pnpm install --frozen-lockfile && pnpm turbo build --filter=@tokentrail/gateway
RUN pnpm deploy --filter=@tokentrail/gateway --prod /out
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /out .
EXPOSE 4100
CMD ["dist/main.js"]
```
Published multi-arch (amd64/arm64) via buildx in `release.yml`; images signed with cosign; SBOM attached.

## 5. Operations

| Task | Command / practice |
|---|---|
| Upgrade | `docker compose pull && docker compose up -d` — `migrate` runs forward-only migrations before apps restart |
| Backup | nightly `pg_dump` (compose `--profile backup` includes a cron sidecar writing to `./backups`); Redis is reconstructible except ≤ minutes of unprocessed events — AOF covers restarts |
| Scale gateway | `GATEWAY_REPLICAS=4 docker compose up -d` (Caddy load-balances service DNS) |
| Logs | `docker compose logs -f gateway` (JSON; ship with vector/loki if desired) |
| Metrics | every service exposes `/metrics`; optional `--profile observability` adds Prometheus + Grafana with bundled TokenTrail dashboards |
| Dev stack | `docker-compose.dev.yml` runs postgres/redis/mailpit only; apps via `pnpm dev` with hot reload |
| Health | `GET :8080/api/v1/admin/health` aggregates: DB, Redis, stream lag, worker heartbeat, disk for exports |

## 6. Sizing Guide

| Deployment | Host | Handles |
|---|---|---|
| Trial / small team | 2 vCPU / 4 GB | ≤ 20 RPS, ≤ 1M events/mo |
| Standard org | 4 vCPU / 8 GB | ≤ 200 RPS, ≤ 10M events/mo |
| Large org | 8 vCPU / 16 GB + separate PG host, 3× gateway | ≤ 1k RPS |
| Beyond | Kubernetes (Helm chart on roadmap), PG read replica, optional ClickHouse sink | — |
```
