# TokenTrail — REST API Design

**Base URL (control plane):** `https://<host>/api/v1` · **Gateway:** `https://<host>/gw`

## Conventions

- **Auth:** `Authorization: Bearer <jwt|ttp_pat>` on control plane; `Bearer tt_live_…` (or `x-api-key`) on gateway.
- **Workspace context:** path-scoped — `/api/v1/workspaces/{ws}/…` (`{ws}` = workspace id or slug).
- **Errors:** RFC 9457 `application/problem+json`: `{type, title, status, detail, requestId, errors?[]}`.
- **Pagination:** cursor-based — `?limit=50&cursor=…` → `{data:[…], nextCursor}`.
- **Filtering (analytics):** `from`, `to` (ISO 8601), `granularity=hour|day|week|month`, `groupBy=project|team|user|provider|model`, plus dimension filters (`projectId`, `teamId`, `userId`, `provider`, `model`, `tag`) — repeatable.
- **Idempotency:** mutating POSTs accept `Idempotency-Key` header.
- **Versioning:** URL major version; additive changes without bump; `Deprecation`/`Sunset` headers.

---

## 1. Auth & Session

| Method | Path | Description | Access |
|---|---|---|---|
| POST | `/auth/register` | Create account (+first workspace) | public |
| POST | `/auth/login` | Email+password → access JWT + refresh cookie | public |
| POST | `/auth/refresh` | Rotate refresh, new access token | cookie |
| POST | `/auth/logout` | Revoke refresh token | user |
| GET  | `/auth/me` | Current user + memberships | user |
| POST | `/auth/invitations/{token}/accept` | Accept invite | public(+token) |
| GET  | `/auth/sso/{ws}/authorize` · `/callback` | OIDC/SAML flows (EE) | public |
| GET/POST/DELETE | `/users/me/tokens` | Manage personal access tokens | user |

## 2. Workspaces & Members

| Method | Path | Description | Role |
|---|---|---|---|
| POST | `/workspaces` | Create workspace | user |
| GET/PATCH/DELETE | `/workspaces/{ws}` | Read / settings / soft-delete | member / ADMIN / OWNER |
| GET | `/workspaces/{ws}/members` | List members (filter by role/team) | member |
| PATCH/DELETE | `/workspaces/{ws}/members/{userId}` | Change role / remove | ADMIN |
| POST | `/workspaces/{ws}/invitations` | Invite (email, role, team?) | ADMIN |
| GET/DELETE | `/workspaces/{ws}/invitations[/{id}]` | List / revoke pending | ADMIN |

## 3. Teams

| Method | Path | Role |
|---|---|---|
| GET/POST | `/workspaces/{ws}/teams` | member / ADMIN |
| GET/PATCH/DELETE | `/workspaces/{ws}/teams/{teamId}` | member / ADMIN |
| GET/POST | `/workspaces/{ws}/teams/{teamId}/members` | member / ADMIN or LEAD |
| PATCH/DELETE | `…/members/{userId}` (role LEAD/MEMBER) | ADMIN or LEAD |

## 4. Projects

| Method | Path | Notes | Role |
|---|---|---|---|
| GET/POST | `/workspaces/{ws}/projects` | filter `status`, `teamId`, `tag` | member / ADMIN |
| GET/PATCH | `/workspaces/{ws}/projects/{id}` | rename, re-team, tags | ADMIN |
| POST | `…/{id}/archive` · `…/{id}/unarchive` | archive revokes project VKs | ADMIN |
| GET/POST/DELETE | `…/{id}/members[/{userId}]` | extra access grants | ADMIN |

## 5. Provider Credentials & Pools (pools = EE)

| Method | Path | Notes | Role |
|---|---|---|---|
| GET/POST | `/workspaces/{ws}/credentials` | secret write-only; response has `secretLast4` | ADMIN |
| PATCH/DELETE | `…/credentials/{id}` | rotate secret, toggle status | ADMIN |
| POST | `…/credentials/{id}/test` | live connectivity check | ADMIN |
| GET | `/providers/catalog` | supported providers + known models | member |
| GET/POST | `/workspaces/{ws}/pools` (EE) | strategy, cooldown | ADMIN |
| GET/PATCH/DELETE | `…/pools/{id}` (EE) | | ADMIN |
| PUT | `…/pools/{id}/members` (EE) | full member list replace (priority/weight/limits) | ADMIN |
| GET | `…/pools/{id}/health` (EE) | live member health | member |

## 6. Virtual Keys

| Method | Path | Notes | Role |
|---|---|---|---|
| GET/POST | `/workspaces/{ws}/keys` | POST returns full `tt_live_…` **once**; filters: `projectId`, `userId`, `status` | MEMBER (own) / ADMIN (any) |
| GET/PATCH | `…/keys/{id}` | rename, limits, allowlists | owner or ADMIN |
| POST | `…/keys/{id}/revoke` | immediate (≤5 s gateway effect) | owner or ADMIN |

## 7. Pricing

| Method | Path | Notes | Role |
|---|---|---|---|
| GET | `/pricing/models` | global catalog (current prices; `?at=` for historical) | member |
| GET/POST/DELETE | `/workspaces/{ws}/pricing/overrides[/{id}]` | negotiated / Ollama internal rates | ADMIN |
| GET | `/workspaces/{ws}/pricing/unpriced` | models seen in traffic with no price match | ADMIN |

