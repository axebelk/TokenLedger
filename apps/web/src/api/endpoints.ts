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

export interface Credential {
  id: string; provider: Provider; name: string; secretLast4: string | null;
  baseUrl: string | null; isDefault: boolean; status: string; createdAt: string;
}

export interface VirtualKey {
  id: string; name: string; keyLast4: string; projectId: string; userId: string;
  providerAllowlist: Provider[]; modelAllowlist: string[]; rpmLimit: number | null;
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
  me: () => api<{ user: User; memberships: Membership[] }>("/auth/me"),
};

export const wsApi = {
  list: () => api<{ data: (WorkspaceRef & { role: string })[] }>("/workspaces"),
  projects: (ws: string) => api<{ data: Project[] }>(`/workspaces/${ws}/projects`),
  createProject: (ws: string, body: { name: string; description?: string }) =>
    api<Project>(`/workspaces/${ws}/projects`, { method: "POST", body }),
  credentials: (ws: string) => api<{ data: Credential[] }>(`/workspaces/${ws}/credentials`),
  createCredential: (
    ws: string,
    body: { provider: Provider; name: string; secret?: string; baseUrl?: string; isDefault?: boolean },
  ) => api<Credential>(`/workspaces/${ws}/credentials`, { method: "POST", body }),
  testCredential: (ws: string, id: string) =>
    api<{ ok: boolean | null; checked: boolean; httpStatus?: number; message?: string }>(
      `/workspaces/${ws}/credentials/${id}/test`, { method: "POST" }),
  keys: (ws: string) => api<{ data: VirtualKey[] }>(`/workspaces/${ws}/keys`),
  issueKey: (ws: string, body: { projectId: string; name: string; expiresAt?: string }) =>
    api<VirtualKey & { key: string }>(`/workspaces/${ws}/keys`, { method: "POST", body }),
  revokeKey: (ws: string, id: string) =>
    api<{ ok: boolean }>(`/workspaces/${ws}/keys/${id}/revoke`, { method: "POST" }),
  summary: (ws: string, days = 30) => api<Summary>(`/workspaces/${ws}/analytics/summary?days=${days}`),
  events: (ws: string, cursor?: string) =>
    api<{ data: UsageEvent[]; nextCursor: string | null }>(
      `/workspaces/${ws}/usage/events?limit=50${cursor ? `&cursor=${cursor}` : ""}`),
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
    api<Invitation>(`/workspaces/${ws}/invitations`, { method: "POST", body }),
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
