import { afterAll, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
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
