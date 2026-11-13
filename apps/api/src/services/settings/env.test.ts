import { describe, expect, it } from "vitest";
import { environmentVariable, readEnvironment } from "./env.js";
import { OKTA_PROVIDER } from "../../../test/settings-fixture.js";
import { SETTING_KEYS } from "./registry.js";

/** The error a call throws; a call that returns fails the test. */
function failureOf(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("the call did not throw");
}

describe("environmentVariable", () => {
  it("upper-cases the key and turns its dots into underscores", () => {
    expect(environmentVariable("powerbi.tenant_id")).toBe("POWERBI_TENANT_ID");
    expect(environmentVariable("powerbi.sync.workspaces.include")).toBe(
      "POWERBI_SYNC_WORKSPACES_INCLUDE",
    );
    expect(environmentVariable("sign_in.passkeys")).toBe("SIGN_IN_PASSKEYS");
  });

  it("gives no two settings the same variable", () => {
    const variables = SETTING_KEYS.map(environmentVariable);
    expect(new Set(variables).size).toBe(variables.length);
  });
});

describe("readEnvironment", () => {
  it("reads text as it is for a string, even when it looks like JSON", () => {
    expect(
      readEnvironment("search.model", { SEARCH_MODEL: "text-embedding-3" }),
    ).toBe("text-embedding-3");
    expect(readEnvironment("search.model", { SEARCH_MODEL: "123" })).toBe(
      "123",
    );
  });

  it("coerces numbers and booleans", () => {
    expect(
      readEnvironment("results.ttl_hours", { RESULTS_TTL_HOURS: "24" }),
    ).toBe(24);
    expect(
      readEnvironment("sign_in.passkeys", { SIGN_IN_PASSKEYS: "true" }),
    ).toBe(true);
  });

  it("reads lists and objects as JSON", () => {
    const workspace = "22222222-2222-4222-8222-222222222222";
    expect(
      readEnvironment("powerbi.sync.workspaces.exclude", {
        POWERBI_SYNC_WORKSPACES_EXCLUDE: `["${workspace}"]`,
      }),
    ).toEqual([workspace]);
    expect(
      readEnvironment("powerbi.sync.workspaces.include", {
        POWERBI_SYNC_WORKSPACES_INCLUDE: "[]",
      }),
    ).toEqual([]);
    expect(
      readEnvironment("sign_in.providers", {
        SIGN_IN_PROVIDERS: JSON.stringify([OKTA_PROVIDER]),
      }),
    ).toHaveLength(1);
  });

  it("reads all as it is written, with or without JSON's quotes", () => {
    for (const text of ["all", '"all"']) {
      expect(
        readEnvironment("powerbi.sync.workspaces.include", {
          POWERBI_SYNC_WORKSPACES_INCLUDE: text,
        }),
      ).toBe("all");
    }
  });

  it.each([
    ["results.ttl_hours", "RESULTS_TTL_HOURS", "soon"],
    ["results.ttl_hours", "RESULTS_TTL_HOURS", "-5"],
    ["sign_in.passkeys", "SIGN_IN_PASSKEYS", "yes"],
    ["powerbi.tenant_id", "POWERBI_TENANT_ID", "my-company"],
    [
      "powerbi.sync.workspaces.exclude",
      "POWERBI_SYNC_WORKSPACES_EXCLUDE",
      "[oops",
    ],
    [
      "powerbi.sync.workspaces.include",
      "POWERBI_SYNC_WORKSPACES_INCLUDE",
      "some",
    ],
  ] as const)(
    "fails naming the variable, and not echoing the value, when %s is given %s=%j",
    (key, variable, text) => {
      const { message } = failureOf(() =>
        readEnvironment(key, { [variable]: text }),
      );
      expect(message).toMatch(
        new RegExp(`^${variable} is not valid for the setting ${key}`),
      );
      // A variable often holds a secret or a person's own text.
      expect(message).not.toContain(text);
    },
  );

  // Left out of the table above: every message contains the empty text.
  it("fails naming the variable when it is empty", () => {
    const { message } = failureOf(() =>
      readEnvironment("powerbi.tenant_id", { POWERBI_TENANT_ID: "" }),
    );
    expect(message).toMatch(
      /^POWERBI_TENANT_ID is not valid for the setting powerbi\.tenant_id/,
    );
  });
});
