import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { MAX_BODY_BYTES } from "../../http/security-headers.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { assignRole } from "../../services/auth/roles.js";
import { FIXED_RULES, RULES } from "../../services/conventions/rules.js";

afterAll(closeTestPools);
const settings = new MemorySettings();
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });

it("lists every rule to anyone signed in, with where its value comes from", async () => {
  expect((await oauth.request("/api/v1/conventions/rules")).status).toBe(401);
  const viewer = await oauth.person();
  const answer = await oauth.request("/api/v1/conventions/rules", {
    headers: { cookie: viewer.cookie },
  });
  expect(answer.status).toBe(200);
  const { rules, fixed } = (await answer.json()) as {
    rules: { id: string; source: string; exceptions: number }[];
    fixed: unknown;
  };
  expect(rules.map((rule) => rule.id)).toEqual(RULES.map((rule) => rule.id));
  expect(rules.every((rule) => rule.source === "preset")).toBe(true);
  expect(rules.find((rule) => rule.id === "naming.case")).toMatchObject({
    check: "metric_name_form",
    target: "metric",
    value: "snake_case",
    allowed: ["snake_case", "none"],
    off: false,
    exceptions: 0,
  });
  expect(fixed).toEqual(FIXED_RULES);
});

it("answers an admin the company's part of the conventions in force, and refuses anyone else", async () => {
  const admin = await oauth.person();
  await assignRole(
    oauth.deps.db,
    { role: "admin", subject_kind: "person", subject: admin.email },
    principals.admin,
  );
  const viewer = await oauth.person();
  const company = (cookie: string) =>
    oauth.request("/api/v1/conventions/company", { headers: { cookie } });
  expect((await company(viewer.cookie)).status).toBe(403);

  const saved = await oauth.request("/api/v1/conventions", {
    method: "PUT",
    headers: {
      cookie: admin.cookie,
      origin: TEST_PUBLIC_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ format: 1, naming: { kinds: ["total_"] } }),
  });
  expect(saved.status).toBe(200);
  const answer = await company(admin.cookie);
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({
    format: 1,
    naming: { kinds: ["total_"] },
  });
});

