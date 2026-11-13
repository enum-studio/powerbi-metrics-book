import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  TEST_PUBLIC_BASE_URL,
  testConfig,
} from "../../test/deps.js";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { MAX_BODY_BYTES } from "./security-headers.js";

afterAll(closeTestPools);

const EXPECTED = {
  "content-security-policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function appAt(publicBaseUrl: string) {
  const config: Config = {
    ...testConfig("api"),
    public_base_url: new URL(publicBaseUrl),
  };
  return createApp(createTestDeps({ config }));
}

function headersOf(response: Response): Record<string, string | null> {
  return Object.fromEntries(
    Object.keys(EXPECTED).map((name) => [name, response.headers.get(name)]),
  );
}

describe("the security headers", () => {
  const app = appAt(TEST_PUBLIC_BASE_URL);

  it.each([
    ["a public route", "/health", 200],
    ["a request the gate turns away", "/api/v1/metrics", 401],
  ])("are on %s", async (_, path, status) => {
    const response = await app.request(path);
    expect(response.status).toBe(status);
    expect(headersOf(response)).toEqual(EXPECTED);
  });

  it("are on an answer from the error handler", async () => {
    const failing = appAt(TEST_PUBLIC_BASE_URL);
    failing.put("/health", () => {
      throw new Error("boom");
    });
    const response = await failing.request("/health", {
      method: "PUT",
      headers: { Origin: TEST_PUBLIC_BASE_URL },
    });
    expect(response.status).toBe(500);
    expect(headersOf(response)).toEqual(EXPECTED);
  });

  it("send no referrer from setup, its API and set-password", async () => {
    for (const path of [
      "/setup",
      "/set-password",
      "/setup/scanner",
      "/api/setup",
      "/api/setup/session",
    ])
      expect(
        (await app.request(path)).headers.get("referrer-policy"),
        path,
      ).toBe("no-referrer");
    expect((await app.request("/setupx")).headers.get("referrer-policy")).toBe(
      "same-origin",
    );
  });

  it.each(["/api/setup", "/api/setup/session", "/api/setup/unknown"])(
    "never caches setup responses at %s, including early rejections",
    async (path) => {
      expect((await app.request(path)).headers.get("cache-control")).toBe(
        "no-store",
      );
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Length": String(MAX_BODY_BYTES + 1) },
        body: "x",
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("leave out HSTS when the public address is plain http", async () => {
    const response = await appAt("http://localhost:3000").request("/health");
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("the body limit", () => {
  const oversized = "x".repeat(MAX_BODY_BYTES + 1);

  it("answers 413 to a body declared over 1 MiB, ahead of the gate", async () => {
    const response = await appAt(TEST_PUBLIC_BASE_URL).request(
      "/api/v1/metrics",
      {
        method: "POST",
        headers: {
          Origin: TEST_PUBLIC_BASE_URL,
          "Content-Length": String(oversized.length),
        },
        body: oversized,
      },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "invalid",
      message: "The request body is larger than 1 MiB.",
    });
    expect(headersOf(response)).toEqual(EXPECTED);
  });

  it("stops a streamed body with no length once a handler reads past 1 MiB", async () => {
    const app = appAt(TEST_PUBLIC_BASE_URL);
    let read = false;
    app.put("/health", async (c) => {
      await c.req.text();
      read = true;
      return c.text("read");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const response = await app.request("/health", {
      method: "PUT",
      headers: { Origin: TEST_PUBLIC_BASE_URL },
      body,
      duplex: "half",
    });
    expect(response.status).toBe(413);
    expect(read).toBe(false);
  });
});
