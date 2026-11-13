import { HTTPException } from "hono/http-exception";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  TEST_PUBLIC_BASE_URL,
} from "../test/deps.js";
import { createApp } from "./app.js";
import { type ErrorKind, ServiceError } from "./errors.js";
import { createLogger } from "./log.js";

afterAll(closeTestPools);

function appLogging(lines: string[], pool?: pg.Pool) {
  return createApp(
    createTestDeps({
      logger: createLogger("info", (line) => lines.push(line)),
      ...(pool === undefined ? {} : { pool }),
    }),
  );
}

function messages(lines: string[]): string[] {
  return lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
}

describe("GET /health", () => {
  it("answers 200 with the version and git sha when select 1 answers through api_rw", async () => {
    const response = await createApp(createTestDeps()).request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      version: "0.1.0",
      git_sha: "3b5aa24",
    });
  });

  it("answers 503 when the database is unreachable", async () => {
    const unreachable = new pg.Pool({
      // Port 9, the discard port: nothing listens on it, so the connection is refused.
      connectionString:
        "postgresql://api_rw:x@127.0.0.1:9/powerbi_metrics_book",
    });
    try {
      const lines: string[] = [];
      const response = await appLogging(lines, unreachable).request("/health");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false });
      expect(messages(lines)).toContain("health check failed");
    } finally {
      await unreachable.end();
    }
  });
});

describe("the request log", () => {
  it("writes one JSON line per request with method, path, status, duration and request id, and nothing it was sent", async () => {
    const lines: string[] = [];
    const response = await appLogging(lines).request(
      "/api/v1/metrics?token=query-secret",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer header-secret",
          Cookie: "session=cookie-secret",
        },
        body: "body-secret",
      },
    );
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual([
      "duration_ms",
      "level",
      "method",
      "msg",
      "path",
      "request_id",
      "status",
      "time",
    ]);
    expect(line).toMatchObject({
      level: "info",
      msg: "request",
      method: "POST",
      path: "/api/v1/metrics",
      status: 401,
    });
    expect(line.request_id).toBe(response.headers.get("x-request-id"));
    expect(lines[0]).not.toMatch(/secret/);
  });
});

describe("the error handler", () => {
  /** /health is public, so a PUT route added there is reached past the gate. */
  function appThrowing(error: Error, lines: string[] = []) {
    const app = appLogging(lines);
    app.put("/health", () => {
      throw error;
    });
    return () =>
      app.request("/health", {
        method: "PUT",
        headers: { Origin: TEST_PUBLIC_BASE_URL },
      });
  }

  it.each<[ErrorKind, number]>([
    ["unauthenticated", 401],
    ["refused", 403],
    ["not_found", 404],
    ["invalid", 400],
    ["conflict", 409],
    ["rate_limited", 429],
    ["needs_connection", 409],
    ["upstream", 502],
  ])(
    "answers a ServiceError of kind %s with %i, its kind and its message, and not its detail",
    async (kind, status) => {
      const request = appThrowing(
        new ServiceError(kind, "Reconnect Power BI.", {
          token: "detail-secret",
        }),
      );
      const response = await request();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: kind,
        message: "Reconnect Power BI.",
      });
    },
  );

  it("answers an HTTPException with its own response", async () => {
    const response = await appThrowing(
      new HTTPException(418, { message: "short and stout" }),
    )();
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("short and stout");
  });

  it("logs anything else and answers 500 without a word about it", async () => {
    const lines: string[] = [];
    const response = await appThrowing(
      new Error("connection string with a password"),
      lines,
    )();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(messages(lines)).toContain("unhandled error");
  });
});
