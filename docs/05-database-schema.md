# TokenTrail — Database Schema (PostgreSQL 16)

**Version:** 1.0 · Managed by Prisma migrations; partitioning & special indexes applied via raw-SQL migration steps.

---

## 1. Entity-Relationship Overview

```
Workspace 1──* WorkspaceMember *──1 User
Workspace 1──* Team 1──* TeamMember *──1 User
Workspace 1──* Project (*──? Team owner)
Project   1──* ProjectMember *──1 User
Workspace 1──* ProviderCredential 1──* PoolMember *──1 ProviderPool (EE)
User+Project 1──* VirtualKey
Workspace 1──* UsageEvent (attributed to project/team/user/key/credential)
UsageEvent →(aggregated)→ UsageRollupHourly / UsageRollupDaily
Workspace 1──* Budget 1──* BudgetNotification
Workspace 1──* ScheduledReport (EE) · AuditLog (EE) · SsoConnection (EE)
Workspace 1──* Invitation · ApiToken · ModelPriceOverride
Global:    ModelPrice (catalog) · License
```

## 2. Table Groups

### 2.1 Identity & Org

| Table | Purpose | Key columns / notes |
|---|---|---|
| `user` | Global identity | `id`, `email` (citext, unique), `password_hash` (null when SSO-only), `name`, `avatar_url`, `status` (ACTIVE/DEACTIVATED), timestamps |
| `workspace` | Tenant root | `id`, `name`, `slug` (unique), `settings` jsonb (failure policy, member-analytics flag, display currency), `deleted_at` (soft delete) |
| `workspace_member` | Role in workspace | `workspace_id`+`user_id` unique; `role` enum(OWNER/ADMIN/MEMBER/VIEWER) |
| `team` | Team in workspace | `workspace_id`, `name`, `slug` (unique per ws), `description` |
| `team_member` | | `team_id`+`user_id` unique; `role` enum(LEAD/MEMBER) |
| `project` | Cost attribution unit | `workspace_id`, `team_id` (nullable owner), `name`, `slug` (unique per ws), `description`, `tags` text[], `status` (ACTIVE/ARCHIVED) |
| `project_member` | Extra access grants | `project_id`+`user_id` unique |
| `invitation` | Pending invites | `workspace_id`, `email`, `role`, `team_id?`, `token_hash`, `expires_at`, `accepted_at` |

### 2.2 Credentials & Keys

| Table | Purpose | Notes |
|---|---|---|
| `provider_credential` | Real upstream keys | `workspace_id`, `provider` enum, `name`, `encrypted_secret` bytea (AES-256-GCM: keyId‖iv‖ct‖tag), `secret_last4`, `base_url` (Ollama/self-hosted/OpenRouter), `model_allowlist` text[], `status` (ACTIVE/DISABLED), `is_default` per (ws,provider) partial-unique |
| `provider_pool` (EE) | Failover group | `workspace_id`, `provider`, `name`, `strategy` enum(PRIORITY/ROUND_ROBIN/WEIGHTED), `cooldown_s` |
| `pool_member` (EE) | Credential in pool | `pool_id`, `credential_id`, `priority`, `weight`, `rpm_limit`, `tpm_limit`, `health` enum(HEALTHY/DEGRADED/DISABLED), `health_changed_at` |
| `virtual_key` | Developer keys | `workspace_id`, `project_id`, `user_id`, `name`, `key_hash` (sha256, unique), `key_last4`, `provider_allowlist` provider[], `model_allowlist` text[], `rpm_limit`, `expires_at`, `status` (ACTIVE/REVOKED/EXPIRED), `last_used_at` |
| `api_token` | Admin-API PATs | `user_id`, `workspace_id`, `name`, `token_hash`, `scopes` text[], `expires_at`, `last_used_at` |

### 2.3 Pricing

| Table | Purpose | Notes |
|---|---|---|
| `model_price` | Global catalog | `provider`, `model_pattern` (exact or trailing-`*`), `input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok` numeric(12,6), `effective_from`, `effective_to` (null = current), `source` (SEED/SYNC/MANUAL). Unique(provider, model_pattern, effective_from) |
| `model_price_override` | Workspace negotiated rates | same price columns + `workspace_id`; wins over catalog |

### 2.4 Usage (high volume)

