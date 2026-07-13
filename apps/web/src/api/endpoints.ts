import { api } from "./client.js";

// ── Types (hand-written for Phase 1; generated from OpenAPI in Phase 2) ─────

export type Provider =
  | "ANTHROPIC" | "OPENAI" | "GEMINI" | "MINIMAX" | "OPENROUTER" | "DEEPSEEK" | "OLLAMA";

export const ALL_PROVIDERS: Provider[] = [
  "ANTHROPIC", "OPENAI", "GEMINI", "MINIMAX", "OPENROUTER", "DEEPSEEK", "OLLAMA",
];

/** All seven providers have live gateway adapters. */
export const ACTIVE_PROVIDERS: Provider[] = [...ALL_PROVIDERS];

export interface User { id: string; email: string; name: string }
export interface WorkspaceRef { id: string; name: string; slug: string }
export interface Membership { workspace: WorkspaceRef; role: string }

export interface Project {
  id: string; name: string; slug: string; teamId: string | null;
  description: string | null; tags: string[]; status: string; createdAt: string;
}

export interface Team {
  id: string; name: string; slug: string; description: string | null;
  memberCount: number; projectCount: number; createdAt: string;
}
export interface TeamMemberRow { id: string; name: string; email: string; role: string; joinedAt: string }
export interface TeamDetail {
  id: string; name: string; slug: string; description: string | null; createdAt: string;
  members: TeamMemberRow[];
  projects: { id: string; name: string; slug: string; status: string }[];
}

export interface Credential {
  id: string; provider: Provider; name: string; secretLast4: string | null;
  baseUrl: string | null; isDefault: boolean; status: string; createdAt: string;
}

export interface VirtualKey {
  id: string; name: string; keyLast4: string; projectId: string; userId: string;
  providerAllowlist: Provider[]; credentialAllowlist: string[]; modelAllowlist: string[];
  rpmLimit: number | null;
  expiresAt: string | null; status: "ACTIVE" | "REVOKED" | "EXPIRED";
  lastUsedAt: string | null; createdAt: string;
}

export interface UsageEvent {
  id: string; occurredAt: string; provider: Provider; model: string; endpoint: string;
  status: string; httpStatus: number; streamed: boolean;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  costUsd: string; costBasis: string; latencyMs: number; ttftMs: number | null;
  requestId: string;
  project: { id: string; name: string; slug: string };
  user: { id: string; name: string };
}

export interface Summary {
  rangeDays: number; costUsd: string; requests: number;
  inputTokens: number; outputTokens: number; errorRate: number;
  byProvider: { provider: Provider; costUsd: string; requests: number }[];
  byModel: { provider: Provider; model: string; costUsd: string; requests: number }[];
  byDay: { date: string; costUsd: string; requests: number }[];
}

// ── Callers ──────────────────────────────────────────────────────────────────

export const authApi = {
  register: (body: { email: string; password: string; name: string; workspaceName?: string }) =>
    api<{ accessToken: string; user: User; workspace: WorkspaceRef }>("/auth/register", { method: "POST", body }),
  login: (body: { email: string; password: string }) =>
    api<{ accessToken: string; user: User }>("/auth/login", { method: "POST", body }),
  logout: () => api<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  me: () => api<{ user: User; isSuperAdmin: boolean; memberships: Membership[] }>("/auth/me"),
};

export interface PlatformStats {
  workspaces: number; users: number; activeKeys: number; requests30d: number; costUsd30d: string;
}
export interface PlatformWorkspace {
  id: string; name: string; slug: string; createdAt: string;
  members: number; projects: number; requests30d: number; costUsd30d: string;
}
export interface PlatformDayPoint {
  date: string; requests: number; costUsd: string;
}
export const adminApi = {
  stats: () => api<PlatformStats>("/admin/stats"),
  workspaces: () => api<{ data: PlatformWorkspace[] }>("/admin/workspaces"),
  timeseries: () => api<{ data: PlatformDayPoint[] }>("/admin/timeseries"),
};

