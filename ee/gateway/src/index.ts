export type { CredentialStore, ResolvedCredentialSecret } from "./pool-credential-store.js";
export { PoolAwareCredentialStore } from "./pool-credential-store.js";

export interface BudgetScopes {
  workspaceId: string;
  projectId: string;
  userId: string;
  teamId?: string;
}

export type BudgetVerdict =
  | { blocked: false }
  | { blocked: true; scope: string; scopeId: string; resetsAt?: string };

export function budgetBlockKey(_scopeType: string, _scopeId: string): string {
  return "";
}

export class RedisBudgetGuard {
  constructor(_redis: unknown) {}
  async check(_scopes: BudgetScopes): Promise<BudgetVerdict> {
    return { blocked: false };
  }
}