**`usage_event`** — declaratively modeled in Prisma; physically `PARTITION BY RANGE (occurred_at)`, monthly partitions auto-created by worker (`retention.ts`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (v7) | PK with `occurred_at` (partition key must be in PK) |
| `occurred_at` | timestamptz | event time (gateway clock) |
| `workspace_id`,`project_id`,`user_id`,`virtual_key_id` | uuid | attribution; team denormalized: |
| `team_id` | uuid null | project's owning team *at event time* |
| `credential_id`,`pool_id` | uuid null | which upstream key served it |
| `provider` | enum | ANTHROPIC/OPENAI/GEMINI/MINIMAX/OPENROUTER/DEEPSEEK/OLLAMA |
| `model_raw`,`model` | text | as-sent vs normalized (pricing-matched) id |
| `endpoint` | text | e.g. `chat.completions`, `messages`, `embeddings` |
| `request_id` | text | gateway request id (unique per partition) |
| `input_tokens`,`output_tokens`,`cache_read_tokens`,`cache_write_tokens`,`reasoning_tokens` | int | 0-default |
| `cost_usd` | numeric(14,8) | computed at event time |
| `unit_prices` | jsonb | snapshot: {in,out,cr,cw} per mtok + source |
| `cost_basis` | enum | ACTUAL/ESTIMATED/OVERRIDDEN/UNPRICED |
| `status` | enum | OK/PROVIDER_ERROR/BLOCKED_BUDGET/BLOCKED_RATELIMIT/AUTH_ERROR |
| `http_status` | smallint | upstream (or gateway-issued) status |
| `latency_ms`,`ttft_ms` | int | total / time-to-first-token |
| `streamed` | bool | |
| `kind` | enum | REQUEST/ADJUSTMENT |
| `tags` | text[] | from `x-tokentrail-tags` |

Indexes (per partition): `(workspace_id, occurred_at DESC)`, `(project_id, occurred_at DESC)`, `(user_id, occurred_at DESC)`, BRIN on `occurred_at`.

**Rollups** — `usage_rollup_hourly` and `usage_rollup_daily`, identical shape:

| Column | Notes |
|---|---|
| `bucket` timestamptz | hour/day truncation (UTC) |
| `workspace_id`, `project_id`, `team_id?`, `user_id`, `provider`, `model` | full dimension tuple |
| `requests`, `errors` int | |
| `input_tokens … reasoning_tokens` bigint | |
| `cost_usd` numeric(14,6) | |
| `latency_ms_sum` bigint, `latency_count` int | avg = sum/count |
| `latency_digest` bytea | t-digest sketch → p95/p99 |
| PK | (bucket, workspace_id, project_id, user_id, provider, model) — team derivable |

Upsert pattern: `INSERT … ON CONFLICT (pk) DO UPDATE SET requests = t.requests + EXCLUDED.requests, …` in the same txn as raw insert. Group-by-any-dimension = SUM over rollups.

### 2.5 Governance

| Table | Purpose | Notes |
|---|---|---|
| `budget` | Limit per scope | `workspace_id`, `scope_type` enum(WORKSPACE/TEAM/PROJECT/USER), `scope_id`, `period` enum(DAILY/WEEKLY/MONTHLY/QUARTERLY), `amount_usd`, `alert_thresholds` int[] default {50,80,100}, `enforcement` enum(ALERT/SOFT/HARD — SOFT/HARD are EE), `soft_grace_pct`, `timezone`, `status`. Unique(scope_type, scope_id, period) |
| `budget_notification` | Sent-alert dedupe | `budget_id`, `period_start`, `threshold`, `channel`, `sent_at`; unique(budget_id, period_start, threshold, channel) |
| `export_job` | CSV exports | `workspace_id`, `requested_by`, `params` jsonb, `status` (PENDING/RUNNING/DONE/FAILED), `row_count`, `file_path`, `expires_at` |
| `scheduled_report` (EE) | | `workspace_id`, `name`, `cron`, `timezone`, `report_params` jsonb, `format` (CSV/PDF), `recipients` jsonb (emails/slack channel), `last_run_at`, `status` |
| `audit_log` (EE) | Append-only | `workspace_id`, `actor_user_id`, `actor_type` (USER/SYSTEM/API_TOKEN), `action` (`project.create`, `budget.update`, …), `resource_type`, `resource_id`, `diff` jsonb (redacted), `ip`, `user_agent`, `prev_hash`, `hash` (chain), `created_at`. No UPDATE/DELETE grants; monthly partitions |
| `sso_connection` (EE) | | `workspace_id`, `type` (OIDC/SAML), `config` jsonb (encrypted client secret / IdP cert), `enforced` bool, `default_role` |
| `slack_integration` (EE) | | `workspace_id`, `team_id_slack`, `encrypted_bot_token`, `default_channel`, `status` |
| `branding` (EE) | White label | `workspace_id` unique, `product_name`, `logo_url`, `favicon_url`, `colors` jsonb, `email_from_name` |
| `license` | EE entitlement | single-row-ish: `key_text`, `plan`, `seats`, `expires_at`, `verified_at` |

## 3. Data-Volume & Performance Notes

- 10M events/mo ≈ 350 bytes/row ⇒ ~3.5 GB/mo raw; rollups ~1–3% of that. Retention default: raw 90 d (partition drop = instant), rollups forever.
- All dashboard queries answered from rollups: worst-case scan = buckets × active dimension tuples (thousands, not millions).
- Hot control-plane lookups (`virtual_key.key_hash`, `workspace_member`) are unique-index point reads; gateway additionally caches in Redis.
- `citext` extension for emails; `pgcrypto` not required (app-side crypto).

## 4. Integrity Rules

1. FKs `ON DELETE RESTRICT` for anything referenced by usage events (users/projects are deactivated/archived, never hard-deleted once they have usage). GDPR erasure = anonymize `user` row (email → tombstone), events keep the opaque `user_id`.
2. `usage_event` and `audit_log` are append-only (enforced by role grants: app role has no UPDATE/DELETE on them; worker role may DROP old partitions).
3. Every workspace-scoped table has a composite index leading with `workspace_id`.
4. Money is `numeric`, never float; tokens are integers; all timestamps `timestamptz` (UTC), presentation timezone client-side.
