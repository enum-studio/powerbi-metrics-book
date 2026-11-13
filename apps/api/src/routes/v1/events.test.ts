import { randomUUID } from "node:crypto";
import { max } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { event, type EventKind } from "../../db/schema/events.js";
import { assignRole } from "../../services/auth/roles.js";
import { withEvents } from "../../services/events/feed.js";

/*
 * The change feed route: paged by id, oldest first, filtered by kind. What a
 * caller may not see is held by events_visibility_security_test.ts.
 */

afterAll(closeTestPools);

const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
const RUN = randomUUID();
let before = 0;

const emitted = (kind: EventKind) => ({
  kind,
  element_kind: null,
  element_id: null,
  principal: null,
  data: { run: RUN },
});

beforeAll(async () => {
  const [highest] = await oauth.deps.db
    .select({ id: max(event.id) })
    .from(event);
  before = highest?.id ?? 0;
  await withEvents(oauth.deps.db, (_tx, emit) => {
    emit(emitted("sync.finished"));
    emit({ ...emitted("conventions.changed"), element_kind: "conventions" });
    emit({ ...emitted("term.changed"), element_kind: "term" });
    emit(emitted("sync.failed"));
    return Promise.resolve();
  });
}, 60_000);

async function feed(headers: Record<string, string>, query = "") {
  const answer = await oauth.request(
    `/api/v1/events?after=${String(before)}${query}`,
    { headers },
  );
  return {
    status: answer.status,
    items: (await answer.json()) as { id: number; kind: EventKind }[],
  };
}

async function admin() {
  const signedIn = await oauth.person();
  await assignRole(
    oauth.deps.db,
    { role: "admin", subject_kind: "person", subject: signedIn.email },
    principals.admin,
  );
  return {
    authorization: `Bearer ${(await oauth.login(signedIn.cookie)).access_token}`,
  };
}

describe("GET /events", () => {
  it("refuses a request with no credential", async () => {
    const answer = await oauth.request("/api/v1/events");
    expect(answer.status).toBe(401);
  });

  it("pages by after, oldest first, and filters by kinds", async () => {
    const reader = await admin();
    const all = await feed(reader);
    expect(all.status).toBe(200);
    expect(all.items.map((item) => item.kind)).toEqual([
      "sync.finished",
      "conventions.changed",
      "term.changed",
      "sync.failed",
    ]);
    const ids = all.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const paged: number[] = [];
    let after = before;
    for (let pages = 0; pages < 10; pages += 1) {
      const answer = await oauth.request(
        `/api/v1/events?after=${String(after)}&limit=2`,
        { headers: reader },
      );
      const items = (await answer.json()) as { id: number }[];
      if (items.length === 0) break;
      paged.push(...items.map((item) => item.id));
      after = items.at(-1)?.id ?? after;
    }
    expect(paged).toEqual(ids);
    const kinds = await feed(reader, "&kinds=term.changed,sync.failed");
    expect(kinds.items.map((item) => item.kind)).toEqual([
      "term.changed",
      "sync.failed",
    ]);
  });

  it("refuses a parameter that is not valid", async () => {
    const reader = await admin();
    for (const query of ["&kinds=nope", "&limit=501", "&after=-1", "&x=1"])
      expect((await feed(reader, query)).status, query).toBe(400);
  });
});
