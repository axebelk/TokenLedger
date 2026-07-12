# TokenTrail — Frontend Architecture

**Stack:** React 18 + TypeScript (strict) · Vite · Ant Design 5 · TanStack React Query v5 · Recharts · React Router v6 · Zustand (thin UI state) · dayjs

---

## 1. Principles

1. **Server state lives in React Query; client state stays tiny.** No Redux. Zustand holds only UI concerns (sidebar collapse, active date-range, theme). Everything else is a query or mutation keyed to the API.
2. **AntD is the design system.** Theme via `ConfigProvider` design tokens — which is also exactly how EE white-labeling works (branding config → token overrides at runtime).
3. **Feature-folder structure**, mirroring backend modules, so a full-stack change touches one vertical slice in each tier.
4. **Edition/permission gating is declarative** (`<RequireRole>`, `<RequireEntitlement>`), never scattered `if`s.
5. **URL is the state** for analytics: date range, filters, group-by are query params → shareable/bookmarkable dashboards.

## 2. Directory Layout (`apps/web/src`)

```
src/
├── app/
│   ├── App.tsx                 # providers: QueryClient, ConfigProvider(theme), Router, AuthProvider
│   ├── router.tsx              # route tree, lazy-loaded feature chunks
│   ├── layouts/                # AppShell (Sider+Header), AuthLayout, SettingsLayout
│   └── providers/              # auth-context, workspace-context, entitlements-context
├── api/
│   ├── client.ts               # fetch wrapper: baseURL, access-token attach, 401→refresh retry, problem+json parsing
│   ├── types.ts                # generated from OpenAPI (openapi-typescript) — single source of truth
│   └── endpoints/              # thin typed callers per module (workspaces.ts, analytics.ts, …)
├── features/
│   ├── auth/                   # login, register, accept-invite, SSO redirect pages
│   ├── onboarding/             # first-run wizard: workspace → provider key → project → VK
│   ├── dashboard/              # widgets: SpendSummaryCards, SpendTimeseries, ProviderDonut,
│   │                           #   TopProjectsBar, TopUsersTable, BudgetStatusList, UnpricedModelsAlert
│   ├── analytics/              # explorer page: FilterBar, GroupBySelect, chart/table toggle, export button
│   ├── projects/  teams/  members/            # CRUD lists + drawers
│   ├── keys/                   # VK list, IssueKeyModal (one-time reveal + copy), revoke flow
│   ├── providers/              # credential list, AddCredentialDrawer, test-connection, pools (EE)
│   ├── budgets/                # budget list + BudgetProgress, editor (enforcement select gated EE)
│   ├── reports/                # report builder, export history, scheduled reports (EE)
│   ├── usage/                  # raw event explorer (virtualized table, detail drawer)
│   ├── settings/               # workspace, pricing overrides, integrations (EE), branding (EE), license
│   └── audit/                  # EE audit log viewer
├── components/                 # shared: PageHeader, StatCard, EmptyState, CopyField, DateRangePicker,
│   │                           #   DimensionTag, MoneyText (currency-aware), RoleBadge
│   └── charts/                 # Recharts wrappers (see §5)
├── hooks/                      # useWorkspace, useEntitlement, useRole, useUrlFilters, useDebounce
├── stores/                     # zustand: ui.ts (sidebar, theme), filters.ts (synced to URL)
├── styles/  utils/  i18n/
└── main.tsx
```

## 3. Routing

```
/login /register /invite/:token /sso/callback
/:ws                         → Dashboard
/:ws/analytics               → Explorer (?from&to&groupBy&provider…)
/:ws/projects  /:ws/projects/:id     (tabs: overview | usage | keys | budget | settings)
/:ws/teams     /:ws/teams/:id        (tabs: overview | members | usage)
/:ws/members
/:ws/keys
/:ws/usage                   → raw events
/:ws/reports  /:ws/reports/scheduled (EE)
/:ws/budgets
/:ws/settings/{general|providers|pools*|pricing|integrations*|sso*|branding*|audit*|license}   (*=EE)
/me                          → personal usage + PATs
```
Route guards: `RequireAuth` → `RequireWorkspace` (resolves `:ws`, mounts workspace context) → `RequireRole(min)` per branch; EE branches additionally `RequireEntitlement('audit_logs' | 'pools' | …)` rendering an upgrade panel when absent.

