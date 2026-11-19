import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  closeTestPools,
  createTestDeps,
  describesNothing,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../test/deps.js";
import { fromSpa, startOAuth, toolAnswer } from "../../test/sign-in-support.js";
import type { AppEnv } from "../app.js";
import { user } from "../db/schema/auth.js";
import { createLogger } from "../log.js";
import { getConventionsForAgents } from "../services/conventions/service.js";
import { setConventions } from "../services/conventions/store.js";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
} from "./protocol.js";
import { defineTool } from "./registry.js";
import { instructionsFor, mcpRoutes } from "./server.js";
import { TOOLS } from "./tools/index.js";

afterAll(closeTestPools);

const f = startOAuth();
let token = "";

beforeAll(async () => {
  await f.deps.settings.set("questions.enabled", true, principals.admin);
  const { cookie } = await f.person();
  token = (await f.connect(cookie, f.client())).access_token;
});

/** POST /api/mcp as an MCP client sends it: a bearer token, no cookie, no Origin. */
const post = (body: unknown, headers: Record<string, string> = {}) =>
  f.request("/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const call = (id: number, method: string, parameters?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(parameters === undefined ? {} : { params: parameters }),
});

const conventions = () => getConventionsForAgents(f.deps);

/** Runs `check` with the stack pointed at the mock, as the sample deployment is, and puts the authority back. */
async function onTheMockAuthority(
  check: () => Promise<void>,
  on = f,
): Promise<void> {
  const authority = await on.deps.settings.get("powerbi.authority");
  await on.deps.settings.set(
    "powerbi.authority",
    "http://powerbi-mock.localhost:3001",
    principals.admin,
  );
  try {
    await check();
  } finally {
    await on.deps.settings.set(
      "powerbi.authority",
      authority,
      principals.admin,
    );
  }
}

const SAMPLE_PARAGRAPH =
  "This deployment runs on the invented sample tenant. Every name and number is sample data, not the company's; say so when you report one.";

describe("tools/call", () => {
  it("answers a tool the registry does not hold with a JSON-RPC error and nothing else", async () => {
    const answer = await post(
      call(1, "tools/call", { name: "drop_book", arguments: {} }),
    );
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: INVALID_PARAMS,
        message: 'There is no tool named "drop_book". Call tools/list.',
      },
    });
  });
});

