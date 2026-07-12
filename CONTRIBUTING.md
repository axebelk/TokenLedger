# Contributing to TokenTrail

Thanks for helping build the open-source AI governance platform!

## Ground rules

- **Design first for big changes.** Architecture-affecting proposals start as an issue referencing the relevant doc in `docs/`; the docs are the source of truth and must be updated in the same PR that changes behavior.
- **Edition boundary.** Individual/team visibility features belong in the community core; organizational control & compliance features belong in `ee/`. When in doubt, ask in the issue before writing code.
- **Every feature PR ships its docs and tests** — provider adapters additionally need recorded fixtures (JSON + SSE transcripts, secrets scrubbed).

## Workflow

1. Fork, create a feature branch from `main`.
2. `pnpm install && pnpm dev:infra && pnpm db:migrate`.
3. Make your change; keep `pnpm typecheck`, `pnpm test`, and `pnpm lint` green.
4. Use conventional commits (`feat:`, `fix:`, `docs:`…) and sign off (DCO: `git commit -s`).
5. Open a PR; CI must pass. A maintainer reviews within 48 h (triage SLA).

## Adding a provider

New provider = one pure module in `packages/providers` implementing `ProviderAdapter`, pricing entries in `packages/db/src/seed/pricing.ts`, fixtures, and a docs entry. No changes to gateway core should be required — if they are, open an issue first.

## Licensing of contributions

Contributions outside `ee/` are accepted under Apache-2.0. Contributions to `ee/` require agreeing to the TokenTrail Enterprise contributor terms (see `ee/LICENSE`).
