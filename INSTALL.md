# Installing TokenTrail

This is a focused, zero-to-running guide. For the operating-manual-style
reference (secrets management, upgrades, backups, scaling), see **[DEPLOY.md](DEPLOY.md)**.

---

## 0. Pick your install method

| You want | Use this | Time |
|----------|----------|------|
| "Just give me a running box with HTTPS" | **[Docker — Path A](#path-a--docker-with-automatic-https)** | ~5 min |
| "I already have nginx/Caddy/Traefik on this host" | **[Docker — Path B](#path-b--docker-with-an-existing-reverse-proxy)** | ~10 min |
| "I'll build from source — no Docker dependency" | **[From source (pnpm + Node)](#from-source-pnpm--node-22)** | ~10 min |

All three converge on the same outcome: a running TokenTrail instance whose
gateway URL (`/gw/{provider}/...`) you point your AI SDKs at.

---

## What you'll need

Pick the method, then make sure the rest is ready:

- **Docker Path A:** a Linux host with `:80` and `:443` free to the internet, a domain with an A record pointing at it.
- **Docker Path B:** a Linux host with Postgres + Redis reachable on local ports (or use the bundled services), plus your existing reverse proxy on `:80`/`:443`.
- **From source:** Node ≥ 22 (use `corepack enable` to get pnpm ≥ 9), Postgres 16+ and Redis 7+ (or Redis 5+) reachable on a local port.
- **In all cases:** `openssl` (for generating secrets), `git`, and ~2 GB RAM free.

---

## Path A — Docker with automatic HTTPS

```bash
git clone https://github.com/<owner>/TokenTrail.git   # or your fork
cd TokenTrail
cp .env.example .env
```

Generate the three required secrets:

```bash
printf 'POSTGRES_PASSWORD=%s\nTOKENTRAIL_MASTER_KEY=%s\nJWT_SECRET=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -base64 32)" "$(openssl rand -base64 48)" \
  >> .env
```

Set these two in `.env`:

```dotenv
DOMAIN=tokentrail.example.com
PUBLIC_BASE_URL=https://tokentrail.example.com
```

Then launch:

```bash
docker compose --profile caddy up -d --build
docker compose --profile caddy ps       # wait until migrate exits 0
docker compose --profile caddy logs api gateway   # tail for errors
```

Caddy will fetch a Let's Encrypt certificate automatically on first request.

Open **https://tokentrail.example.com**, register the first account (use an
email matching `SUPERADMIN_EMAILS` to get the Platform console), and add a
provider credential from **Providers → Add credential**.

Your gateway base URL: **`https://tokentrail.example.com/gw/{provider}/...`**

---

## Path B — Docker with an existing reverse proxy

Use this when this host already runs nginx (or Caddy/Traefik) fronting other
sites, so `:80`/`:443` are taken.

```bash
git clone https://github.com/<owner>/TokenTrail.git
cd TokenTrail
cp .env.example .env
```

Generate secrets (same as Path A), then leave `DOMAIN=` blank (no bundled
Caddy is starting — your own proxy terminates TLS).

Layer the host-proxy override that publishes api/gateway/web on `127.0.0.1`
so your existing proxy can reach them:

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.host-proxy.yml \
  --env-file .env \
  up -d --build
```

Point your existing proxy at:

| Path | Upstream |
|------|----------|
| `/` (everything else) | `127.0.0.1:3000` |
| `/api/*` | `127.0.0.1:4000` |
| `/gw/*` | `127.0.0.1:4100` |

A ready-to-adapt nginx vhost with all the gotchas (the `/api`-prefix-strip
bug in particular) is at **`deploy/nginx-site.conf.example`** — copy it,
edit the `server_name` and cert paths, `nginx -t && systemctl reload nginx`.

If you want to see exactly what Caddy would have done for Path A:
`deploy/Caddyfile`.

---

## From source (pnpm + Node ≥ 22)

Use this when you'd rather not depend on Docker at all — useful for
development and for hosts where Docker isn't available.

```bash
git clone https://github.com/<owner>/TokenTrail.git
cd TokenTrail
pnpm install        # also runs pnpm db:generate and prisma client
```

Make sure Postgres 16+ and Redis 7+ are reachable; if not, you can run the
same dev containers the project itself uses:

```bash
pnpm dev:infra      # postgres + redis + mailpit via docker compose (dev only)
```

Copy and edit `.env`:

```bash
cp .env.example .env
# Required: DATABASE_URL, REDIS_URL, JWT_SECRET, TOKENTRAIL_MASTER_KEY
# Set PUBLIC_BASE_URL to the URL you'll reach the console at.
```

Apply migrations + seed the pricing catalog:

```bash
pnpm db:migrate     # also runs the pricing seed
```

Run everything in one command (migrate + build console + worker + api +
gateway + web on `:8080`):

```bash
pnpm start:local
```

Or, for active development (each app in watch mode):

```bash
pnpm dev            # all four apps in watch mode; console on :3000, api on :4000, gateway on :4100
```

---

## Verify the install

Regardless of the path, the smoke test is:

```bash
# 1. Console is reachable
curl -sI https://<your-domain>/ | head -1

# 2. API is healthy
curl -s https://<your-domain>/api/v1/auth/me
# → 401 Unauthorized with a requestId (expected — not logged in yet)

# 3. Migrate finished cleanly
docker compose logs migrate
# → last line: "All migrations have been successfully applied."
```

If all three return what you'd expect, log into the console at the URL
printed by the launcher, register the first account, and add a provider
credential from **Providers → Add credential**.

---

## What's next

- **[DEPLOY.md](DEPLOY.md)** — production hardening (backups, upgrades, secrets rotation, scaling, troubleshooting).
- **[docs/12-development-roadmap.md](docs/12-development-roadmap.md)** — what's currently implemented and what's next.
- **[docs/README.md](docs/README.md)** — full design documentation (PRD, SRS, architecture, data model, REST API).

If you hit a wall, file an issue with:
- which path you took,
- the relevant log output (`docker compose logs api gateway worker` or `pnpm dev` output),
- the request ID from any 4xx/5xx response you got.