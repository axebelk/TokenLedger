import type { Provider } from "@tokentrail/shared";
import type { UsageEventMessage } from "@tokentrail/queue";
import type {
  CredentialStore,
  EventSink,
  KeyStore,
  ResolvedCredentialSecret,
  ResolvedKeyContext,
} from "../types.js";

/**
 * In-memory stores: used by the test suite and by `tokentrail dev` runs
 * without a database (the gateway logs a warning and authorizes nothing
 * unless keys are seeded explicitly).
 */

export class InMemoryKeyStore implements KeyStore {
  private keys = new Map<string, ResolvedKeyContext>();

  set(keyHash: string, ctx: ResolvedKeyContext): void {
    this.keys.set(keyHash, ctx);
  }

  async resolve(keyHash: string): Promise<ResolvedKeyContext | null> {
    return this.keys.get(keyHash) ?? null;
  }
}

export class InMemoryCredentialStore implements CredentialStore {
  private creds = new Map<string, ResolvedCredentialSecret>();

  set(workspaceId: string, provider: Provider, cred: ResolvedCredentialSecret): void {
    this.creds.set(`${workspaceId}:${provider}`, cred);
  }

  async getDefault(workspaceId: string, provider: Provider) {
    return this.creds.get(`${workspaceId}:${provider}`) ?? null;
  }
}

/** Collects emitted events for assertions (and for --no-redis dev runs). */
export class CollectingSink implements EventSink {
  readonly events: UsageEventMessage[] = [];

  emit(event: UsageEventMessage): void {
    this.events.push(event);
  }
}
