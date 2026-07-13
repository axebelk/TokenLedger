# Security

## Reporting a vulnerability

**Please do not file a public issue for security vulnerabilities.**

Email **security@axebelk.com** with:

1. A short description of the vulnerability.
2. Steps to reproduce (or a proof-of-concept).
3. Affected component (`apps/api`, `apps/gateway`, `apps/worker`, `apps/web`, a specific provider adapter, …) and version.
4. Your assessment of impact and severity (if you've done one).

You'll get an acknowledgement within **2 business days**, and a fix or
mitigation plan within **10 business days** for confirmed issues. We
coordinate disclosure timing with you; please allow us a reasonable
window to release a fix before publishing details.

PGP key for sensitive reports: *(request from security@axebelk.com)*

## What we do (and don't do) with reports

- **We do:** keep you informed of progress; credit you in the release notes
  if you'd like; coordinate a public CVE if appropriate.
- **We don't:** disclose the issue publicly before a fix is available.
- **We won't:** pursue legal action against researchers who act in good
  faith and comply with this policy.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest release (see [Releases](https://github.com/axebelk/TokenTrail/releases)) | ✅ |
| `main` branch | ✅ (best-effort; pin a release for stability) |
| Older releases | ❌ — please upgrade |

## Security-relevant subsystems

These are the areas where issues have the highest impact and are most worth
reviewing:

- **Gateway auth + key resolution** — `apps/gateway/src/proxy/`, `apps/gateway/src/stores/`.
  Never bypasses `tt_live_*` validation. Sealed credentials (`TOKENTRAIL_MASTER_KEY`)
  are decrypted only inside the request handler and never logged.
- **Token encryption at rest** — `packages/auth/src/crypto.ts`. Master-key
  rotation requires a complete re-encryption of stored provider credentials;
  the existing key is read in plaintext during this window only.
- **Multi-tenant scoping** — every row is `workspaceId`-scoped via
  `apps/api/src/plugins/guards.ts`. The super-admin Platform view deliberately
  crosses that boundary; admins are governed by the `SUPERADMIN_EMAILS`
  env var and should rotate that allowlist when staff changes.
- **Invite tokens** — single-use, hashed at rest (`sha256` in `packages/auth/src/tokens.ts`);
  expiry 7 days; never returned in any response after the initial POST.

## Operational hardening reminders

These aren't bugs in the code, but they're the most common deployment
mistakes that lead to incidents:

- **Rotate the three secrets** (`POSTGRES_PASSWORD`, `TOKENTRAIL_MASTER_KEY`,
  `JWT_SECRET`) on **every** server they're installed on — they're the keys
  to everything, and once shared they're compromised forever.
- **`SUPERADMIN_EMAILS`** is your operator allowlist. Treat additions and
  removals as access changes; rotate on staff changes.
- Don't expose the gateway (`:4100`) or API (`:4000`) ports on the public
  internet — they're only ever reached via your reverse proxy, and direct
  exposure skips the rate-limiting and authentication checks layered into
  the proxy paths.
- The license file (`./deploy/Caddyfile` for Path A, your vhost for Path B)
  is the only thing terminating TLS — keep it patched.