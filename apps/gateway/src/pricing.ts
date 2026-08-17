import type pg from "pg";
import type { Provider } from "@tokenledger/shared";
import { matchPrice, type PriceEntry } from "@tokenledger/pricing";
import { PRICING_SEED } from "@tokenledger/db/seed";
import type { Logger } from "@tokenledger/telemetry";
import type { PricingSource } from "./types.js";

function seedCatalog(): PriceEntry[] {
  return PRICING_SEED.map((seed) => ({
    provider: seed.provider,
    modelPattern: seed.modelPattern,
    inputPerMtok: String(seed.inputPerMtok),
    outputPerMtok: String(seed.outputPerMtok),
    cacheReadPerMtok: String(seed.cacheReadPerMtok ?? 0),
    cacheWritePerMtok: String(seed.cacheWritePerMtok ?? 0),
    source: "SEED",
  }));
}

/** Bundled catalog seed — tests and database-less dev runs. */
export class StaticPricingSource implements PricingSource {
  private catalogRows = seedCatalog();

  match(provider: Provider, model: string): PriceEntry | null {
    return matchPrice(provider, model, this.catalogRows);
  }

  catalog(): PriceEntry[] {
    return [...this.catalogRows];
  }
}

interface PriceRow {
  provider: Provider;
  modelPattern: string;
  inputPerMtok: string;
  outputPerMtok: string;
  cacheReadPerMtok: string;
  cacheWritePerMtok: string;
  workspaceId?: string;
}

/**
 * DB-backed catalog + per-workspace overrides, refreshed every 5 minutes.
 * Falls back to (and starts from) the bundled seed so pricing never blocks
 * the hot path; a failed refresh keeps the previous snapshot.
 */
export class PgPricingSource implements PricingSource {
  private catalogRows: PriceEntry[] = seedCatalog();
  private overridesByWorkspace = new Map<string, PriceEntry[]>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private pool: pg.Pool,
    private logger: Logger,
    private refreshMs = 5 * 60_000,
  ) {}

  async start(): Promise<void> {
    await this.refresh().catch((err) =>
      this.logger.warn({ err }, "pricing refresh failed at boot — using bundled seed"),
    );
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => this.logger.warn({ err }, "pricing refresh failed"));
    }, this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  async refresh(): Promise<void> {
    const [prices, overrides] = await Promise.all([
      this.pool.query<PriceRow>(
        `SELECT provider, "modelPattern", "inputPerMtok"::text, "outputPerMtok"::text,
                "cacheReadPerMtok"::text, "cacheWritePerMtok"::text
           FROM model_price
          WHERE "effectiveFrom" <= now() AND ("effectiveTo" IS NULL OR "effectiveTo" > now())`,
      ),
      this.pool.query<PriceRow>(
        `SELECT "workspaceId", provider, "modelPattern", "inputPerMtok"::text,
                "outputPerMtok"::text, "cacheReadPerMtok"::text, "cacheWritePerMtok"::text
           FROM model_price_override`,
      ),
    ]);

    if (prices.rows.length > 0) {
      this.catalogRows = prices.rows.map((r) => toEntry(r, "SYNC"));
    }
    const byWs = new Map<string, PriceEntry[]>();
    for (const row of overrides.rows) {
      const list = byWs.get(row.workspaceId!) ?? [];
      list.push(toEntry(row, "OVERRIDE"));
      byWs.set(row.workspaceId!, list);
    }
    this.overridesByWorkspace = byWs;
  }

  match(provider: Provider, model: string, workspaceId?: string): PriceEntry | null {
    const overrides = workspaceId ? (this.overridesByWorkspace.get(workspaceId) ?? []) : [];
    return matchPrice(provider, model, this.catalogRows, overrides);
  }

  /** Snapshot of the currently-effective global catalog (one row per pattern). */
  catalog(): PriceEntry[] {
    return [...this.catalogRows];
  }
}

function toEntry(row: PriceRow, source: PriceEntry["source"]): PriceEntry {
  return {
    provider: row.provider,
    modelPattern: row.modelPattern,
    inputPerMtok: row.inputPerMtok,
    outputPerMtok: row.outputPerMtok,
    cacheReadPerMtok: row.cacheReadPerMtok,
    cacheWritePerMtok: row.cacheWritePerMtok,
    source,
  };
}
