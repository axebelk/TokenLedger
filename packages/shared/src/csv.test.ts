import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "./csv.js";

describe("csvCell", () => {
  it("passes plain values through", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(true)).toBe("true");
  });
  it("renders null/undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("quotes and escapes when needed", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("csvRow", () => {
  it("joins cells with commas, escaping each", () => {
    expect(csvRow(["a", 1, "x,y", null])).toBe('a,1,"x,y",');
  });
});
