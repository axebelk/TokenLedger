# Deploying TokenTrail

This guide takes you from a fresh Linux server to a running, HTTPS TokenTrail
instance using the Docker images published to the GitHub Container Registry
(GHCR) by CI.

- **CI that builds the images:** `.github/workflows/docker-publish.yml`
- **Production stack:** `deploy/docker-compose.prod.yml`
- **Host-proxy override (Path B):** `deploy/docker-compose.host-proxy.yml`
- **Bundled reverse proxy (Path A):** `deploy/Caddyfile`
- **Example vhost for your own nginx (Path B):** `deploy/nginx-site.conf.example`

---

## 0. Pick a path

TokenTrail needs *something* terminating TLS on your domain and routing three
paths to three containers: `/` → console, `/api/*` → control-plane API,
`/gw/*` → LLM gateway. There are two ways to get that, and the right one
depends on whether `:80`/`:443` on this host are already spoken for.

| | Path A — bundled Caddy | Path B — your existing reverse proxy |
|---|---|---|
| **When** | Fresh box, TokenTrail is the only thing on it | You already run nginx/Caddy/Traefik here for other sites (`:80`/`:443` are taken) |
| **HTTPS** | Automatic (Caddy + Let's Encrypt), zero config | You manage certs the way you already do (Certbot, etc.) |
| **Compose command** | adds `--profile caddy` | layers `-f deploy/docker-compose.host-proxy.yml` |
| **What you configure** | `DOMAIN` in `.env` | a vhost on your existing proxy (example provided) |

Everything below is shared except step 6 (launch) and step 7 (proxy config),
which fork per path.

There's a second, independent choice: **pull pre-built images from GHCR**
(`deploy/docker-compose.prod.yml`, steps 1–11 below as written, with the full
Path A/B split incl. an optional bundled Caddy) **or build on the server from
this checkout** (the root `docker-compose.yml` — no registry, no CI
dependency; skip steps 1 and 4 entirely). The root compose assumes you
already have a reverse proxy on this host — `api`/`gateway`/`web` are
published on `127.0.0.1` for it to reach, no bundled Caddy, no profile flags:

```bash
docker compose up -d --build
```
Point your existing proxy at `127.0.0.1:4000`/`4100`/`3000` — see
`deploy/nginx-site.conf.example`. Have no reverse proxy at all yet? Use
`deploy/docker-compose.prod.yml` with `--profile caddy` instead (Path A).

---

## 1. How images get built and published

The `Publish Docker images` workflow builds four images and pushes them to GHCR:

| Image | Contents | Port (internal) |
|-------|----------|------|
| `ghcr.io/<owner>/tokentrail-api` | Control-plane REST API | 4000 |
| `ghcr.io/<owner>/tokentrail-gateway` | Data-plane LLM proxy | 4100 |
| `ghcr.io/<owner>/tokentrail-worker` | Rollups, exports, housekeeping | — |
| `ghcr.io/<owner>/tokentrail-web` | Console (static, via nginx) | 80 |

It triggers on:

- **Git tag `vX.Y.Z`** → images tagged `X.Y.Z`, `X.Y`, and `latest`
- **Push to `main`** → images tagged `edge` + `main` + short SHA
- **Manual run** (Actions → *Publish Docker images* → *Run workflow*)

CI authenticates with the built-in `GITHUB_TOKEN` — **no secrets to configure**.
Cut a release with:

```bash
git tag v0.1.0
git push origin v0.1.0
```

After the run, make the packages pullable: on GitHub open each package
(**your profile → Packages**) → *Package settings* → set visibility to
**Public**, or keep them private and log the server into GHCR (step 4).

> ⚠️ **`latest` only moves on a version tag.** If you push commits to `main`
> without cutting a `vX.Y.Z` tag, `latest` stays pinned to whatever the last
> release was — potentially missing fixes that are already on `main` (tagged
> `main`/`edge` instead). Pin `TAG=main` in `.env` unless you're specifically
> tracking releases; either way, always check the pulled image's age (step 6)
> before assuming a `pull` picked up what you expect.

---

## 2. Server prerequisites

- A Linux host (2 vCPU / 2 GB RAM is comfortable for a small instance)
- **Docker Engine + Compose v2** installed:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```
- **Path A:** ports **80** and **443** free and open to the internet.
  **Path B:** your existing proxy already holds those — nothing new to open.
- A **domain** (e.g. `tokentrail.example.com`) with an **A record** pointing at
  the server's public IP.

---

## 3. Get the deploy files onto the server

You only need the `deploy/` folder plus `.env` — clone the repo or copy them:

```bash
git clone https://github.com/<owner>/<repo>.git tokentrail
cd tokentrail
# the pieces we use: deploy/docker-compose.prod.yml,
# deploy/docker-compose.host-proxy.yml (Path B), deploy/Caddyfile (Path A), .env
```

---

## 4. (Private images only) Log the server into GHCR

Skip this if you made the packages public. Otherwise create a
**classic Personal Access Token** with the `read:packages` scope and:

```bash
echo "<YOUR_PAT>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

---

## 5. Configure secrets — `.env`

Create `.env` in the repo root (never commit it). Start from `.env.example`:

```bash
cp .env.example .env
```

Fill in these **required** values:

```dotenv
# Registry + version (lowercase owner) — see the "latest" warning in step 1
IMAGE_PREFIX=ghcr.io/<owner>/tokentrail
TAG=main                          # or a pinned vX.Y.Z release

# Public URL — MUST match your domain, used for invite links & CORS
PUBLIC_BASE_URL=https://tokentrail.example.com

# Path A only — enables Caddy's automatic HTTPS. Leave blank for Path B.
DOMAIN=tokentrail.example.com

# Secrets — generate fresh, keep safe
POSTGRES_PASSWORD=...             # openssl rand -base64 24
TOKENTRAIL_MASTER_KEY=...         # openssl rand -base64 32  (encrypts provider keys)
JWT_SECRET=...                    # openssl rand -base64 48

# Platform super-admins (comma-separated emails that see the Platform console)
SUPERADMIN_EMAILS=you@example.com

# Optional
EVENT_RETENTION_DAYS=90
GATEWAY_FAILURE_POLICY=FAIL_OPEN  # FAIL_OPEN keeps traffic flowing if metering hiccups
SMTP_URL=                         # leave blank to use copyable invite links instead of email
LICENSE_KEY=                      # Enterprise only
```

Generate all three secrets at once:

```bash
printf 'POSTGRES_PASSWORD=%s\nTOKENTRAIL_MASTER_KEY=%s\nJWT_SECRET=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -base64 32)" "$(openssl rand -base64 48)"
```

> ⚠️ **Keep `TOKENTRAIL_MASTER_KEY` safe.** It encrypts every stored provider
> credential — losing it orphans them and they must be re-entered.
>
> ⚠️ **Secrets pasted into a chat/ticket/AI assistant should be treated as
> burned.** Rotate `POSTGRES_PASSWORD`, `TOKENTRAIL_MASTER_KEY`, and
> `JWT_SECRET` if you ever shared them outside this file.

---

## 6. Launch

**Path A — bundled Caddy** (fresh host, nothing else on `:80`/`:443`):

```bash
docker compose -f deploy/docker-compose.prod.yml --profile caddy --env-file .env pull
docker compose -f deploy/docker-compose.prod.yml --profile caddy --env-file .env up -d
```

**Path B — your existing reverse proxy:**

```bash
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.host-proxy.yml \
  --env-file .env pull
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.host-proxy.yml \
  --env-file .env up -d
```
Then configure your proxy — see **step 7**, don't skip it.

Both paths, what happens:

1. Postgres and Redis start and become healthy.
2. The **`migrate`** one-shot runs `prisma migrate deploy` + seeds the pricing
   catalog, then exits (exit code `0`).
3. `api`, `gateway`, `worker`, `web` start (and `caddy` too, on Path A).

Check status and logs:

```bash
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs -f api gateway
```

If `migrate` shows a non-zero exit or `sh: .../prisma: not found`, you likely
pulled a stale image — see the `latest`-tag warning in step 1 and the
troubleshooting table below.

---

## 7. Reverse proxy (Path B only — Path A's Caddy is already configured)

Point your existing proxy at the three ports
`docker-compose.host-proxy.yml` published on `127.0.0.1`:

| Path | Upstream |
|------|----------|
| `/` (everything else) | `127.0.0.1:3000` (console) |
| `/api/*` | `127.0.0.1:4000` (API) |
| `/gw/*` | `127.0.0.1:4100` (gateway, **streamed** responses) |

A ready-to-adapt nginx vhost is at `deploy/nginx-site.conf.example` — copy it,
set your `server_name` and cert paths, `nginx -t && systemctl reload nginx`.

> ⚠️ **The one gotcha that will 404 every API call:** nginx's `proxy_pass`
> rewrites the request path if its target has a trailing slash (or any path
> component) while the `location` prefix doesn't exactly match the request.
> TokenTrail's API only answers under `/api/v1/...` — if your proxy strips or
> mangles `/api` before forwarding, you'll see:
> ```json
> {"message":"Route POST://v1/auth/register not found","statusCode":404}
> ```
> (missing or double-slashed `/api` — same bug either way). **Fix: `proxy_pass`
> must have no trailing slash and no path** (`proxy_pass http://127.0.0.1:4000;`
> not `.../4000/;`) — that forwards the original URI byte-for-byte, no
> rewriting. The example file already does this; if you hand-write your own
> vhost, don't "clean up" that missing trailing slash.
>
> The `/gw/*` route also needs `proxy_buffering off` — LLM responses are
> streamed token-by-token (SSE/NDJSON), and a buffering proxy delivers them in
> one lump at the end instead, which breaks streaming clients.
>
> **Large requests (images/PDFs in prompts, long context):** nginx defaults to
> rejecting request bodies over 1 MB (`client_max_body_size`). Multimodal LLM
> requests routinely exceed that once an image or document is base64-encoded
> inline. The example file sets `client_max_body_size 25m;`, matching the
> gateway's own 20 MiB request cap with a little headroom. Path A (bundled
> Caddy) needs no change here — Caddy has no default body-size limit.

