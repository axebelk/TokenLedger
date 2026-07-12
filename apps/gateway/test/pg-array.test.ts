import { describe, expect, it } from "vitest";
import { parsePgArray } from "../src/stores/db.js";

/**
 * Regression: node-pg returns custom enum-array columns (Provider[]) as the raw
 * literal string "{...}", not a JS array. An empty "{}" has length 2, so an
 * unparsed value made the gateway treat every key as having a populated
 * provider allowlist and reject all traffic with 403. Only a live DB surfaced
 * this — the in-memory store returns real arrays.
 */
describe("parsePgArray", () => {
  it("parses an empty postgres array to []", () => {
    expect(parsePgArray("{}")).toEqual([]);
  });

  it("parses a populated enum array", () => {
    expect(parsePgArray("{ANTHROPIC,OPENAI}")).toEqual(["ANTHROPIC", "OPENAI"]);
  });

  it("strips quotes from quoted elements", () => {
    expect(parsePgArray('{"claude-sonnet-5*","gpt-4o"}')).toEqual(["claude-sonnet-5*", "gpt-4o"]);
  });

  it("passes through already-parsed arrays (text[] columns)", () => {
    expect(parsePgArray(["a", "b"])).toEqual(["a", "b"]);
  });

  it("treats null/undefined as empty", () => {
    expect(parsePgArray(null)).toEqual([]);
    expect(parsePgArray(undefined)).toEqual([]);
  });
});
