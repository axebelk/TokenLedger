# Deploying TokenTrail

This guide takes you from a fresh Linux server to a running, HTTPS TokenTrail
instance using the Docker images published to the GitHub Container Registry
(GHCR) by CI.

- **CI that builds the images:** `.github/workflows/docker-publish.yml`
- **Production stack:** `deploy/docker-compose.prod.yml`
- **Reverse proxy config:** `deploy/Caddyfile`

---

## 1. How images get built and published

The `Publish Docker images` workflow builds four images and pushes them to GHCR:

| Image | Contents | Port |
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

---

## 2. Server prerequisites

- A Linux host (2 vCPU / 2 GB RAM is comfortable for a small instance)
- **Docker Engine + Compose v2** installed:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```
- Ports **80** and **443** open to the internet
- A **domain** (e.g. `tokentrail.example.com`) with an **A record** pointing at
  the server's public IP — required for automatic HTTPS

---

## 3. Get the deploy files onto the server

You only need three files on the server — clone the repo or copy them:

```bash
git clone https://github.com/<owner>/<repo>.git tokentrail
cd tokentrail
# the pieces we use: deploy/docker-compose.prod.yml, deploy/Caddyfile, .env
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
# Registry + version (lowercase owner)
IMAGE_PREFIX=ghcr.io/<owner>/tokentrail
TAG=v0.1.0                       # pin a release; avoid "latest" in prod

# Public URL — MUST match your domain, used for invite links & CORS
PUBLIC_BASE_URL=https://tokentrail.example.com
DOMAIN=tokentrail.example.com    # enables Caddy auto-HTTPS

# Secrets — generate fresh, keep safe
POSTGRES_PASSWORD=...            # openssl rand -base64 24
TOKENTRAIL_MASTER_KEY=...        # openssl rand -base64 32  (encrypts provider keys)
JWT_SECRET=...                   # openssl rand -base64 48

# Platform super-admins (comma-separated emails that see the Platform console)
SUPERADMIN_EMAILS=you@example.com

# Optional
EVENT_RETENTION_DAYS=90
GATEWAY_FAILURE_POLICY=FAIL_OPEN # FAIL_OPEN keeps traffic flowing if metering hiccups
SMTP_URL=                        # leave blank to use copyable invite links instead of email
LICENSE_KEY=                     # Enterprise only
```

Generate all three secrets at once:

```bash
printf 'POSTGRES_PASSWORD=%s\nTOKENTRAIL_MASTER_KEY=%s\nJWT_SECRET=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -base64 32)" "$(openssl rand -base64 48)"
```

> ⚠️ **Keep `TOKENTRAIL_MASTER_KEY` safe.** It encrypts every stored provider
> credential — losing it orphans them and they must be re-entered.

---

## 6. Launch

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env pull
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d
```

What happens:

1. Postgres and Redis start and become healthy.
2. The **`migrate`** one-shot runs `prisma migrate deploy` + seeds the pricing
   catalog, then exits.
3. `api`, `gateway`, `worker`, `web`, and `caddy` start.
4. Caddy fetches a Let's Encrypt certificate for `DOMAIN` and serves HTTPS.

Check status and logs:

```bash
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs -f api gateway
```

Visit **`https://tokentrail.example.com`**, register the first account (its
email should be in `SUPERADMIN_EMAILS` to get the **Platform** console), then
add a provider credential and issue a virtual key from **Connect**.

The gateway base URL your users point their SDKs at is
`https://tokentrail.example.com/gw/<provider>/…`.

---

## 7. Upgrades

Bump `TAG` in `.env` to the new release (or re-pull `latest`) and re-apply — the
`migrate` job runs any new migrations automatically before the services restart:

```bash
# edit TAG=v0.2.0 in .env
docker compose -f deploy/docker-compose.prod.yml --env-file .env pull
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d
```

Zero-downtime-ish: Compose recreates changed services in place; the gateway can
be scaled with `GATEWAY_REPLICAS=2` in `.env` for rolling capacity.

---

## 8. Backups

The stateful data lives in two named volumes: **`tokentrail_pgdata`** (the
database — your source of truth) and `tokentrail_redisdata` (in-flight metering
stream). Back up Postgres regularly:

```bash
docker compose -f deploy/docker-compose.prod.yml exec postgres \
  pg_dump -U tokentrail tokentrail | gzip > tokentrail-$(date +%F).sql.gz
```

Restore into a fresh DB with `gunzip -c … | docker compose … exec -T postgres psql -U tokentrail tokentrail`.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|--------|--------------------|
| `denied` / `manifest unknown` on `pull` | Packages are private — do step 4, or make them public. Check `IMAGE_PREFIX` is lowercase. |
| Caddy TLS errors / stuck on HTTP | DNS A record not pointing at the server yet, or ports 80/443 blocked by a firewall/security group. |
| `api` restarts, DB errors | `migrate` didn't finish — check `logs migrate`; verify `POSTGRES_PASSWORD` matches in `.env`. |
| Invite emails never arrive | `SMTP_URL` unset — that's fine; use **Members → Copy invite link** instead. |
| No **Platform** menu for admin | The signed-in email isn't in `SUPERADMIN_EMAILS`; update `.env` and `up -d` to restart `api`. |
| Provider credentials all invalid after a redeploy | `TOKENTRAIL_MASTER_KEY` changed — restore the original key. |

---

### Quick reference

```bash
# start / update
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d
# stop (keeps data)
docker compose -f deploy/docker-compose.prod.yml down
# tail logs
docker compose -f deploy/docker-compose.prod.yml logs -f
```
