import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { assignRole } from "../../services/auth/roles.js";

/*
 * The threads routes through the whole app: a viewer asks, a curator answers
 * and accepts the answer, both signed in through the dev sign-in.
 */

afterAll(closeTestPools);

const settings = new MemorySettings();
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });

async function person(role: "viewer" | "curator") {
  const signedIn = await oauth.person();
  if (role === "curator")
    await assignRole(
      oauth.deps.db,
      { role, subject_kind: "person", subject: signedIn.email },
      principals.admin,
    );
  return {
    cookie: signedIn.cookie,
    origin: TEST_PUBLIC_BASE_URL,
    "content-type": "application/json",
  };
}

async function send(
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: object,
) {
  const answer = await oauth.request(`/api/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await answer.text();
  return {
    status: answer.status,
    body: (text === "" ? null : JSON.parse(text)) as { id: string } | null,
  };
}

describe("the threads routes", () => {
  it("let a viewer ask, a curator answer and accept, and show the thread answered", async () => {
    const [viewer, curator] = [await person("viewer"), await person("curator")];
    const name = `threaded_${randomUUID().slice(0, 8)}`;
    const metric = await send(curator, "POST", "/metrics", {
      name,
      label: "Threaded",
    });
    const element = { kind: "metric", id: metric.body?.id };
    const asked = await send(viewer, "POST", "/threads", {
      kind: "question",
      element,
      title: "Does it include VAT?",
      body: "Which VAT does it leave out?",
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const thread = `/threads/${asked.body?.id ?? ""}`;
    const answer = await send(curator, "POST", `${thread}/replies`, {
      body: "No VAT, any country's.",
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const accepted = await send(curator, "POST", `${thread}/accept`, {
      reply_id: answer.body?.id,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await send(viewer, "PUT", `${thread}/upvote`)).status).toBe(200);
    const read = await send(viewer, "GET", thread);
    expect(JSON.stringify(read.body)).toContain("No VAT, any country's.");
    const listed = await send(viewer, "GET", `/threads?status=answered`);
    expect(JSON.stringify(listed.body)).toContain(asked.body?.id);
  });

  it("refuse a viewer the accept and the archive of another's thread", async () => {
    const [viewer, curator] = [await person("viewer"), await person("curator")];
    const metric = await send(curator, "POST", "/metrics", {
      name: `refused_${randomUUID().slice(0, 8)}`,
      label: "Refused",
    });
    const asked = await send(curator, "POST", "/threads", {
      kind: "question",
      element: { kind: "metric", id: metric.body?.id },
      title: "Who owns it?",
      body: "Which team?",
    });
    const thread = `/threads/${asked.body?.id ?? ""}`;
    const reply = { reply_id: randomUUID() };
    expect((await send(viewer, "POST", `${thread}/accept`, reply)).status).toBe(
      403,
    );
    expect((await send(viewer, "POST", `${thread}/archive`)).status).toBe(403);
  });
});