## 4. Data Layer

### Query key convention
```
[ws, "analytics", "timeseries", {metric, from, to, groupBy, filters}]
[ws, "projects", "list", {status, teamId, cursor}]
[ws, "budgets", "status"]
```
Workspace id first ⇒ switching workspace invalidates everything naturally.

### Policies
- Analytics queries: `staleTime: 60s`, `keepPreviousData` for smooth filter changes; dashboard auto-refetch every 60 s (visible tab only).
- Budget status: `refetchInterval: 30s` (it's the "is anything blocked" widget).
- Mutations invalidate their list + summary keys; optimistic updates only for trivial toggles (key revoke shows instant `REVOKED` tag with rollback on error).
- Export jobs: `useQuery` with polling until `status ∈ {DONE, FAILED}` then triggers download.
- Errors: problem+json mapped to AntD `notification.error` with `requestId` shown for supportability; 402 `license_required` mapped to upgrade modal.

### Auth flow
Access token kept in memory only (never localStorage); refresh cookie httpOnly. `client.ts` serializes concurrent 401-refresh into a single refresh promise. On refresh failure → redirect `/login?next=…`.

## 5. Charts (Recharts)

Wrapped once in `components/charts/` so every feature uses identical styling/tooltips/palette:

| Wrapper | Recharts base | Used for |
|---|---|---|
| `TimeseriesChart` | `AreaChart` (stacked when grouped) | spend/requests over time |
| `BreakdownBar` | horizontal `BarChart` | top projects/users/models |
| `ShareDonut` | `PieChart` | provider share |
| `BudgetGauge` | `RadialBarChart` | budget consumption |
| `Sparkline` | tiny `LineChart` | stat-card trends |

Rules: money formatted by shared `formatUsd` (compact ≥ $10k); dimension colors assigned stably by hashing key → palette index (a team keeps its color across charts/sessions); all charts render skeletons via a shared `ChartContainer` handling loading/empty/error; timestamps displayed in workspace timezone.

## 6. White-Labeling Hook (EE)

`GET /meta/branding` (public per host) → `{productName, logoUrl, colors}` → feeds `ConfigProvider theme.token.colorPrimary`, document title, logo slot, email links. CE simply gets TokenTrail defaults — zero conditional styling elsewhere.

## 7. Key UX Flows

- **Onboarding wizard** (empty workspace): 4 steps — add provider credential (with test button) → create project → issue VK → copy-paste snippet per SDK (`ANTHROPIC_BASE_URL=… ANTHROPIC_API_KEY=tt_…`) with a live "waiting for first request…" poll that flips to a confetti state on the first usage event.
- **One-time key reveal:** IssueKeyModal shows the full key with copy button and explicit "you won't see this again"; closing requires checkbox confirmation.
- **Analytics explorer:** FilterBar (date preset + custom range, dimension filters as removable tags) + GroupBy segmented control; table and chart stay in sync; "Export CSV" creates an export job and surfaces a toast with progress.
- **Budget editor:** live preview strip ("At current burn rate, this budget lasts ~12 days"); enforcement radio shows EE lock icon on SOFT/HARD when unlicensed.

## 8. Performance & Quality

- Route-level code splitting (`React.lazy`) — dashboard bundle target < 250 kB gz.
- Virtualized tables (`rc-virtual-list` via AntD `Table` virtual mode) for events/audit views.
- `openapi-typescript` type generation in CI — a backend contract change that breaks the frontend fails the build, not the user.
- Testing: Vitest + React Testing Library for hooks/components; Playwright e2e for the golden paths (onboarding, issue key, revoke, dashboard render, export); MSW mocks the API in both.
- Accessibility: AntD baseline + axe checks in CI on core pages; charts include data-table fallback for screen readers.