/** A person signed in with `role`, and a request from their browser. */
async function signedIn(role: "admin" | "curator") {
  const who = await oauth.person();
  await assignRole(
    oauth.deps.db,
    { role, subject_kind: "person", subject: who.email },
    principals.admin,
  );
  return (method: string, path: string, body?: unknown) =>
    oauth.request(path, {
      method,
      headers: {
        cookie: who.cookie,
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

it("applies a part for an admin, and sends the codes a client acts on", async () => {
  const admin = await signedIn("admin");
  const dry = await admin("POST", "/api/v1/conventions/apply", {
    conventions: { format: 1, off: ["naming.case"] },
    dry_run: true,
  });
  expect(dry.status).toBe(200);
  // The file's earlier test set naming.kinds, which this part leaves out.
  expect(await dry.json()).toMatchObject({
    changed_rules: expect.arrayContaining([
      "naming.case",
      "naming.kinds",
    ]) as unknown,
    exceptions_added: [],
    version: null,
  });
  const refusals = [
    [
      { format: 1, naming: { kinds: ["total_"] }, off: ["naming.kinds"] },
      "conventions.off_and_set",
    ],
    [{ format: 1, off: ["trust.states"] }, "conventions.fixed"],
  ] as const;
  for (const [conventions, code] of refusals) {
    for (const [method, path, body] of [
      ["PUT", "/api/v1/conventions", conventions],
      ["POST", "/api/v1/conventions/apply", { conventions, dry_run: true }],
    ] as const) {
      const refused = await admin(method, path, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid", code });
    }
  }
});

it("lists to a curator the exceptions nothing needs, for the book or one metric", async () => {
  const admin = await signedIn("admin");
  const saved = await admin("PUT", "/api/v1/conventions", {
    format: 1,
    exceptions: [
      { rule: "naming.kinds", metric: "gone_metric", reason: "Kept." },
    ],
  });
  expect(saved.status).toBe(200);
  const curator = await signedIn("curator");
  const unused = await curator("GET", "/api/v1/conventions/exceptions/unused");
  expect(unused.status).toBe(200);
  expect(await unused.json()).toEqual({
    unused: [
      {
        rule: "naming.kinds",
        target: { metric: "gone_metric" },
        reason: "Kept.",
        why: "no_such_target",
      },
    ],
  });
  const one = "/api/v1/conventions/exceptions/unused?metric=gone_metric";
  expect((await curator("GET", one)).status).toBe(404);
  const viewer = await oauth.person();
  const refused = await oauth.request(one, {
    headers: { cookie: viewer.cookie },
  });
  expect(refused.status).toBe(403);
});

it("answers a metric's failure under an exception as passing with its reason, and lists a baseline's exceptions", async () => {
  const admin = await signedIn("admin");
  const curator = await signedIn("curator");
  const name = `excepted_${randomUUID().slice(0, 8)}`;
  const made = await curator("POST", "/api/v1/metrics", {
    name,
    label: "Excepted",
  });
  expect(made.status).toBe(201);
  const definition = async () => {
    const checked = await curator("GET", `/api/v1/metrics/${name}/checks`);
    expect(checked.status).toBe(200);
    const { checks } = (await checked.json()) as {
      checks: { rule: string }[];
    };
    return checks.find(({ rule }) => rule === "metric_fields.definition");
  };
  expect(await definition()).toMatchObject({ passed: false });
  const reason = "Named before the house style.";
  const exceptions = [
    { rule: "metric_fields.definition", metric: name, reason },
  ];
  // naming.kinds is off, so the name passes it until the part below turns it on.
  const saved = await admin("PUT", "/api/v1/conventions", {
    format: 1,
    off: ["naming.kinds"],
    exceptions,
  });
  expect(saved.status).toBe(200);
  expect(await definition()).toMatchObject({ passed: true, exception: reason });
  const baseline = "Names in use before the house style";
  const dry = await admin("POST", "/api/v1/conventions/apply", {
    conventions: { format: 1, naming: { kinds: ["total_"] }, exceptions },
    dry_run: true,
    baseline_reason: baseline,
  });
  expect(dry.status).toBe(200);
  const { exceptions_added: added } = (await dry.json()) as {
    exceptions_added: unknown[];
  };
  expect(added).toContainEqual({
    rule: "naming.kinds",
    metric: name,
    reason: baseline,
  });
});

it("takes a part with 9,000 exceptions, over the 1 MiB other routes keep, and refuses a body over 8 MiB", async () => {
  const admin = await signedIn("admin");
  const exceptions = Array.from({ length: 9_000 }, (_, at) => ({
    rule: "column_fields.definition",
    dataset: "Sales",
    column: `'Sales'[Column ${String(at).padStart(4, "0")}]`,
    reason: "Columns in use before the documentation rules.",
  }));
  const part = { format: 1, exceptions };
  expect(JSON.stringify(part).length).toBeGreaterThan(MAX_BODY_BYTES);
  const applied = await admin("POST", "/api/v1/conventions/apply", {
    conventions: part,
    dry_run: false,
  });
  expect(applied.status).toBe(200);
  const company = await admin("GET", "/api/v1/conventions/company");
  expect(await company.json()).toEqual(part);
  const oversized = { ...part, guide: "x".repeat(8 * 1024 * 1024) };
  for (const [method, path, body] of [
    ["PUT", "/api/v1/conventions", oversized],
    ["POST", "/api/v1/conventions/diff", oversized],
    [
      "POST",
      "/api/v1/conventions/apply",
      { conventions: oversized, dry_run: true },
    ],
  ] as const)
    expect((await admin(method, path, body)).status).toBe(413);
});
