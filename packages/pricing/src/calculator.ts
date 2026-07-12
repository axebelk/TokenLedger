import type { PriceEntry } from "./matcher.js";

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Computes request cost exactly, without floating-point money.
 *
 * Prices are USD per 1M tokens with ≤ 6 decimal places, so a price converts
 * losslessly to an integer in µUSD-per-Mtok; `tokens × thatInteger` is then an
 * exact integer in picoUSD (1e-12 USD). Sums stay in BigInt and format to an
 * 8-dp decimal string matching the DB column (numeric(14,8)).
 */
export function calculateCostUsd(tokens: TokenCounts, price: PriceEntry): string {
  const pico =
    tokenCostPico(tokens.inputTokens, price.inputPerMtok) +
    tokenCostPico(tokens.outputTokens, price.outputPerMtok) +
    tokenCostPico(tokens.cacheReadTokens ?? 0, price.cacheReadPerMtok) +
    tokenCostPico(tokens.cacheWriteTokens ?? 0, price.cacheWritePerMtok);
  return formatPicoUsd(pico);
}

function tokenCostPico(tokens: number, perMtok: string): bigint {
  if (tokens === 0) return 0n;
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new Error(`Token count must be a non-negative integer, got ${tokens}`);
  }
  return BigInt(tokens) * microUsdPerMtok(perMtok);
}

/** "3.75" → 3750000n (µUSD per Mtok). Rejects more than 6 decimal places. */
export function microUsdPerMtok(decimal: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(decimal);
  if (!match) throw new Error(`Invalid price '${decimal}': expected ≤ 6 decimal places`);
  const whole = match[1]!;
  const frac = (match[2] ?? "").padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(frac);
}

/** picoUSD → "0.00123450" (8 dp, truncation — sub-pico never exists). */
export function formatPicoUsd(pico: bigint): string {
  const scale = 1_000_000_000_000n; // 1 USD in picoUSD
  const whole = pico / scale;
  const fracPico = pico % scale;
  const frac8 = (fracPico / 10_000n).toString().padStart(8, "0");
  return `${whole}.${frac8}`;
}