describe("the JSON-RPC envelope", () => {
  it("answers initialize with the version asked for, the tools capability and the instructions", async () => {
    const answer = await post(
      call(1, "initialize", { protocolVersion: "2025-11-25" }),
    );
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const { result } = (await answer.json()) as {
      result: { instructions: string };
    };
    expect(result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "powerbi-metrics-book" },
    });
    const [opening = ""] = (await conventions()).guide.split("\n\n");
    expect(result.instructions.split("\n\n")).toEqual([
      expect.stringContaining("never changes a definition"),
      expect.stringContaining("Search the book before you write DAX"),
      `${opening.trim()} Call get_conventions for the rest.`,
    ]);
  });

  it("opens with the sample paragraph on the sample tenant and not otherwise", () => {
    const guide = "Name metrics the way the business speaks.\n\nThe rest.";
    const sample = instructionsFor(guide, true, true).split("\n\n");
    const real = instructionsFor(guide, false, true).split("\n\n");
    expect(sample[0]).toBe(SAMPLE_PARAGRAPH);
    expect(sample.slice(1)).toEqual(real);
    expect(real).toEqual([
      expect.stringContaining("never changes a definition"),
      expect.stringContaining("Search the book before you write DAX"),
      "Name metrics the way the business speaks. Call get_conventions for the rest.",
    ]);
  });

  it("opens the instructions with the sample paragraph when the authority is the mock", async () => {
    await onTheMockAuthority(async () => {
      const answer = await post(call(1, "initialize", {}));
      const { result } = (await answer.json()) as {
        result: { instructions: string };
      };
      expect(result.instructions.split("\n\n")).toHaveLength(4);
      expect(result.instructions.startsWith(SAMPLE_PARAGRAPH)).toBe(true);
    });
  });

  it("falls back to its newest version when the client asks for one it does not know", async () => {
    for (const asked of [{ protocolVersion: "1999-01-01" }, {}]) {
      const answer = await post(call(1, "initialize", asked));
      expect(await answer.json()).toMatchObject({
        result: { protocolVersion: "2026-07-28" },
      });
    }
  });

  it("cuts the guide's opening at the last sentence within 1,000 characters, or at 1,000 when none ends there", async () => {
    const sentence = "Every metric here is named the way our business speaks. ";
    const word = "x".repeat(1500);
    const cases = [
      [sentence.repeat(30), sentence.repeat(17).trim()],
      [word, `${word.slice(0, 997)}...`],
    ];
    try {
      for (const [opening = "", expected = ""] of cases) {
        await setConventions(f.deps, principals.admin, {
          preset: "metrics_book",
          guide: `${opening}\n\n## Metric keys\n\nThe rest.`,
        });
        const answer = await post(call(1, "initialize", {}));
        const { result } = (await answer.json()) as {
          result: { instructions: string };
        };
        const [, , conventions] = result.instructions.split("\n\n");
        expect(conventions).toBe(
          `${expected} Call get_conventions for the rest.`,
        );
        expect(expected.length).toBeLessThanOrEqual(1000);
      }
    } finally {
      await setConventions(f.deps, principals.admin, {
        preset: "metrics_book",
      });
    }
  });

  it("lists every registered tool with an object input schema", async () => {
    const answer = await post(call(1, "tools/list"));
    const { result } = (await answer.json()) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };
    expect(result.tools.map(({ name }) => name)).toEqual(
      TOOLS.map(({ name }) => name),
    );
    for (const { inputSchema } of result.tools)
      expect(inputSchema.type).toBe("object");
  });

  it("answers ping, refuses a method it does not have, and takes a notification with 202 and no body", async () => {
    expect(await (await post(call(1, "ping"))).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    expect(await (await post(call(2, "resources/list"))).json()).toMatchObject({
      error: { code: METHOD_NOT_FOUND },
    });
    const notified = await post({ jsonrpc: "2.0", method: "notifications/x" });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");
  });

  it("refuses a body that is not JSON, and one that is not a JSON-RPC message", async () => {
    const notJson = await post("{");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({
      error: { code: PARSE_ERROR },
    });
    for (const body of [
      [],
      { id: 1, method: "ping" },
      [call(1, "ping"), { jsonrpc: "1.0" }],
    ]) {
      const refused = await post(body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: { code: INVALID_REQUEST },
      });
    }
  });

  it("answers a batch with one reply per request, in order, and refuses 21 messages", async () => {
    const twenty = Array.from({ length: 20 }, (_, index) =>
      call(index, "ping"),
    );
    const notification = { jsonrpc: "2.0", method: "notifications/x" };
    const answered = await post([...twenty.slice(0, 19), notification]);
    const replies = (await answered.json()) as { id: number }[];
    expect(replies.map(({ id }) => id)).toEqual([...Array(19).keys()]);
    expect((await post(twenty)).status).toBe(200);
    const refused = await post([...twenty, call(20, "ping")]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: INVALID_REQUEST,
        message: "Send one JSON-RPC 2.0 message, or an array of 1 to 20.",
      },
    });
  });

  it("refuses a body over 1 MiB with 413", async () => {
    const pad = "x".repeat(1024 * 1024);
    const big = call(1, "tools/call", { name: "whoami", arguments: { pad } });
    expect((await post(big)).status).toBe(413);
  });

  it("answers a tool that threw with a fixed sentence and the request id, and logs a failed query without its parameters", async () => {
    const lines: string[] = [];
    const deps = createTestDeps({
      logger: createLogger("error", (line) => lines.push(line)),
    });
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("request_id", "request-1");
      c.set("principal", { ...principals.viewer, via: "mcp", client_id: "c" });
      await next();
    });
    const marker = `marker-${randomUUID()}`;
    const row = { id: marker, name: marker, email: `${marker}@example.com` };
    const broken = defineTool({
      name: "broken",
      description: "Inserts one row twice.",
      input: z.strictObject({}),
      handler: async ({ db }) => db.insert(user).values([row, row]),
    });
    app.route("/api/mcp", mcpRoutes(deps, [broken]));
    const answer = await app.request("/api/mcp", {
      method: "POST",
      body: JSON.stringify(call(7, "tools/call", { name: "broken" })),
    });
    expect(await answer.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: INTERNAL_ERROR,
        message:
          "The server could not answer tools/call. Quote request request-1 to whoever runs it.",
      },
    });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        msg: "mcp message failed",
        request_id: "request-1",
        method: "tools/call",
        tool: "broken",
        code: "23505",
      }),
    ]);
    expect(lines.join("\n")).not.toContain(marker);
  });
});

