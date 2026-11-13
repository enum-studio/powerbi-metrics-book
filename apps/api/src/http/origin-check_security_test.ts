import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  TEST_PUBLIC_BASE_URL,
} from "../../test/deps.js";
import { createApp } from "../app.js";
import { ORIGIN_CHECK_EXEMPT } from "./origin-check.js";

afterAll(closeTestPools);

// /health is public, so a state-changing request there passes the gate and
// meets the origin check. It has no such route: a request the check lets
// through answers 404.
const app = createApp(createTestDeps());

function send(method: string, origin: string | null) {
  return app.request("/health", {
    method,
    headers: origin === null ? {} : { Origin: origin },
  });
}

describe("the origin check", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses a %s with no Origin",
    async (method) => {
      const response = await send(method, null);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "refused",
        message: `This request did not come from ${TEST_PUBLIC_BASE_URL}. Send it from that address, with its Origin header.`,
      });
    },
  );

  it.each([
    ["another site", "https://elsewhere.example.org"],
    [
      "a host that starts like this one",
      "https://metrics.example.com.example.org",
    ],
    ["a subdomain of this one", "https://evil.metrics.example.com"],
    ["plain http", "http://metrics.example.com"],
    ["another port", "https://metrics.example.com:8443"],
    ["an opaque origin", "null"],
    ["the origin with a path", `${TEST_PUBLIC_BASE_URL}/`],
  ])("refuses an Origin from %s", async (_, origin) => {
    expect((await send("POST", origin)).status).toBe(403);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "lets a %s from PUBLIC_BASE_URL's origin through",
    async (method) => {
      expect((await send(method, TEST_PUBLIC_BASE_URL)).status).toBe(404);
    },
  );

  it.each(["GET", "HEAD", "OPTIONS"])(
    "does not ask a %s for an Origin",
    async (method) => {
      expect((await send(method, null)).status).not.toBe(403);
    },
  );

  it("lets a bearer request with no cookie through without an Origin, to be judged by its token", async () => {
    const bearer = { Authorization: "Bearer not-a-real-token" };
    const passed = await app.request("/health", {
      method: "POST",
      headers: bearer,
    });
    expect(passed.status).toBe(404);
    const judged = await app.request("/api/v1/me/grants/sample", {
      method: "DELETE",
      headers: bearer,
    });
    expect(judged.status).toBe(401);
  });

  it("checks a request carrying a cookie, with or without a bearer token", async () => {
    for (const headers of [
      { Cookie: "__Secure-better-auth.session_token=sample" },
      {
        Cookie: "__Secure-better-auth.session_token=sample",
        Authorization: "Bearer not-a-real-token",
      },
    ]) {
      const answer = await app.request("/health", { method: "POST", headers });
      expect(answer.status).toBe(403);
    }
  });

  it("exempts the token, registration and device authorization endpoints only", () => {
    expect(ORIGIN_CHECK_EXEMPT).toEqual([
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/register",
      "/api/auth/device/code",
    ]);
  });
});
