import type { WorkspaceRole } from "./enums.js";

/** Role ordering for "minimum role" guards: OWNER > ADMIN > MEMBER > VIEWER. */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
  VIEWER: 0,
};

export function hasMinimumRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Named capabilities so route guards read as policy, not rank comparisons. */
export const CAPABILITIES = {
  "workspace.manage": "OWNER",
  "members.manage": "ADMIN",
  "teams.manage": "ADMIN",
  "projects.manage": "ADMIN",
  "credentials.manage": "ADMIN",
  "budgets.manage": "ADMIN",
  "keys.issue": "MEMBER",
  "analytics.view": "VIEWER",
  "audit.view": "ADMIN",
} as const satisfies Record<string, WorkspaceRole>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: WorkspaceRole, capability: Capability): boolean {
  return hasMinimumRole(role, CAPABILITIES[capability]);
}