describe("the first tools", () => {
  it("answers whoami with the person behind the token, their roles and their Power BI connection", async () => {
    const g = startOAuth({ access: describesNothing() });
    const { id, cookie } = await g.person();
    const client = g.client();
    const own = (await g.connect(cookie, client)).access_token;
    expect(await toolAnswer(await g.whoami(own))).toEqual({
      id,
      kind: "person",
      roles: ["viewer"],
      via: "mcp",
      client_id: client.client_id,
      powerbi_connection: "not_connected",
      powerbi_connect_url: `${TEST_PUBLIC_BASE_URL}/settings/connections`,
      sample_data: false,
      questions: false,
      usage: { capture: true, retention_days: 180 },
      book_metrics: { draft: 0, agent_verified: 0, human_verified: 0 },
      conventions: { rules_off: 0, exceptions: 0 },
    });
  });

  it("answers whoami with changed usage settings", async () => {
    const g = startOAuth({ access: describesNothing() });
    const { cookie } = await g.person();
    const own = (await g.connect(cookie, g.client())).access_token;
    await g.deps.settings.set("usage.capture", false, principals.admin);
    await g.deps.settings.set("usage.retention_days", 30, principals.admin);
    await g.deps.settings.set("questions.enabled", true, principals.admin);
    expect(await toolAnswer(await g.whoami(own))).toMatchObject({
      usage: { capture: false, retention_days: 30 },
      questions: true,
    });
  });

  it("describes search as words always and meaning only when embeddings are set", () => {
    const search = TOOLS.find((tool) => tool.name === "search");
    expect(search?.description).toContain(
      "by meaning only when embeddings are set",
    );
    expect(search?.description).toContain("search_mode says which ran");
    expect(search?.description).not.toContain("by what you mean");
  });

  it("says in the instructions what draft and the verified states mean, and what the thread tools do", () => {
    const [first = ""] = instructionsFor("Guide.", false, true).split("\n\n");
    expect(first).toContain("The sync and curators draft metrics");
    expect(first).toContain("only human_verified was approved by a person");
    expect(first).toContain(
      "post, reply, upvote and accept on your own question",
    );
    expect(first).not.toContain("which curators answer");
    expect(first).not.toContain("curated");
    expect(instructionsFor("Guide.", false, true)).toContain(
      "your searches and the requests you record are kept",
    );
  });

  it("answers whoami with sample_data true once the authority is the mock", async () => {
    const g = startOAuth({ access: describesNothing() });
    const { cookie } = await g.person();
    const own = (await g.connect(cookie, g.client())).access_token;
    await onTheMockAuthority(async () => {
      expect(await toolAnswer(await g.whoami(own))).toMatchObject({
        sample_data: true,
      });
    }, g);
  });

  it("answers get_conventions with the conventions in force", async () => {
    const answer = await post(
      call(1, "tools/call", { name: "get_conventions", arguments: {} }),
    );
    expect(await toolAnswer(answer)).toEqual(
      JSON.parse(JSON.stringify(await conventions())),
    );
  });
});

describe("who may call", () => {
  it("answers 401 with resource_metadata to a request with no credential", async () => {
    const refused = await f.request("/api/mcp", {
      method: "POST",
      body: JSON.stringify(call(1, "ping")),
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${TEST_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });

  it("refuses a browser session, which is not an MCP client's token", async () => {
    const { cookie } = await f.person();
    const refused = await f.request(
      "/api/mcp",
      fromSpa(cookie, call(1, "ping")),
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "unauthenticated" });
    expect(refused.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("answers 405 to any other method once the token is taken, and 401 before", async () => {
    const authorization = `Bearer ${token}`;
    for (const method of ["GET", "DELETE"]) {
      const refused = await f.request("/api/mcp", {
        method,
        headers: { authorization },
      });
      expect(refused.status, method).toBe(405);
      expect(refused.headers.get("allow"), method).toBe("POST");
    }
    expect((await f.request("/api/mcp")).status).toBe(401);
  });
});