export type Metric = "cost" | "requests" | "tokens" | "errors";
export type Granularity = "hour" | "day" | "week" | "month";
export type Dimension = "project" | "team" | "user" | "provider" | "model";

export interface TimeseriesResponse {
  meta: { metric: Metric; granularity: Granularity; currency: string; groupBy: Dimension | null };
  series: { key: { id?: string; name?: string }; points: { t: string; v: number }[] }[];
}
export interface BreakdownResponse {
  meta: { groupBy: Dimension; currency: string };
  rows: {
    key: { id: string; name: string };
    costUsd: string; requests: number; errors: number;
    inputTokens: number; outputTokens: number; errorRate: number; sharePct: number;
  }[];
  totalCostUsd: string;
}

export interface ExplorerParams {
  from: string; to: string;
  projectId?: string; teamId?: string; userId?: string; provider?: Provider; model?: string;
}

export interface ExportJob {
  id: string; status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  kind: string; rowCount: number | null; error: string | null;
  expiresAt: string | null; createdAt: string; downloadUrl: string | null;
}

function explorerQuery(p: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v != null && v !== "") usp.set(k, String(v));
  return usp.toString();
}

export const wsApi = {
  list: () => api<{ data: (WorkspaceRef & { role: string })[] }>("/workspaces"),
  projects: (ws: string) => api<{ data: Project[] }>(`/workspaces/${ws}/projects`),
  timeseries: (ws: string, p: ExplorerParams & { metric: Metric; granularity: Granularity; groupBy?: Dimension }) =>
    api<TimeseriesResponse>(`/workspaces/${ws}/analytics/timeseries?${explorerQuery({ ...p })}`),
  breakdown: (ws: string, p: ExplorerParams & { groupBy: Dimension; limit?: number }) =>
    api<BreakdownResponse>(`/workspaces/${ws}/analytics/breakdown?${explorerQuery({ ...p })}`),
  createProject: (ws: string, body: { name: string; description?: string; teamId?: string }) =>
    api<Project>(`/workspaces/${ws}/projects`, { method: "POST", body }),
  projectsByStatus: (ws: string, status: "ACTIVE" | "ARCHIVED") =>
    api<{ data: Project[] }>(`/workspaces/${ws}/projects?status=${status}`),
  updateProject: (ws: string, id: string, body: { teamId?: string | null; name?: string; status?: string }) =>
    api<Project>(`/workspaces/${ws}/projects/${id}`, { method: "PATCH", body }),
  deleteProject: (ws: string, id: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/projects/${id}`, { method: "DELETE" }),
  teams: (ws: string) => api<{ data: Team[] }>(`/workspaces/${ws}/teams`),
  team: (ws: string, id: string) => api<TeamDetail>(`/workspaces/${ws}/teams/${id}`),
  createTeam: (ws: string, body: { name: string; description?: string }) =>
    api<Team>(`/workspaces/${ws}/teams`, { method: "POST", body }),
  deleteTeam: (ws: string, id: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/teams/${id}`, { method: "DELETE" }),
  addTeamMember: (ws: string, teamId: string, body: { userId: string; role: string }) =>
    api<TeamMemberRow>(`/workspaces/${ws}/teams/${teamId}/members`, { method: "POST", body }),
  updateTeamMember: (ws: string, teamId: string, userId: string, role: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/teams/${teamId}/members/${userId}`, { method: "PATCH", body: { role } }),
  removeTeamMember: (ws: string, teamId: string, userId: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/teams/${teamId}/members/${userId}`, { method: "DELETE" }),
  credentials: (ws: string) => api<{ data: Credential[] }>(`/workspaces/${ws}/credentials`),
  createCredential: (
    ws: string,
    body: { provider: Provider; name: string; secret?: string; baseUrl?: string; isDefault?: boolean },
  ) => api<Credential>(`/workspaces/${ws}/credentials`, { method: "POST", body }),
  testCredential: (ws: string, id: string) =>
    api<{ ok: boolean | null; checked: boolean; httpStatus?: number; message?: string }>(
      `/workspaces/${ws}/credentials/${id}/test`, { method: "POST" }),
  updateCredential: (
    ws: string,
    id: string,
    body: { status?: "ACTIVE" | "DISABLED"; isDefault?: true; name?: string; secret?: string; baseUrl?: string | null },
  ) => api<Credential>(`/workspaces/${ws}/credentials/${id}`, { method: "PATCH", body }),
  deleteCredential: (ws: string, id: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/credentials/${id}`, { method: "DELETE" }),
  keys: (ws: string) => api<{ data: VirtualKey[] }>(`/workspaces/${ws}/keys`),
  issueKey: (
    ws: string,
    body: {
      projectId: string; name: string; userId?: string;
      providerAllowlist?: Provider[]; credentialAllowlist?: string[]; expiresAt?: string;
    },
  ) => api<VirtualKey & { key: string }>(`/workspaces/${ws}/keys`, { method: "POST", body }),
  updateKey: (
    ws: string,
    id: string,
    body: {
      name?: string; credentialAllowlist?: string[];
      rpmLimit?: number | null; expiresAt?: string | null;
    },
  ) => api<VirtualKey>(`/workspaces/${ws}/keys/${id}`, { method: "PATCH", body }),
  revokeKey: (ws: string, id: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/keys/${id}/revoke`, { method: "POST" }),
  summary: (ws: string, days = 30) => api<Summary>(`/workspaces/${ws}/analytics/summary?days=${days}`),
  events: (ws: string, cursor?: string) =>
    api<{ data: UsageEvent[]; nextCursor: string | null }>(
      `/workspaces/${ws}/usage/events?limit=50${cursor ? `&cursor=${cursor}` : ""}`),
  createExport: (ws: string, body: { kind: "usage_events"; filters?: Record<string, string> }) =>
    api<ExportJob>(`/workspaces/${ws}/exports`, { method: "POST", body }),
  exports: (ws: string) => api<{ data: ExportJob[] }>(`/workspaces/${ws}/exports`),
  exportDownloadUrl: (ws: string, id: string) => `/api/v1/workspaces/${ws}/exports/${id}/download`,
};

