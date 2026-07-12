import { describe, expect, it } from "vitest";
import { calculateCostUsd, formatPicoUsd, microUsdPerMtok } from "./calculator.js";
import { matchPrice, type PriceEntry } from "./matcher.js";

const entry = (provider: PriceEntry["provider"], pattern: string, input = "3", output = "15"): PriceEntry => ({
  provider,
  modelPattern: pattern,
  inputPerMtok: input,
  outputPerMtok: output,
  cacheReadPerMtok: "0.3",
  cacheWritePerMtok: "3.75",
  source: "SEED",
});

describe("matchPrice precedence", () => {
  const catalog = [
    entry("ANTHROPIC", "claude-sonnet-5*", "3", "15"),
    entry("ANTHROPIC", "claude-sonnet-5-20260101", "2.5", "12"),
    entry("ANTHROPIC", "claude-*", "10", "50"),
    entry("OLLAMA", "*", "0", "0"),
  ];

  it("prefers exact id over prefix", () => {
    expect(matchPrice("ANTHROPIC", "claude-sonnet-5-20260101", catalog)?.inputPerMtok).toBe("2.5");
  });

  it("prefers the longest matching prefix", () => {
    expect(matchPrice("ANTHROPIC", "claude-sonnet-5-20991231", catalog)?.inputPerMtok).toBe("3");
  });

  it("falls back to shorter prefix, then bare *", () => {
    expect(matchPrice("ANTHROPIC", "claude-opus-9", catalog)?.inputPerMtok).toBe("10");
    expect(matchPrice("OLLAMA", "llama3.3:70b", catalog)?.inputPerMtok).toBe("0");
  });

  it("workspace override beats catalog", () => {
    const overrides = [{ ...entry("ANTHROPIC", "claude-sonnet-5*", "1", "5"), source: "OVERRIDE" as const }];
    expect(matchPrice("ANTHROPIC", "claude-sonnet-5-20260101", catalog, overrides)?.inputPerMtok).toBe("1");
  });

  it("returns null when nothing matches (UNPRICED)", () => {
    expect(matchPrice("OPENAI", "gpt-99", catalog)).toBeNull();
  });

  it("never crosses providers", () => {
    expect(matchPrice("OPENAI", "claude-sonnet-5-20260101", catalog)).toBeNull();
  });
});

describe("calculateCostUsd", () => {
  const price = entry("ANTHROPIC", "claude-sonnet-5*"); // in 3, out 15, cr 0.3, cw 3.75

  it("computes the canonical example exactly", () => {
    // 1000 in ⇒ $0.003, 500 out ⇒ $0.0075 ⇒ $0.0105
    expect(calculateCostUsd({ inputTokens: 1000, outputTokens: 500 }, price)).toBe("0.01050000");
  });

  it("includes cache token classes", () => {
    // 100k cacheRead ⇒ $0.03; 10k cacheWrite ⇒ $0.0375
    const cost = calculateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 },
      price,
    );
    expect(cost).toBe("0.06750000");
  });

  it("is exact where floats are not (0.27 per Mtok)", () => {
    const deepseek = entry("DEEPSEEK", "deepseek-chat", "0.27", "1.1");
    // 3 tokens × 0.27/1M = 0.00000081 exactly
    expect(calculateCostUsd({ inputTokens: 3, outputTokens: 0 }, deepseek)).toBe("0.00000081");
  });

  it("handles zero-priced models (Ollama)", () => {
    const free = entry("OLLAMA", "*", "0", "0");
    expect(calculateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, free)).toBe("0.00000000");
  });

  it("rejects non-integer token counts", () => {
    expect(() => calculateCostUsd({ inputTokens: 1.5, outputTokens: 0 }, price)).toThrow();
  });
});

describe("decimal helpers", () => {
  it("parses prices to µUSD/Mtok", () => {
    expect(microUsdPerMtok("3.75")).toBe(3_750_000n);
    expect(microUsdPerMtok("0.000001")).toBe(1n);
    expect(() => microUsdPerMtok("0.0000001")).toThrow();
    expect(() => microUsdPerMtok("-1")).toThrow();
  });

  it("formats picoUSD to 8-dp strings", () => {
    expect(formatPicoUsd(1_000_000_000_000n)).toBe("1.00000000");
    expect(formatPicoUsd(10_000n)).toBe("0.00000001");
  });
});
