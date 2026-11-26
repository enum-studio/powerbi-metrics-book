import { randomUUID } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import {
  cerbosAccess,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import {
  fileUnder,
  id,
  metricIn,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import { startOAuth, toolAnswer } from "../../../test/sign-in-support.js";
import { term } from "../../db/schema/book.js";
import { assignRole } from "../auth/roles.js";
import { createKey, createServiceAccount } from "../auth/service-accounts.js";
import { readVisibleEvents } from "../events/feed.js";
import * as threads from "./threads.js";

useMirror();
const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
const context = { ...oauth.deps, principal: principals.admin };
const input = {
  kind: "question",
  element: { kind: "dataset", id: id.sales },
  title: "Which period?",
  body: "Sample question.",
} as const;
let adminHeaders: Record<string, string>;
let accountHeaders: Record<string, string>;
let mcpHeaders: Record<string, string>;
let threadId: string;
let replyId: string;
const targets: { tool: string; route: string; argument: string; id: string }[] =
  [];

beforeAll(async () => {
  const person = await oauth.person();
  await assignRole(
    context.db,
    { role: "admin", subject_kind: "person", subject: person.email },
    principals.admin,
  );
  adminHeaders = {
    cookie: person.cookie,
    origin: TEST_PUBLIC_BASE_URL,
    "content-type": "application/json",
  };
  mcpHeaders = {
    authorization: `Bearer ${(await oauth.connect(person.cookie, oauth.client())).access_token}`,
    "content-type": "application/json",
  };
  const name = `questions_${randomUUID().slice(0, 8)}`;
  await createServiceAccount(context, {
    name,
    owner_email: "sample@example.test",
    roles: ["viewer"],
    workspace_ids: [id.sales_workspace],
  });
  accountHeaders = {
    authorization: `Bearer ${(await createKey(context, name, { expires_in_days: 7 })).key}`,
    "content-type": "application/json",
  };
  // Keep existing, answered threads while the feature is switched off.
  await settings.set("questions.enabled", true);
  const metricId = await metricIn(context.db, name);
  await fileUnder(context.db, metricId, id.net_sales);
  const [created] = await context.db.insert(term).values({ name }).returning();
  if (created === undefined) throw new Error("Sample term was not created.");
  for (const [kind, targetId] of [
    ["metric", metricId],
    ["dataset", id.sales],
    ["term", created.id],
  ] as const) {
    const question = await threads.postThread(context, {
      ...input,
      element: { kind, id: targetId },
    });
    const answer = await threads.reply(context, question.id, "Sample answer.");
    await threads.acceptReply(context, question.id, answer.id);
    threadId = question.id;
    replyId = answer.id;
    targets.push({
      tool: `get_${kind}`,
      route: `${kind}s/${targetId}`,
      argument: kind === "dataset" ? "id" : "name",
      id: targetId,
    });
  }
  await settings.set("questions.enabled", false);
});

const rpc = async (method: string, params?: unknown) =>
  oauth.request("/api/mcp", {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

it("refuses every thread route after checking credentials, for existing and missing ids", async () => {
  for (const target of [threadId, randomUUID()]) {
    const routes = [
      ["GET", "/threads"],
      ["POST", "/threads", input],
      ["GET", `/threads/${target}`],
      ["POST", `/threads/${target}/replies`, { body: "Sample reply." }],
      ["POST", `/threads/${target}/accept`, { reply_id: replyId }],
      ["POST", `/threads/${target}/archive`],
      ["PUT", `/threads/${target}/upvote`],
      ["DELETE", `/threads/${target}/upvote`],
    ] as const;
    for (const [method, route, body] of routes) {
      for (const headers of [
        adminHeaders,
        accountHeaders,
        { "content-type": "application/json" },
      ]) {
        const response = await oauth.request(`/api/v1${route}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(response.status).toBe(
          "authorization" in headers || "cookie" in headers ? 404 : 401,
        );
        if (response.status === 404)
          expect(await response.json()).toEqual({
            error: "questions_off",
            message:
              "Questions are off. An admin turns them on under Settings, General.",
          });
      }
    }
  }
});

it("refuses all service entry points before authorization or reads", async () => {
  const requireAccess = vi.spyOn(context.access, "require");
  const describe = vi.spyOn(context.access, "describableDatasets");
  for (const target of [threadId, randomUUID()]) {
    for (const call of [
      () => threads.postThread(context, input),
      () => threads.reply(context, target, "Sample reply."),
      () => threads.getThread(context, target),
      () => threads.listThreads(context),
      () => threads.acceptReply(context, target, replyId),
      () => threads.archiveThread(context, target),
      () => threads.setUpvote(context, target, true),
    ])
      await expect(call()).rejects.toMatchObject({ kind: "questions_off" });
  }
  expect(requireAccess).not.toHaveBeenCalled();
  expect(describe).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("lists 28 tools and treats all six hidden tools exactly as unknown names", async () => {
  const listed = (await (await rpc("tools/list")).json()) as {
    result: { tools: { name: string }[] };
  };
  expect(listed.result.tools).toHaveLength(28);
  for (const name of [
    "post_thread",
    "reply_in_thread",
    "get_thread",
    "list_threads",
    "accept_reply",
    "set_upvote",
    "missing_tool",
  ]) {
    const called: unknown = await (
      await rpc("tools/call", { name, arguments: {} })
    ).json();
    expect(called).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: `There is no tool named ${JSON.stringify(name)}. Call tools/list.`,
      },
    });
  }
});

it("omits question fields from MCP and REST reads with accepted answers stored", async () => {
  for (const target of targets) {
    const answer = await toolAnswer(
      await rpc("tools/call", {
        name: target.tool,
        arguments: { [target.argument]: target.id },
      }),
    );
    const response = await oauth.request(`/api/v1/${target.route}`, {
      headers: accountHeaders,
    });
    expect(response.status).toBe(200);
    for (const read of [answer, await response.json()]) {
      expect(read).not.toHaveProperty("open_questions");
      expect(read).not.toHaveProperty("accepted_answers");
    }
  }
});

it("reports questions off and omits the thread instructions", async () => {
  expect(
    await toolAnswer(await rpc("tools/call", { name: "whoami" })),
  ).toHaveProperty("questions", false);
  const me = await oauth.request("/api/v1/me", { headers: accountHeaders });
  expect(await me.json()).toHaveProperty("questions", false);
  const initialized = (await (await rpc("initialize")).json()) as {
    result: { instructions: string };
  };
  expect(initialized.result.instructions).not.toContain("Its thread tools");
});

it("hides stored thread events and preserves the same thread when enabled again", async () => {
  const query = {
    after: 0,
    kinds: ["thread.created", "thread.answered"] as const,
  };
  expect(await readVisibleEvents(context, query)).toEqual([]);
  await settings.set("questions.enabled", true);
  try {
    const listed = (await (await rpc("tools/list")).json()) as {
      result: { tools: unknown[] };
    };
    expect(listed.result.tools).toHaveLength(34);
    expect(
      await toolAnswer(await rpc("tools/call", { name: "whoami" })),
    ).toHaveProperty("questions", true);
    expect(await threads.getThread(context, threadId)).toMatchObject({
      id: threadId,
      accepted_reply_id: replyId,
    });
    expect(
      (await readVisibleEvents(context, query)).some(
        (event) => event.element_id === threadId,
      ),
    ).toBe(true);
  } finally {
    await settings.set("questions.enabled", false);
  }
});
