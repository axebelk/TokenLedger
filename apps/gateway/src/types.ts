import type { Provider } from "@tokentrail/shared";
import type { UsageEventMessage } from "@tokentrail/queue";
import type { PriceEntry } from "@tokentrail/pricing";

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
}

export interface CredentialStore {
  /**
   * Workspace's default (or only active) credential for a provider. When
   * `allowedIds` is non-empty (a key's credentialAllowlist), resolution is
   * restricted to that set — still preferring the isDefault-flagged one
   * among them, falling back to the oldest active match otherwise.
   */
  getDefault(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null>;
}

export interface EventSink {
  /** Fire-and-forget: must never throw or block the response path. */
  emit(event: UsageEventMessage): void;
}

export interface PricingSource {
  /** workspaceId enables per-workspace price overrides when available. */
  match(provider: Provider, model: string, workspaceId?: string): PriceEntry | null;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterS: number;
}

export interface RateLimiter {
  /** Fixed-window RPM check. Must fail open (allow) on backend errors. */
  check(bucketKey: string, rpmLimit: number): Promise<RateLimitDecision>;
}

export interface GatewayDeps {
  keyStore: KeyStore;
  credentialStore: CredentialStore;
  sink: EventSink;
  pricing: PricingSource;
  rateLimiter: RateLimiter;
}
