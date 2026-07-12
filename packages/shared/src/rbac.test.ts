import { describe, expect, it } from "vitest";
import { can, hasMinimumRole } from "./rbac.js";

describe("hasMinimumRole", () => {
  it("orders roles OWNER > ADMIN > MEMBER > VIEWER", () => {
    expect(hasMinimumRole("OWNER", "ADMIN")).toBe(true);
    expect(hasMinimumRole("ADMIN", "OWNER")).toBe(false);
    expect(hasMinimumRole("MEMBER", "MEMBER")).toBe(true);
    expect(hasMinimumRole("VIEWER", "MEMBER")).toBe(false);
  });
});

describe("can", () => {
  it("only OWNER manages the workspace", () => {
    expect(can("OWNER", "workspace.manage")).toBe(true);
    expect(can("ADMIN", "workspace.manage")).toBe(false);
  });

  it("MEMBER can issue keys but not manage budgets", () => {
    expect(can("MEMBER", "keys.issue")).toBe(true);
    expect(can("MEMBER", "budgets.manage")).toBe(false);
  });

  it("VIEWER can view analytics only", () => {
    expect(can("VIEWER", "analytics.view")).toBe(true);
    expect(can("VIEWER", "keys.issue")).toBe(false);
  });
});
