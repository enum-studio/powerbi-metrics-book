import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { fieldError, reference, ruleInput, viaWords, type Rule } from "./api";

describe("PII rules", () => {
  it("restores only rule input, never the previous actor's attribution", () => {
    const rule: Rule = {
      kind: "table",
      table_name: "Customer",
      name: null,
      pii: true,
      note: "Reviewed",
      id: "rule-id",
      set_by_kind: "person",
      set_by_id: "admin-b",
      set_via: "browser",
      set_at: "2026-10-27T10:00:00.000Z",
      version: "rule-id:2026-10-27T10:00:00.000Z",
      columns: 3,
      datasets: 2,
    };
    expect(ruleInput(rule)).toEqual({
      kind: "table",
      table: "Customer",
      pii: true,
      note: "Reviewed",
    });
  });
  it("quotes table and column references as DAX", () => {
    expect(reference("Customer", null)).toBe("'Customer'");
    expect(reference("Shop's customer", "Email]")).toBe(
      "'Shop''s customer'[Email]]]",
    );
  });
  it("uses the server's channel in the attribution", () => {
    expect(["browser", "cli", "mcp", "api"].map(viaWords)).toEqual([
      "in the browser",
      "with the CLI",
      "through an agent",
      "through the API",
    ]);
  });
  it("places the API's field refusals under their fields without inventing validation", () => {
    for (const [message, field] of [
      ["The table_name has leading or trailing whitespace.", "table"],
      ["A column rule needs a name.", "name"],
      ["The request is not valid (note: Too big).", "note"],
      ["The request is not valid (table: Too small).", "table"],
    ] as const)
      expect(fieldError(new ApiError(400, "invalid", message))).toBe(field);
    expect(
      fieldError(new ApiError(403, "refused", "You cannot manage PII.")),
    ).toBeNull();
  });
});
