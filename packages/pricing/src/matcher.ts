import type { Provider } from "@tokentrail/shared";

/** Prices in USD per 1M tokens, as decimal strings (money is never a float). */
export interface PriceEntry {
  provider: Provider;
  modelPattern: string; // exact id, trailing-* prefix, or bare "*"
  inputPerMtok: string;
  outputPerMtok: string;
  cacheReadPerMtok: string;
  cacheWritePerMtok: string;
  source: "SEED" | "SYNC" | "MANUAL" | "OVERRIDE";
}

/**
 * Matching precedence (SRS FR-COST-2/3):
 *   1. workspace override, exact model id
 *   2. workspace override, longest matching prefix pattern
 *   3. catalog, exact model id
 *   4. catalog, longest matching prefix pattern
 *   5. no match ⇒ null (caller records costBasis=UNPRICED, cost 0)
 */
export function matchPrice(
  provider: Provider,
  model: string,
  catalog: PriceEntry[],
  overrides: PriceEntry[] = [],
): PriceEntry | null {
  return findIn(overrides, provider, model) ?? findIn(catalog, provider, model);
}

function findIn(entries: PriceEntry[], provider: Provider, model: string): PriceEntry | null {
  let bestPrefix: PriceEntry | null = null;
  let bestPrefixLen = -1;

  for (const entry of entries) {
    if (entry.provider !== provider) continue;
    if (entry.modelPattern === model) return entry; // exact wins immediately
    const prefix = patternPrefix(entry.modelPattern);
    if (prefix !== null && model.startsWith(prefix) && prefix.length > bestPrefixLen) {
      bestPrefix = entry;
      bestPrefixLen = prefix.length;
    }
  }
  return bestPrefix;
}

/** "claude-sonnet-5*" → "claude-sonnet-5"; "*" → ""; exact ids → null. */
function patternPrefix(pattern: string): string | null {
  if (!pattern.endsWith("*")) return null;
  return pattern.slice(0, -1);
}
