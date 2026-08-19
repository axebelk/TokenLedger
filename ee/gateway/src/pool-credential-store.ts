import type { Provider } from "@tokenledger/shared";

export interface ResolvedCredentialSecret {
  credentialId: string;
  secret?: string;
  baseUrl?: string;
  poolId?: string;
}

export interface CredentialStore {
  getDefault(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null>;
  reportOutcome?(credentialId: string): Promise<void>;
}

export class PoolAwareCredentialStore implements CredentialStore {
  constructor(
    _pool: unknown,
    _ring: unknown,
    _redis: unknown,
    private inner: CredentialStore,
  ) {}

  async getDefault(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null> {
    return this.inner.getDefault(workspaceId, provider, allowedIds);
  }

  async reportOutcome(credentialId: string): Promise<void> {
    await this.inner.reportOutcome?.(credentialId);
  }
}

