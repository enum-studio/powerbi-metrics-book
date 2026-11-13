import { afterAll, expect, it } from "vitest";
import { MemorySettings } from "../../../test/doubles.js";
import {
  cerbosAccess,
  closeTestPools,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { fromSpa, startOAuth } from "../../../test/sign-in-support.js";

afterAll(closeTestPools);

const settings = new MemorySettings();
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
const asked = {
  question: "Which channel grew most?",
  outcome: "not_answered",
  gaps: ["missing_dimension"],
};

it("records, lists, gets and deletes a request for its own person alone", async () => {
  const owner = await oauth.person();
  const other = await oauth.person();
  const sent = (cookie: string, path: string, method = "GET") =>
    oauth.request(path, {
      method,
      headers: { cookie, origin: TEST_PUBLIC_BASE_URL },
    });

  const recorded = await oauth.request(
    "/api/v1/requests",
    fromSpa(owner.cookie, asked),
  );
  expect(recorded.status).toBe(201);
  const { id } = (await recorded.json()) as { id: string };
  const path = `/api/v1/requests/${id}`;

  const listed = await sent(owner.cookie, "/api/v1/requests?mine=true");
  expect(await listed.json()).toMatchObject({
    items: [{ id, question: asked.question, via: "browser" }],
    next_cursor: null,
  });
  expect(await (await sent(owner.cookie, path)).json()).toMatchObject({
    id,
    principal: { kind: "person", id: owner.id },
    queries: [],
    searches: [],
  });
  expect((await sent(other.cookie, path)).status).toBe(404);
  expect((await sent(other.cookie, path, "DELETE")).status).toBe(404);
  expect((await sent(owner.cookie, path, "DELETE")).status).toBe(204);
  expect((await sent(owner.cookie, path)).status).toBe(404);
});

it("answers the service's sentence for a request it refuses, and 401 with no credential", async () => {
  const { cookie } = await oauth.person();
  const refused = await oauth.request(
    "/api/v1/requests",
    fromSpa(cookie, { ...asked, gaps: [] }),
  );
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({
    error: "invalid",
    message: "gaps needs at least one gap when outcome is not_answered.",
  });
  expect((await oauth.request("/api/v1/requests")).status).toBe(401);
});