---

## 8. First login

Visit **`https://tokentrail.example.com`** and **register the first account**
— there's no default login, registration creates your user *and* workspace in
one step. Use an email listed in `SUPERADMIN_EMAILS` to also get the
**Platform** console. Then add a provider credential and issue a virtual key
from **Connect**.

The gateway base URL your users point their SDKs at is
`https://tokentrail.example.com/gw/<provider>/…`.

---

## 9. Upgrades

Bump `TAG` in `.env` to the new release (or re-pull `main`/`latest`) and
re-apply — the `migrate` job runs any new migrations automatically before the
services restart. Use whichever `-f`/`--profile` combination matches your path
(step 6):

```bash
# edit TAG=v0.2.0 in .env
docker compose -f deploy/docker-compose.prod.yml [--profile caddy | -f deploy/docker-compose.host-proxy.yml] \
  --env-file .env pull
docker compose -f deploy/docker-compose.prod.yml [--profile caddy | -f deploy/docker-compose.host-proxy.yml] \
  --env-file .env up -d
```

Zero-downtime-ish: Compose recreates changed services in place; the gateway can
be scaled with `GATEWAY_REPLICAS=2` in `.env` for rolling capacity.

---

## 10. Backups

The stateful data lives in two named volumes: **`tokentrail_pgdata`** (the
database — your source of truth) and `tokentrail_redisdata` (in-flight metering
stream). Back up Postgres regularly:

