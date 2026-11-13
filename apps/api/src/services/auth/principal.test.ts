import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
  testConfig,
} from "../../../test/deps.js";
import { createApp } from "../../app.js";
import { personPrincipal } from "./principal.js";
import { assignRole } from "./roles.js";

afterAll(closeTestPools);

const deps = createTestDeps({
  config: testConfig("api", { ALLOW_DEV_SIGN_IN: "1" }),
});
const app = createApp(deps);
const run = randomUUID().slice(0, 8);
const ROLES = ["viewer", "curator", "admin"] as const;
const emailOf = (role: string) => `principal-${role}-${run}@example.test`;

beforeAll(async () => {
  for (const role of ROLES)
    await assignRole(
      deps.db,
      { role, subject_kind: "person", subject: emailOf(role) },
      principals.admin,
    );
});

async function signedIn(email: string): Promise<string> {
  const response = await app.request("/api/auth/dev/sign-in", {
    method: "POST",
    headers: {
      origin: TEST_PUBLIC_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

describe("GET /api/v1/me", () => {
  it.each(ROLES)(
    "answers a person holding %s with who they are",
    async (role) => {
      const response = await app.request("/api/v1/me", {
        headers: { cookie: await signedIn(emailOf(role)) },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        email: emailOf(role),
        roles: [role],
        sign_in_method: "dev",
        powerbi_connection: "not_connected",
      });
    },
  );

  it("answers 401 without a session, and with a cookie that names none", async () => {
    for (const cookie of [
      undefined,
      "__Secure-better-auth.session_token=forged.value",
    ]) {
      const response = await app.request(
        "/api/v1/me",
        cookie === undefined ? {} : { headers: { cookie } },
      );
      expect(response.status, String(cookie)).toBe(401);
    }
  });

  it("refuses a dev sign-in for a person no assignment reaches, so no session is made", async () => {
    const response = await app.request("/api/auth/dev/sign-in", {
      method: "POST",
      headers: {
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: `nobody-${run}@example.test` }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie().join(";")).not.toMatch(
      /session_token=[^;]/,
    );
  });
});

describe("personPrincipal", () => {
  it("builds a person, however they came, with the roles that reach them now and the attributes Cerbos needs", async () => {
    const person = {
      id: `user-${run}`,
      email: emailOf("curator"),
      email_verified: true,
    };
    const principal = await personPrincipal(deps, person, {
      via: "mcp",
      client_id: "https://client.example.com/metadata.json",
    });
    expect(principal).toEqual({
      kind: "person",
      id: `user-${run}`,
      roles: ["curator"],
      attributes: {
        powerbi_workspace_ids: [],
        powerbi_app_ids: [],
        powerbi_dataset_ids: [],
      },
      via: "mcp",
      client_id: "https://client.example.com/metadata.json",
    });
    const unverified = { ...person, email_verified: false };
    expect(
      (await personPrincipal(deps, unverified, { via: "cli", client_id: null }))
        .roles,
    ).toEqual([]);
  });
});
