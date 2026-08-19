import type { Provider } from "@tokenledger/shared";
import type { UsageEventMessage } from "@tokenledger/queue";
import type { PriceEntry } from "@tokenledger/pricing";

/** Everything the hot path needs to know about a presented virtual key. */
export interface ResolvedKeyContext {
  vkId: string;
  workspaceId: string;
  projectId: string;
  teamId?: string;
  userId: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  expiresAt?: Date;
  providerAllowlist: Provider[];
  /** Pins this key to specific ProviderCredential ids; empty ⇒ workspace default. */
  credentialAllowlist: string[];
  modelAllowlist: string[];
  rpmLimit?: number;
}

export interface KeyStore {
  /** Resolve by SHA-256 hash of the presented key. Null = unknown key. */
  resolve(keyHash: string): Promise<ResolvedKeyContext | null>;
}

export interface ResolvedCredentialSecret {
  credentialId: string;
  secret?: string;
  baseUrl?: string;
  /** Set when this credential was resolved via a ProviderPool (EE round-robin/failover). */
  poolId?: string;
}

export interface CredentialStore {
  /**
   * Workspace's default (or only active) credential for a provider. When
   * `allowedIds` is non-empty (a key's credentialAllowlist), resolution is
   * restricted to that set — still preferring the isDefault-flagged one
   * among them, falling back to the oldest active match otherwise.
   *
   * When a ProviderPool exists for (workspaceId, provider), an EE-wrapped
   * store selects among its healthy, non-cooling-down members per the pool's
   * strategy (PRIORITY / ROUND_ROBIN / WEIGHTED) instead — see
   * `@tokenledger/ee-gateway`'s PoolAwareCredentialStore.
   */
  getDefault(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null>;

  /**
   * Mark a credential as having just failed (429/5xx from the upstream
   * provider) — starts a cooldown window so pool selection (EE) routes
   * around it, and so the usage/limits report page can show "resets at".
   * Optional: test doubles and stores without Redis can omit it.
   */
  reportOutcome?(credentialId: string): Promise<void>;
}

export interface EventSink {
  /** Fire-and-forget: must never throw or block the response path. */
  emit(event: UsageEventMessage): void;
}

export interface PricingSource {
  /** workspaceId enables per-workspace price overrides when available. */
  match(provider: Provider, model: string, workspaceId?: string): PriceEntry | null;
  /**
   * Currently-effective global catalog snapshot, used by GET /v1/models.
   * Optional so test doubles can stay minimal; the gateway falls back to an
   * empty list when the implementation doesn't expose it.
   */
  catalog?(): PriceEntry[];
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterS: number;
}

export interface RateLimiter {
  /** Fixed-window RPM check. Must fail open (allow) on backend errors. */
  check(bucketKey: string, rpmLimit: number): Promise<RateLimitDecision>;
}

export interface BudgetScopes {
  workspaceId: string;
  projectId: string;
  userId: string;
  teamId?: string;
}

export type BudgetVerdict =
  | { blocked: false }
  | { blocked: true; scope: string; scopeId: string; resetsAt?: string };

/** EE seam (FR-GW-9): implemented by @tokenledger/ee-gateway when licensed. */
export interface BudgetGuard {
  check(scopes: BudgetScopes): Promise<BudgetVerdict>;
}

export interface GatewayDeps {
  keyStore: KeyStore;
  credentialStore: CredentialStore;
  sink: EventSink;
  pricing: PricingSource;
  rateLimiter: RateLimiter;
  budgetGuard?: BudgetGuard;
}