```bash
docker compose -f deploy/docker-compose.prod.yml exec postgres \
  pg_dump -U tokentrail tokentrail | gzip > tokentrail-$(date +%F).sql.gz
```

Restore into a fresh DB with `gunzip -c … | docker compose … exec -T postgres psql -U tokentrail tokentrail`.

---

## 11. Troubleshooting

| Symptom | Likely cause / fix |
|--------|--------------------|
| `denied` / `manifest unknown` on `pull` | Packages are private — do step 4, or make them public. Check `IMAGE_PREFIX` is lowercase. |
| `migrate` exits 127, `sh: .../prisma: not found` | Pulled an old image built before the `prisma` CLI fix. `pull` again, check `TAG` isn't silently defaulting to a stale `latest` (step 1), and compare the image's `CREATED` time: `docker compose ... images \| grep api`. |
| `docker compose up` reuses the old container/image | `pull` doesn't happen automatically — run `pull` explicitly before every `up` when you expect new code. |
| API returns `Route POST://v1/... not found` (double slash or missing `/api`) | Your reverse proxy is stripping/mangling the `/api` prefix — see the gotcha in step 7. Not applicable on Path A (Caddy's `Caddyfile` is already correct). |
| Site loads but login/register calls fail with a **CORS** or network error | `PUBLIC_BASE_URL` in `.env` doesn't match the domain you're actually browsing to — fix and restart `api`. |
| Caddy TLS errors / stuck on HTTP (Path A) | DNS A record not pointing at the server yet, or ports 80/443 blocked by a firewall/security group, or another process already bound to 80/443 (use Path B instead). |
| `api` restarts, DB errors | `migrate` didn't finish — check `logs migrate`; verify `POSTGRES_PASSWORD` matches in `.env`. |
| Invite emails never arrive | `SMTP_URL` unset — that's fine; use **Members → Copy invite link** instead. |
| No **Platform** menu for admin | The signed-in email isn't in `SUPERADMIN_EMAILS`; update `.env` and `up -d --force-recreate api` to restart with it picked up. |
| Provider credentials all invalid after a redeploy | `TOKENTRAIL_MASTER_KEY` changed — restore the original key. |
| LLM responses arrive all at once instead of streaming | Your reverse proxy is buffering `/gw/*` — add `proxy_buffering off` (nginx) or the equivalent for your proxy. |
| `413 Request Entity Too Large` on requests with images/PDFs/large context | Your proxy's body-size cap is below the gateway's 20 MiB limit — add `client_max_body_size 25m;` (nginx, see step 7). Not applicable on Path A (Caddy has no default limit). If it persists after that, confirm you're on an image tagged after the `bodyLimit` fix — older gateway builds silently capped at Fastify's 1 MiB default regardless of proxy config. |

---

### Quick reference

```bash
# (substitute your path's -f/--profile flags from step 6 everywhere below)

# start / update
docker compose -f deploy/docker-compose.prod.yml [...] --env-file .env up -d
# stop (keeps data)
docker compose -f deploy/docker-compose.prod.yml [...] down
# tail logs
docker compose -f deploy/docker-compose.prod.yml [...] logs -f
```