## 8. Analytics & Usage

| Method | Path | Description |
|---|---|---|
| GET | `/workspaces/{ws}/analytics/summary` | period totals + prev-period deltas: cost, requests, tokens, errorRate, avgLatency, activeUsers/projects |
| GET | `/workspaces/{ws}/analytics/timeseries` | `metric=cost|requests|tokens|errors|latencyP95`, `granularity`, optional `groupBy` → series[] |
| GET | `/workspaces/{ws}/analytics/breakdown` | one-dim group-by table with totals + share %, sortable, paginated |
| GET | `/workspaces/{ws}/analytics/leaderboard` | top-N users/projects/models by cost |
| GET | `/workspaces/{ws}/usage/events` | raw event list (≤ 90 d), full dimension filters, cursor paginated |
| GET | `/workspaces/{ws}/usage/events/{id}` | single event detail |

All analytics endpoints apply RBAC trimming server-side (a MEMBER without workspace-analytics flag sees only own teams/projects).

**Example — spend by team, daily, this month:**
```
GET /api/v1/workspaces/acme/analytics/timeseries
    ?metric=cost&granularity=day&groupBy=team&from=2026-07-01&to=2026-07-31

200 {
  "meta": {"metric":"cost","granularity":"day","currency":"USD"},
  "series": [
    {"key":{"teamId":"…","teamName":"Platform"},
     "points":[{"t":"2026-07-01","v":412.03},{"t":"2026-07-02","v":389.77}]},
    {"key":{"teamId":"…","teamName":"Growth"},
     "points":[{"t":"2026-07-01","v":98.10}]}
  ]
}
```

## 9. Reports & Exports

| Method | Path | Notes | Edition |
|---|---|---|---|
| POST | `/workspaces/{ws}/reports/run` | body = report definition (kind, range, filters, groupBy); returns rows ≤10k or `202 {exportJobId}` | CE |
| GET/POST | `/workspaces/{ws}/exports` | list / create CSV export job | CE |
| GET | `…/exports/{id}` | status; when DONE → `downloadUrl` (signed, 24 h) | CE |
| GET/POST | `/workspaces/{ws}/scheduled-reports` | cron, recipients, format | EE |
| GET/PATCH/DELETE | `…/scheduled-reports/{id}` | | EE |
| POST | `…/scheduled-reports/{id}/run-now` | manual trigger | EE |

## 10. Budgets

| Method | Path | Notes | Edition |
|---|---|---|---|
| GET/POST | `/workspaces/{ws}/budgets` | scope, period, amount, thresholds; `enforcement=ALERT` only in CE | CE |
| GET/PATCH/DELETE | `…/budgets/{id}` | raise/lower, change enforcement (EE) | CE/EE |
| GET | `…/budgets/{id}/status` | `{spent, remaining, pct, blocked, periodStart, periodEnd}` | CE |
| GET | `…/budgets/status` | all budgets' live status (dashboard widget) | CE |

## 11. Audit Logs (EE)

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/{ws}/audit-logs` | filters: actor, action, resourceType, from/to; cursor |
| GET | `…/audit-logs/{id}` | full diff detail |
| POST | `…/audit-logs/export` | async CSV export job |

## 12. Integrations & Admin (EE unless noted)

| Method | Path | Notes |
|---|---|---|
| GET/POST/DELETE | `/workspaces/{ws}/integrations/slack` | OAuth install URL flow + channel config |
| GET/PUT | `/workspaces/{ws}/sso` | OIDC/SAML config, enforce toggle |
| GET/PUT | `/workspaces/{ws}/branding` | white-label settings |
| GET/PUT | `/admin/license` | install/inspect license (instance-level, OWNER) |
| GET | `/admin/health` | instance health summary (CE) |
| GET | `/meta/version` | version, edition, entitlements (CE) |

## 13. Gateway Surface (data plane — VK auth)

| Method | Path | Behavior |
|---|---|---|
| POST | `/gw/anthropic/v1/messages` | native Anthropic passthrough (also `/v1/messages/count_tokens`) |
| POST | `/gw/openai/v1/chat/completions` · `/v1/embeddings` · `/v1/responses` | native OpenAI passthrough |
| POST | `/gw/gemini/v1beta/models/{model}:generateContent[:streamGenerateContent]` | native Gemini |
| POST | `/gw/minimax/v1/text/chatcompletion_v2` | native Minimax |
| POST | `/gw/openrouter/api/v1/chat/completions` | native OpenRouter |
| POST | `/gw/deepseek/v1/chat/completions` | native DeepSeek |
| POST | `/gw/ollama/api/chat` · `/api/generate` · `/api/embeddings` | native Ollama |
| POST | `/gw/v1/chat/completions` | **unified** OpenAI-compatible; `model:"<provider>/<model>"` routes + translates |
| GET | `/gw/v1/models` | models available to this VK (allowlists applied) |

Gateway error envelope (gateway-originated only; provider errors pass through verbatim):
```json
{ "error": { "type": "budget_exceeded", "message": "Project 'checkout-bot' monthly budget of $500 exhausted.",
             "requestId": "req_01H…", "scope": "PROJECT", "resetsAt": "2026-08-01T00:00:00Z" } }
```
Types: `invalid_key`, `key_revoked`, `key_expired`, `provider_not_configured`, `model_not_allowed`, `rate_limited` (429), `budget_exceeded` (402), `upstream_unavailable` (502/504).
