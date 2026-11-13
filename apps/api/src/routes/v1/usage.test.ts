import { afterAll, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { assignRole } from "../../services/auth/roles.js";

afterAll(closeTestPools);
const settings = new MemorySettings();
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });

it("requires a credential and a curator, and validates the report period", async () => {
  const person = await oauth.person();
  const path = `/api/v1/usage/report?since=${new Date(Date.now() - 86_400_000).toISOString()}&limit=1`;
  expect((await oauth.request(path)).status).toBe(401);
  const headers = { cookie: person.cookie };
  expect((await oauth.request(path, { headers })).status).toBe(403);
  await assignRole(
    oauth.deps.db,
    { subject_kind: "person", subject: person.email, role: "curator" },
    principals.admin,
  );
  const answer = await oauth.request(path, { headers });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({
    hidden: 0,
    truncated_lists: [],
    totals: { requests: 0 },
  });
  expect(
    (await oauth.request("/api/v1/usage/report?since=bad", { headers })).status,
  ).toBe(400);
});
