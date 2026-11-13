import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import { MemorySecrets } from "../../../test/doubles.js";
import { loadSampleMirror } from "../../../test/sample-mirror.js";
import {
  freshPeer,
  followConnect,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import { z } from "zod";
import { createApp } from "../../app.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import { MICROSOFT } from "../../services/auth/roles.js";
import { documented } from "./adapter.js";

/*
 * The queries and results routes through the whole app, with people signed
 * in and connected to the mock's Power BI. The CSV is fetched by signed
 * link, as an agent's download tool does, and by its owner's own session.
 */

const SALES = "Sales";
let f: SignInFixture;
const Thing = z.object({ id: z.string() });
const probe = documented("A probe", Thing);
let app: ReturnType<typeof createApp>;
/** Where the app's clock stands still, when it does. */
let held: Date | undefined;

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
  // The fixture's people have ids of their own; the access lists still name the sample's.
  const own = [...f.tenant.people, ...f.tenant.groups];
  const original = sampleTenant();
  const ids = new Map(
    [...original.people, ...original.groups].map((item, n) => [
      item.object_id,
      own[n]?.object_id,
    ]),
  );
  for (const item of [...f.tenant.workspaces, ...f.tenant.datasets])
    for (const entry of item.users)
      entry.object_id = ids.get(entry.object_id) ?? entry.object_id;
  const mock = await f.settings.get("powerbi.authority");
  await f.settings.set("powerbi.api_url", `${mock}/powerbi`);
  await f.settings.set("access.metadata_visibility", "everyone");
  await loadSampleMirror(createDb(testPool("worker_rw")));
  app = createApp({
    ...f.deps,
    clock: () => held ?? f.deps.clock(),
    access: cerbosAccess(f.settings),
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", "sample-app-secret"],
      ["result_link_key", "test-result-link-key"],
    ]),
  });
  // A route whose answer fails its schema, behind the app's own gate and error handler.
  app.get("/api/v1/probe", (c) =>
    probe.answer(c, { id: 42, secret: "never sent" } as unknown as z.input<
      typeof Thing
    >),
  );
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

const get = (
  path: string,
  headers: Record<string, string> = {},
  peer = freshPeer(),
) =>
  app.request(
    path,
    { headers },
    { incoming: { socket: { remoteAddress: peer } } },
  );

/** A person signed in and connected to Power BI, who has run a query: their cookie and the result's id and link. */
async function ranQuery(mailbox: string) {
  const who = f.person(mailbox);
  const { cookie } = await f.signIn(who, MICROSOFT);
  expect((await followConnect(app, cookie)).answer.status).toBe(302);
  const dax = f.tenant.datasets.find((d) => d.name === SALES)
    ?.recorded_queries[0]?.dax;
  const ran = await app.request("/api/v1/queries", {
    method: "POST",
    headers: {
      cookie,
      origin: TEST_PUBLIC_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ dataset: SALES, dax }),
  });
  expect(ran.status, await ran.clone().text()).toBe(201);
  const anchor = (await ran.json()) as { result_id: string; csv_url: string };
  return { cookie, ...anchor, link: new URL(anchor.csv_url) };
}

const pathOf = (url: URL) => `${url.pathname}${url.search}`;

describe("GET /api/v1/results/:id/csv", () => {
  it("serves a signed link with no credential, as an attachment never cached, and audits the download", async () => {
    const owner = await ranQuery("admin");
    const answer = await get(pathOf(owner.link));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toMatch("text/csv");
    expect(answer.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect((await answer.text()).split("\r\n")[0]).toBe(
      "Date[Month],[Net sales]",
    );
    const audited = await createDb(testPool("api_rw"))
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, "result.download"),
          eq(auditEvent.resource_id, owner.result_id),
        ),
      );
    expect(audited).toHaveLength(1);
  });

  it("refuses a tampered signature, an expired link and no link at all, and limits an address", async () => {
    const owner = await ranQuery("analyst");
    const tampered = new URL(owner.link);
    tampered.searchParams.set(
      "signature",
      `x${tampered.searchParams.get("signature") ?? ""}`,
    );
    expect((await get(pathOf(tampered))).status).toBe(403);
    const later = new URL(owner.link);
    later.searchParams.set("expires", "1");
    expect((await get(pathOf(later))).status).toBe(403);
    expect((await get(`/api/v1/results/${owner.result_id}/csv`)).status).toBe(
      403,
    );
    const peer = freshPeer();
    const statuses = new Set<number>();
    // The limit counts in fixed windows on the clock minute, and a burst that
    // crossed one would split its count and never reach a 429.
    held = f.deps.clock();
    onTestFinished(() => {
      held = undefined;
    });
    for (let n = 0; n < 65; n += 1)
      statuses.add((await get(pathOf(tampered), {}, peer)).status);
    expect(statuses).toEqual(new Set([403, 429]));
  });

  it("serves the owner's own session without a link, and answers not_found to a link another person's session carries", async () => {
    const owner = await ranQuery("admin");
    const bare = `/api/v1/results/${owner.result_id}/csv`;
    expect((await get(bare, { cookie: owner.cookie })).status).toBe(200);
    const stranger = f.person("analyst");
    const { cookie } = await f.signIn(stranger, MICROSOFT);
    expect((await get(bare, { cookie })).status).toBe(404);
    expect((await get(pathOf(owner.link), { cookie })).status).toBe(404);
    expect(
      (await get(pathOf(owner.link), { cookie: owner.cookie })).status,
    ).toBe(200);
  });

  it("pages a result and mints a fresh link for its owner alone", async () => {
    const owner = await ranQuery("admin");
    const base = `/api/v1/results/${owner.result_id}`;
    const page = await get(`${base}?offset=2&limit=3`, {
      cookie: owner.cookie,
    });
    expect(page.status).toBe(200);
    expect(((await page.json()) as { rows: unknown[] }).rows).toHaveLength(3);
    const mint = (cookie: string) =>
      app.request(`${base}/csv-link`, {
        method: "POST",
        headers: { cookie, origin: TEST_PUBLIC_BASE_URL },
      });
    const link = (await (await mint(owner.cookie)).json()) as {
      csv_url: string;
    };
    expect((await get(pathOf(new URL(link.csv_url)))).status).toBe(200);
    const { cookie } = await f.signIn(f.person("analyst"), MICROSOFT);
    expect((await mint(cookie)).status).toBe(404);
  });

  it("answers a bug in a route's answer with a bare 500 that carries nothing of the value", async () => {
    const { cookie } = await f.signIn(f.person("admin"), MICROSOFT);
    const answer = await get("/api/v1/probe", { cookie });
    expect(answer.status).toBe(500);
    expect(await answer.text()).toBe('{"error":"internal"}');
  });
});
