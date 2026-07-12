import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid.js";

describe("uuidv7", () => {
  it("produces valid v7 UUIDs", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts lexicographically by timestamp", () => {
    const older = uuidv7(1_700_000_000_000);
    const newer = uuidv7(1_700_000_001_000);
    expect(older < newer).toBe(true);
  });

  it("is unique across many calls in the same millisecond", () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(now)));
    expect(ids.size).toBe(1000);
  });
});
