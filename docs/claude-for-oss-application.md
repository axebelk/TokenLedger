# Claude for Open Source Program — Application Draft

Paste each section into the form at https://claude.com/contact-sales/claude-for-oss.

---

## Repository URL

```
https://github.com/axebelk/TokenLedger
```

---

## Project name

```
TokenLedger — open-core AI cost governance & multi-tenant LLM gateway
```

---

## What it does (1–2 sentences)

TokenLedger is an open-source control plane + LLM proxy that gives platform teams per-tenant virtual keys, per-request cost metering in picoUSD (BigInt exactness), budget enforcement, and audit logs for every AI provider they ship to production. CE (Apache-2.0) covers OpenAI / Anthropic / Gemini / OpenRouter / DeepSeek / Ollama + self-hosted; an Enterprise edition adds Ed25519 licensing and per-workspace hard-budget enforcement.

---

## Why the ecosystem depends on it (free-text justification)

Every team shipping LLM features to production hits the same wall on day 1: no way to (a) issue per-customer API keys, (b) attribute cost to a tenant or feature flag, or (c) enforce a budget before a runaway agent loop empties the company card. Today teams either build a thin internal proxy or hand-roll Postgres metering — both are the same ~2k-line project, badly. TokenLedger is that project done well: BigInt money math (no float drift), idempotent rollups on Redis Streams, OpenAI-compatible surface (drop-in for the SDK), and Postgres-native schema with full workspace RBAC. It is a candidate dependency for any "AI-for-X" SaaS that needs multi-tenant isolation, and for AI consultancies that need white-label cost reporting across clients.

---

## Stage and traction

- v0.1.0 tagged; production-deployable via docker-compose or from source.
- 14 packages in a pnpm monorepo: 4 deployable services (api, gateway, worker, web) + 8 libraries (auth, config, db, pricing, providers, queue, shared, telemetry) + EE licensing.
- 39 CodeQL code-scanning alerts resolved (0 open), branch protection on main with pinned action SHAs, OpenSSF Scorecard published weekly.
- Apache-2.0 CE + Enterprise license (open-core model).
- Solo-maintainer today; architecture is built to accept additional maintainers (CodeQL + conversation-resolution required on main, multi-reviewer policy ready to enable once a second maintainer joins).
- 432 KB of TypeScript; 100% of money math covered by tests.

---

## How I would use Claude Max

- Build out the Enterprise edition: SAML/SSO, per-workspace hard budgets with webhook notifications, and the self-hosted billing connector.
- Maintain the open-core side faster — doc rewrites, API design reviews on GitHub Discussions, and the long tail of community issues that don't justify paying for a model to debug.
- Specifically: use Claude to draft release notes from conventional-commit history, write migration guides for the `tt_live_ → tl_live_` key-prefix transition, and review provider-integration PRs (Anthropic / OpenAI / Gemini SDK changes happen every 2-3 weeks).

---

## Maintainer / contact

- GitHub: https://github.com/axebelk/TokenLedger
- Maintainer: @svjkumar89 (Vijay)

---

## Eligibility bucket

I don't fit the five hard thresholds cleanly (TokenLedger is brand-new: 3 stars, solo-maintainer, no foundation affiliation). I'm applying under the program's explicit fallback: maintain something the ecosystem depends on.

---

## Tips to strengthen the pitch if you re-apply later

1. If you have other OSS work (PRs merged into Fastify / Prisma / Anthropic SDK in the last 12 months) add it — that may move you into criterion 3.
2. The OpenSSF Scorecard score will populate after a few weeks of weekly runs. Worth re-applying once it clears 0.4 (with pinned deps + branch protection + active commits, it should land in the 6-8 range).
3. After the first external contribution lands, criterion 4 (20+ unique external contributors) becomes reachable within 12 months if you do outreach (Show HN, "oss-friends" type networks).
4. The "apply anyway" path has historically worked for projects like LocalStack, Sigstore tooling, and other "small but ecosystem-critical" infra — TokenLedger is in that bucket, but the rejection bar is high.