import { describe, expect, it } from "vitest";
import { periodWindow } from "./period.js";

const at = (iso: string) => new Date(iso);

describe("periodWindow (UTC)", () => {
  it("DAILY spans the UTC day", () => {
    const w = periodWindow("DAILY", at("2026-07-12T15:30:00Z"));
    expect(w.start.toISOString()).toBe("2026-07-12T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("WEEKLY starts on Monday", () => {
    // 2026-07-12 is a Sunday → week started Monday 2026-07-06
    const w = periodWindow("WEEKLY", at("2026-07-12T15:30:00Z"));
    expect(w.start.toISOString()).toBe("2026-07-06T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("MONTHLY spans the calendar month", () => {
    const w = periodWindow("MONTHLY", at("2026-07-12T15:30:00Z"));
    expect(w.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("QUARTERLY spans the calendar quarter, across year ends", () => {
    const q3 = periodWindow("QUARTERLY", at("2026-07-12T00:00:00Z"));
    expect(q3.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(q3.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");

    const q4 = periodWindow("QUARTERLY", at("2026-12-31T23:59:59Z"));
    expect(q4.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(q4.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
