import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  closeTestPools,
  createTestDeps,
  TEST_PUBLIC_BASE_URL,
} from "../../test/deps.js";
import { createApp } from "../app.js";
import { user } from "../db/schema/auth.js";
import { ServiceError } from "../errors.js";
import { createLogger } from "../log.js";
import { parseAnswer } from "../powerbi/errors.js";

afterAll(closeTestPools);

describe("logError, under app.ts's onError", () => {
  it("logs upstream issue paths with the request id, without the rejected value", async () => {
    const lines: string[] = [];
    const deps = createTestDeps({
      logger: createLogger("error", (line) => lines.push(line)),
    });
    const app = createApp(deps);
    const marker = `marker-${randomUUID()}`;
    app.put("/health", (c) => {
      if (c.req.query("plain")) throw new ServiceError("upstream", marker);
      parseAnswer(z.object({ oid: z.number() }), { oid: marker }, "Identity");
      return new Response(null, { status: 204 });
    });
    const answer = await app.request("/health", {
      method: "PUT",
      headers: { Origin: TEST_PUBLIC_BASE_URL },
    });
    expect(answer.status).toBe(502);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "error",
      request_id: answer.headers.get("x-request-id"),
      issues: '[["oid"]]',
    });
    expect(lines.join("\n")).not.toContain(marker);
    expect(await answer.text()).not.toContain("issues");
    const plain = await app.request("/health?plain=1", {
      method: "PUT",
      headers: { Origin: TEST_PUBLIC_BASE_URL },
    });
    expect(plain.status).toBe(502);
    expect(lines).toHaveLength(1);
  });

  it("logs a failed insert as Postgres's error and where it ran, never its parameters", async () => {
    const lines: string[] = [];
    const deps = createTestDeps({
      logger: createLogger("error", (line) => lines.push(line)),
    });
    // Stands for a token's ciphertext or a PKCE verifier in a parameter.
    const marker = `marker-${randomUUID()}`;
    const row = { id: marker, name: marker, email: `${marker}@example.com` };
    await deps.db.insert(user).values(row);
    const app = createApp(deps);
    // /health is public, so a PUT route added there is reached past the gate.
    app.put("/health", async () => {
      await deps.db.insert(user).values(row);
      return new Response(null, { status: 204 });
    });
    const answer = await app.request("/health", {
      method: "PUT",
      headers: { Origin: TEST_PUBLIC_BASE_URL },
    });
    expect(answer.status).toBe(500);
    expect(await answer.text()).toBe('{"error":"internal"}');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      msg: "unhandled error",
      request_id: answer.headers.get("x-request-id"),
      error: "DatabaseError",
      message: 'duplicate key value violates unique constraint "user_pkey"',
      code: "23505",
      constraint: "user_pkey",
      stack: expect.stringContaining("error-log.test.ts") as string,
    });
    expect(lines.join("\n")).not.toContain(marker);
  });
});
