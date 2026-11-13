import { describe, expect, it } from "vitest";
import type { Me } from "../api/me";
import { actionWords, changedFields, mayCurate } from "./format";

const me = {
  id: "a0000000-0000-4000-8000-000000000002",
  name: "Analyst",
  email: "analyst@sample.example",
  roles: ["curator"],
} as Me;

describe("changedFields", () => {
  it("names the fields that differ by the page's words, with both values when short, and skips bookkeeping", () => {
    const before = { unit: "money", definition: "x".repeat(80), updated_at: 1 };
    const after = { unit: "count", definition: "y".repeat(80), updated_at: 2 };
    expect(changedFields(before, after)).toEqual([
      { field: "unit", name: "Unit", from: "money", to: "count" },
      {
        field: "definition",
        name: "Definition",
        from: null,
        to: "y".repeat(80),
      },
    ]);
  });

  it("says a trust and a category in words, and leaves out who verified it", () => {
    const category = "c0000000-0000-4000-8000-000000000001";
    const before = {
      trust_state: "draft",
      verified_by: null,
      category_id: null,
    };
    const after = {
      trust_state: "agent_verified",
      verified_by: "pX5jatu6",
      category_id: category,
    };
    expect(
      changedFields(before, after, (id) =>
        id === category ? "Sales / Orders" : undefined,
      ),
    ).toEqual([
      {
        field: "trust_state",
        name: "Trust",
        from: "Draft",
        to: "Checked by an agent",
      },
      {
        field: "category_id",
        name: "Category",
        from: "not set",
        to: "Sales / Orders",
      },
    ]);
  });

  it("never shows a category's id it cannot name", () => {
    expect(
      changedFields({ category_id: null }, { category_id: "c0000000" }),
    ).toEqual([
      {
        field: "category_id",
        name: "Category",
        from: "not set",
        to: "a category no longer listed",
      },
    ]);
  });

  it("reads a missing side as no change list", () => {
    expect(changedFields(null, { unit: "count" })).toEqual([]);
  });
});

describe("actionWords", () => {
  it("says what a change did, and falls back to the action in lower case", () => {
    expect(actionWords("verify")).toBe("checked it");
    expect(actionWords("pii_changed")).toBe("pii changed");
  });
});

describe("mayCurate", () => {
  it("holds for a curator and not for a viewer", () => {
    expect(mayCurate(me)).toBe(true);
    expect(mayCurate({ ...me, roles: ["viewer"] })).toBe(false);
  });
});
