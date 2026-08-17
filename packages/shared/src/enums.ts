/**
 * Domain enums shared by every tier (mirrored by Prisma enums — packages/db
 * re-exports the generated ones; these exist so the frontend and pure
 * packages never import Prisma).
 */

export const PROVIDERS = [
  "ANTHROPIC",
  "OPENAI",
  "GEMINI",
  "MINIMAX",
  "OPENROUTER",
  "DEEPSEEK",
  "OLLAMA",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const TEAM_ROLES = ["LEAD", "MEMBER"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const EVENT_STATUSES = [
  "OK",
  "PROVIDER_ERROR",
  "BLOCKED_BUDGET",
  "BLOCKED_RATELIMIT",
  "AUTH_ERROR",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const COST_BASES = ["ACTUAL", "ESTIMATED", "OVERRIDDEN", "UNPRICED"] as const;
export type CostBasis = (typeof COST_BASES)[number];

export const BUDGET_SCOPES = ["WORKSPACE", "TEAM", "PROJECT", "USER"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_PERIODS = ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const ENFORCEMENTS = ["ALERT", "SOFT", "HARD"] as const;
export type Enforcement = (typeof ENFORCEMENTS)[number];

/** Token prefixes — three token classes, three prefixes, zero overlap. */
export const TOKEN_PREFIX = {
  // New canonical prefix minted from now on. The legacy prefix below is still
  // accepted on the wire so existing keys keep resolving during the transition
  // window — see `LEGACY_TOKEN_PREFIX` and apps/gateway/src/proxy/core.ts.
  virtualKey: "tl_live_",
  personalAccessToken: "tlp_",
  invite: "tli_",
} as const;

/** Legacy virtual-key prefix from before the TokenLedger rename. Accepted by
 * the gateway during the transition; no longer minted. Drop after one release. */
export const LEGACY_TOKEN_PREFIX = "tt_live_";