export interface Member {
  id: string; name: string; email: string; status: string; role: string; joinedAt: string;
}
export interface Invitation {
  id: string; email: string; role: string; expiresAt: string; createdAt: string;
}

export const membersApi = {
  list: (ws: string) => api<{ data: Member[] }>(`/workspaces/${ws}/members`),
  invitations: (ws: string) => api<{ data: Invitation[] }>(`/workspaces/${ws}/invitations`),
  invite: (ws: string, body: { email: string; role: string }) =>
    api<Invitation & { acceptUrl: string }>(`/workspaces/${ws}/invitations`, { method: "POST", body }),
  inviteLink: (ws: string, id: string) =>
    api<Invitation & { acceptUrl: string }>(`/workspaces/${ws}/invitations/${id}/link`, { method: "POST" }),
  revokeInvite: (ws: string, id: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/invitations/${id}`, { method: "DELETE" }),
};

export const inviteApi = {
  inspect: (token: string) =>
    api<{ email: string; role: string; workspace: WorkspaceRef; accountExists: boolean }>(
      `/auth/invitations/${token}`),
  accept: (token: string, body: { name?: string; password?: string }) =>
    api<{ ok: boolean; workspace: WorkspaceRef; accountCreated: boolean }>(
      `/auth/invitations/${token}/accept`, { method: "POST", body }),
};

export function formatUsd(value: string | number, compact = false): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "$0.00";
  if (compact && n >= 10_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
    }).format(n);
  }
  const digits = n !== 0 && n < 0.01 ? 6 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits,
  }).format(n);
}
