import { randomUUID } from "node:crypto";
import { eq, max } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  asPerson,
  id,
  outsider,
  reaching,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import { cerbosAccess, principals, testPool } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { createDb } from "../../db/client.js";
import { metricVariant } from "../../db/schema/book.js";
import { event, type EventKind } from "../../db/schema/events.js";
import { powerbiMeasure } from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import { ServiceError } from "../../errors.js";
import { assignRole } from "../../services/auth/roles.js";
import {
  createKey,
  createServiceAccount,
} from "../../services/auth/service-accounts.js";
import { getDocs } from "../../services/book/docs.js";
import {
  createMetric,
  deleteMetric,
  getMetric,
  mergeMetrics,
  renameMetric,
  updateMetric,
} from "../../services/book/metrics.js";
import {
  getVariant,
  listVariants,
  moveVariant,
} from "../../services/book/variants.js";
import { readVisibleEvents, withEvents } from "../../services/events/feed.js";
import { getDataset } from "../../services/mirror/read.js";

/*
 * What the change feed and the reads show a caller who may not see the thing
 * they concern. The tenant is the mirror fixtures': Sales is reached by one
 * service account, Finance by another, and each metric is filed under one of
 * them so a caller sees it, or does not. A hidden thing answers like a
 * missing one, and an event carries ids, never another element's name.
 */

useMirror();

const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
const admin = { ...oauth.deps, principal: principals.admin };
const curator = { ...oauth.deps, principal: principals.curator };
const tag = randomUUID().slice(0, 8);
const name = (word: string) => `${word}_${tag}`;
const finance = { b: randomUUID(), c: randomUUID(), d: randomUUID() };
const piiFinanceMeasure = randomUUID();

let salesKey = "";
let financeKey = "";
let before = 0;
/** After the metrics are made and before they are merged and moved: a creation names its metric to everyone, as it had no variants yet. */
let changed = 0;
type Filed = { id: string; name: string; variants: string[] };
const filed: Record<string, Filed> = {};

async function file(word: string, measures: string[]): Promise<Filed> {
  const created = await createMetric(curator, {
    name: name(word),
    label: word,
  });
  const variants =
    measures.length === 0
      ? []
      : await oauth.deps.db
          .insert(metricVariant)
          .values(
            measures.map((measure_id) => ({
              metric_id: created.id,
              measure_id,
              assigned_by: "curator" as const,
            })),
          )
          .returning({ id: metricVariant.id });
  const made = {
    id: created.id,
    name: created.name,
    variants: variants.map((variant) => variant.id),
  };
  filed[word] = made;
  return made;
}

async function lastEvent(): Promise<number> {
  const [highest] = await oauth.deps.db
    .select({ id: max(event.id) })
    .from(event);
  return highest?.id ?? 0;
}

async function keyFor(workspace: string, account: string) {
  await createServiceAccount(admin, {
    name: `${account}_${tag}`,
    owner_email: "owner@example.test",
    roles: ["viewer"],
    workspace_ids: [workspace],
  });
  return (await createKey(admin, `${account}_${tag}`, { expires_in_days: 7 }))
    .key;
}

beforeAll(async () => {
  const worker = createDb(testPool("worker_rw"));
  await worker.insert(powerbiMeasure).values([
    ...Object.entries(finance).map(([key, measureId]) => ({
      id: measureId,
      dataset_id: id.finance,
      table_id: id.finance_table,
      name: `Finance ${key}`,
    })),
    {
      id: piiFinanceMeasure,
      dataset_id: id.finance,
      table_id: id.finance_table,
      name: "Finance PII event measure",
    },
  ]);
  await oauth.deps.db.insert(piiRule).values({
    kind: "measure",
    table_name: "Ledger",
    name: "Finance PII event measure",
    pii: true,
    set_by_kind: "person",
    set_by_id: "test",
    set_via: "api",
  });
  salesKey = await keyFor(id.sales_workspace, "sales_reader");
  financeKey = await keyFor(id.finance_workspace, "finance_reader");
  before = await lastEvent();
  // Curators' changes across the two scopes. x1 and x2 are Sales metrics; y1 and z hold Finance variants.
  const x1 = await file("x1", [id.net_sales]);
  const y1 = await file("y1", [id.profit]);
  const x2 = await file("x2", [id.days]);
  const z = await file("z", [id.net_sales_ly, finance.b]);
  changed = await lastEvent();
  await mergeMetrics(curator, { from: y1.name, into: x1.name });
  await moveVariant(curator, z.variants[0] ?? "", {
    to_metric: x2.name,
    period: "previous_year",
  });
  const gone = await file("gone", []);
  await deleteMetric(curator, gone.name);
}, 120_000);

type Item = {
  id: number;
  kind: EventKind;
  element: { kind: string; id: string } | null;
  data: Record<string, unknown>;
};

async function feed(
  headers: Record<string, string>,
  query = "",
  after = before,
): Promise<{ status: number; items: Item[] }> {
  const answer = await oauth.request(
    `/api/v1/events?after=${String(after)}${query}`,
    { headers },
  );
  return { status: answer.status, items: (await answer.json()) as Item[] };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const aboutMetric = (items: Item[], metricId: string) =>
  items.filter((item) => item.element?.id === metricId);

async function person(role: "viewer" | "curator" | "admin") {
  const signedIn = await oauth.person();
  if (role !== "viewer")
    await assignRole(
      oauth.deps.db,
      { role, subject_kind: "person", subject: signedIn.email },
      principals.admin,
    );
  return bearer((await oauth.login(signedIn.cookie)).access_token);
}

describe("an event carries ids, never another element's name", () => {
  it("leaves a metric hidden from the account unnamed after a merge and after a move", async () => {
    const { items } = await feed(bearer(salesKey), "", changed);
    const received = JSON.stringify(items);
    expect(received).not.toContain(name("y1"));
    expect(received).not.toContain(name("z"));
    // The visible metrics' events are there, naming the others by id.
    const merged = aboutMetric(items, filed.x1?.id ?? "");
    expect(merged.map((item) => item.data.from_metric_id)).toContain(
      filed.y1?.id,
    );
    expect(merged.every((item) => !("variants" in item.data))).toBe(true);
    const moved = aboutMetric(items, filed.x2?.id ?? "");
    expect(moved.map((item) => item.data.from_metric_id)).toContain(
      filed.z?.id,
    );
  });
});

describe("an event about a metric that is gone", () => {
  it("reaches a reader who could describe it, and not one who could not", async () => {
    const sales = await feed(bearer(salesKey), "", changed);
    const money = await feed(bearer(financeKey), "", changed);
    const y1 = filed.y1?.id ?? "";
    expect(
      aboutMetric(money.items, y1).map((item) => item.data.action),
    ).toEqual(["merge"]);
    expect(aboutMetric(sales.items, y1)).toEqual([]);
  });

  it("shows a deleted metric that had no variants to everyone, as a metric with none is", async () => {
    const outsiderFeed = await feed(await person("viewer"));
    const gone = filed.gone?.id ?? "";
    for (const reader of [
      outsiderFeed,
      await feed(bearer(salesKey)),
      await feed(bearer(financeKey)),
    ])
      expect(
        aboutMetric(reader.items, gone).map((item) => item.data.action),
      ).toEqual(["create", "delete"]);
  });
});

describe("an event is judged by the scope it recorded", () => {
  /** The events of one metric that a reader sees, from `after`. */
  const seenBy = async (key: string, metricId: string, after: number) =>
    aboutMetric((await feed(bearer(key), "", after)).items, metricId);
  const actions = (items: Item[]) => items.map((item) => item.data.action);

  it("shows an event with no recorded dataset_ids to no service account, even for a metric both can see", async () => {
    const unscoped = {
      kind: "metric.changed" as const,
      element_kind: "metric",
      principal: null,
      data: { action: "update", name: "written_before_scope_existed" },
    };
    const mark = await lastEvent();
    const visibleToBoth = filed.x1;
    if (visibleToBoth === undefined) throw new Error("the fixture has no x1");
    await withEvents(oauth.deps.db, (_tx, emit) => {
      emit({ ...unscoped, element_id: visibleToBoth.id });
      emit({ ...unscoped, element_id: randomUUID() });
      return Promise.resolve();
    });
    for (const key of [salesKey, financeKey]) {
      const { items } = await feed(bearer(key), "", mark);
      expect(items.filter((item) => item.kind === "metric.changed")).toEqual(
        [],
      );
    }
  });

  it("keeps a rename and the move of the last variant out, made while the metric held Finance variants, from Sales once it is empty and visible to everyone", async () => {
    const held = await file("renamed", [finance.c]);
    const mark = await lastEvent();
    const renamed = name("renamed_later");
    await renameMetric(curator, held.name, renamed);
    expect(await seenBy(salesKey, held.id, mark)).toEqual([]);
    await moveVariant(curator, held.variants[0] ?? "", {
      to_metric: filed.x2?.name ?? "",
      period: "previous_year",
    });
    // Holding nothing now, the metric is shown to everyone, as the metric services have it.
    const shown = await oauth.request(`/api/v1/metrics/${renamed}`, {
      headers: bearer(salesKey),
    });
    expect(shown.status).toBe(200);
    // The rename, and the move of its last variant out, which records the scope the metric had before it emptied.
    expect(await seenBy(salesKey, held.id, mark)).toEqual([]);
    expect(actions(await seenBy(financeKey, held.id, mark))).toEqual([
      "rename",
      "move",
    ]);
  });

  it("keeps what was written while a metric held Finance variants from Sales once the metric is merged away", async () => {
    const hiding = await file("merged_away", [finance.d]);
    const mark = await lastEvent();
    await updateMetric(curator, hiding.name, { definition: "Written hidden." });
    await mergeMetrics(curator, {
      from: hiding.name,
      into: filed.x2?.name ?? "",
    });
    const sales = await seenBy(salesKey, hiding.id, mark);
    expect(JSON.stringify(sales)).not.toContain("Written hidden.");
    expect(sales).toEqual([]);
    expect(actions(await seenBy(financeKey, hiding.id, mark))).toEqual([
      "update",
      "merge",
    ]);
  });
});

describe("PII measure events", () => {
  it.each([{ measureIds: [piiFinanceMeasure, id.days] }, { measureIds: [] }])(
    "requires a recorded measure that is both reachable and not PII: $measureIds",
    async ({ measureIds }) => {
      const mark = await lastEvent();
      const hiddenId = randomUUID();
      await withEvents(oauth.deps.db, (_tx, emit) => {
        emit({
          kind: "metric.changed",
          element_kind: "metric",
          element_id: hiddenId,
          principal: null,
          data: {
            name: "private_metric",
            dataset_ids: [id.finance, id.sales],
            measure_ids: measureIds,
          },
        });
        return Promise.resolve();
      });
      expect(
        aboutMetric((await feed(bearer(financeKey), "", mark)).items, hiddenId),
      ).toEqual([]);
    },
  );

  const seenMetricEvents = async (after: number, metricId: string) =>
    aboutMetric(
      (await feed(await person("viewer"), "", after)).items,
      metricId,
    );

  it("hides events of a merged away metric whose only variant was PII", async () => {
    const mark = await lastEvent();
    const hiddenId = randomUUID();
    await withEvents(oauth.deps.db, (_tx, emit) => {
      for (const kind of ["draft.created", "metric.changed"] as const)
        emit({
          kind,
          element_kind: "metric",
          element_id: hiddenId,
          principal: null,
          data: {
            action: "merge",
            name: "pii_measure_name",
            dataset_ids: [id.finance],
            measure_ids: [piiFinanceMeasure],
          },
        });
      return Promise.resolve();
    });
    const items = await seenMetricEvents(mark, hiddenId);
    expect(items).toEqual([]);
  });

  it("hides an old all PII event when its metric is visible now", async () => {
    const mark = await lastEvent();
    await withEvents(oauth.deps.db, (_tx, emit) => {
      emit({
        kind: "metric.changed",
        element_kind: "metric",
        element_id: filed.x2?.id ?? "",
        principal: null,
        data: {
          action: "update",
          name: "old_pii_name",
          dataset_ids: [],
          measure_ids: [piiFinanceMeasure],
        },
      });
      return Promise.resolve();
    });
    expect(
      await feed(await person("viewer"), "", mark).then(({ items }) =>
        aboutMetric(items, filed.x2?.id ?? ""),
      ),
    ).toEqual([]);
  });

  it("hides variant moved events for a PII measure", async () => {
    const mark = await lastEvent();
    await withEvents(oauth.deps.db, (_tx, emit) => {
      emit({
        kind: "variant.moved",
        element_kind: "variant",
        element_id: randomUUID(),
        principal: null,
        data: { dataset_id: id.finance, measure_id: piiFinanceMeasure },
      });
      return Promise.resolve();
    });
    expect(
      await feed(await person("viewer"), "&kinds=variant.moved", mark).then(
        ({ items }) => items,
      ),
    ).toEqual([]);
  });
});

describe("measure ids in a metric event", () => {
  const recorded = [id.days, finance.b, piiFinanceMeasure];
  const emitMetricEvent = async (measureIds: string[]) => {
    const mark = await lastEvent();
    const metricId = randomUUID();
    await withEvents(oauth.deps.db, (_tx, emit) => {
      emit({
        kind: "metric.changed",
        element_kind: "metric",
        element_id: metricId,
        principal: null,
        data: {
          name: "strip_metric",
          dataset_ids: [id.finance, id.sales],
          measure_ids: measureIds,
        },
      });
      return Promise.resolve();
    });
    return { mark, metricId };
  };
  const idsFor = async (headers: Record<string, string>, ids: string[]) => {
    const { mark, metricId } = await emitMetricEvent(ids);
    const [only] = aboutMetric((await feed(headers, "", mark)).items, metricId);
    return only?.data.measure_ids;
  };

  it("leaves a reader only the measures it may describe", async () => {
    expect(await idsFor(bearer(salesKey), recorded)).toEqual([id.days]);
    expect(await idsFor(bearer(financeKey), recorded)).toEqual([finance.b]);
  });

  it("returns no event to a reader who may describe none of its measures", async () => {
    expect(
      await idsFor(bearer(salesKey), [finance.b, piiFinanceMeasure]),
    ).toBeUndefined();
  });

  it("returns every measure to a reader who may describe all of them", async () => {
    const holder = await oauth.person();
    await assignRole(
      oauth.deps.db,
      { role: "admin", subject_kind: "person", subject: holder.email },
      principals.admin,
    );
    await assignRole(
      oauth.deps.db,
      { role: "pii_reader", subject_kind: "person", subject: holder.email },
      principals.admin,
    );
    const headers = bearer((await oauth.login(holder.cookie)).access_token);
    expect(await idsFor(headers, recorded)).toEqual(recorded);
  });
});

describe("variant events and paging", () => {
  it("hides a variant event on a dataset the account cannot describe, and pages across it", async () => {
    const mark = (
      await oauth.deps.db.select({ id: max(event.id) }).from(event)
    )[0]?.id;
    const variantEvent = (dataset: string) => ({
      kind: "variant.moved" as const,
      element_kind: "variant",
      element_id: randomUUID(),
      principal: null,
      data: { dataset_id: dataset, measure_id: id.days },
    });
    await withEvents(oauth.deps.db, (_tx, emit) => {
      for (const dataset of [id.finance, id.sales, id.finance, id.sales])
        emit(variantEvent(dataset));
      return Promise.resolve();
    });
    const paged: string[] = [];
    let after = mark ?? 0;
    for (let pages = 0; pages < 6; pages += 1) {
      const answer = await oauth.request(
        `/api/v1/events?after=${String(after)}&limit=1&kinds=variant.moved`,
        { headers: bearer(salesKey) },
      );
      const items = (await answer.json()) as Item[];
      const last = items.at(-1);
      if (last === undefined) break;
      expect(items).toHaveLength(1);
      paged.push(String(last.data.dataset_id));
      after = last.id;
    }
    expect(paged).toEqual([id.sales, id.sales]);
  });
});

describe("the sync's events", () => {
  it("go to an admin alone, with their error only for one who may manage the settings", async () => {
    await withEvents(oauth.deps.db, (_tx, emit) => {
      emit({
        kind: "sync.failed",
        element_kind: null,
        element_id: null,
        principal: null,
        data: { error: "Power BI refused the scan." },
      });
      return Promise.resolve();
    });
    const asAdmin = await feed(await person("admin"), "&kinds=sync.failed");
    expect(asAdmin.items.map((item) => item.data.error)).toEqual([
      "Power BI refused the scan.",
    ]);
    for (const reader of [
      await person("curator"),
      await person("viewer"),
      bearer(salesKey),
    ])
      expect((await feed(reader, "&kinds=sync.failed")).items).toEqual([]);
    // A role that may read the sync events but not manage the settings gets the event without its error.
    const access = {
      ...oauth.deps.access,
      check: (
        principal: Parameters<typeof oauth.deps.access.check>[0],
        resource: Parameters<typeof oauth.deps.access.check>[1],
        action: string,
      ) =>
        action === "read_sync_events"
          ? Promise.resolve(true)
          : oauth.deps.access.check(principal, resource, action),
    };
    const rows = await readVisibleEvents(
      { ...oauth.deps, access, principal: principals.viewer },
      { after: before, kinds: ["sync.failed"] },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => !("error" in row.data))).toBe(true);
  });
});

describe("an event with no element", () => {
  it("is shown only when it is the sync's, and to nobody otherwise, an admin included", async () => {
    const mark = await lastEvent();
    await withEvents(oauth.deps.db, (_tx, emit) => {
      for (const kind of ["metric.changed", "term.changed"] as const)
        emit({
          kind,
          element_kind: null,
          element_id: null,
          principal: null,
          data: { dataset_ids: [] },
        });
      emit({
        kind: "sync.finished",
        element_kind: null,
        element_id: null,
        principal: null,
        data: {},
      });
      return Promise.resolve();
    });
    const asAdmin = await feed(await person("admin"), "", mark);
    expect(asAdmin.items.map((item) => item.kind)).toEqual(["sync.finished"]);
  });
});

describe("a thread's event", () => {
  it("shows to whoever may see its element", async () => {
    const reader = await person("admin");
    const mark = (await feed(reader)).items.at(-1)?.id ?? before;
    for (const word of ["x1", "z"]) {
      const made = await oauth.request("/api/v1/threads", {
        method: "POST",
        headers: { ...reader, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "comment",
          element: { kind: "metric", id: filed[word]?.id },
          body: "A note.",
        }),
      });
      expect(made.status).toBe(201);
    }
    const elements = async (key: string) => {
      const answer = await oauth.request(
        `/api/v1/events?after=${String(mark)}&kinds=thread.created`,
        { headers: bearer(key) },
      );
      return ((await answer.json()) as Item[]).map(
        (item) => (item.data.element as { id: string }).id,
      );
    };
    // z holds only a Finance variant now, and x1 has both Sales' and Finance's.
    expect(await elements(salesKey)).toEqual([filed.x1?.id]);
    expect(await elements(financeKey)).toEqual([filed.x1?.id, filed.z?.id]);
  });
});

/** What a lookup threw, with the reference it was given taken out of the message. */
async function refusal(work: () => Promise<unknown>, reference: string) {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return {
      kind: error.kind,
      message: error.message.replaceAll(reference, "<ref>"),
    };
  }
  return null;
}

describe("a hidden thing answers like a missing one", () => {
  const directShare = reaching({ powerbi_dataset_ids: [id.sales] });
  const hidden = [
    ["the outsider", outsider],
    ["the person with a direct share of Sales", directShare],
  ] as const;

  it.each(hidden)("for %s, through the services", async (_who, principal) => {
    const as = asPerson(principal);
    const z = filed.z?.id ?? "";
    const finVariant = (
      await oauth.deps.db
        .select({ id: metricVariant.id })
        .from(metricVariant)
        .where(eq(metricVariant.measure_id, finance.b))
    )[0]?.id;
    const absent = randomUUID();
    const pairs: [
      () => Promise<unknown>,
      string,
      () => Promise<unknown>,
      string,
    ][] = [
      [() => getMetric(as, z), z, () => getMetric(as, absent), absent],
      [() => listVariants(as, z), z, () => listVariants(as, absent), absent],
      [
        () => getVariant(as, finVariant ?? ""),
        finVariant ?? "",
        () => getVariant(as, absent),
        absent,
      ],
      [
        () => getDocs(as, { kind: "dataset", id: id.finance }),
        id.finance,
        () => getDocs(as, { kind: "dataset", id: absent }),
        absent,
      ],
      [
        () => getDataset(as, id.finance),
        id.finance,
        () => getDataset(as, absent),
        absent,
      ],
    ];
    for (const [hide, hiddenId, miss, missingId] of pairs) {
      const refused = await refusal(hide, hiddenId);
      expect(refused).not.toBeNull();
      expect(refused).toEqual(await refusal(miss, missingId));
    }
  });

  it("for a service account, through the routes", async () => {
    // The body is compared with the reference taken out, as the services' messages name what was asked for.
    const outcome = async (path: string, reference: string) => {
      const answer = await oauth.request(`/api/v1${path}`, {
        headers: bearer(salesKey),
      });
      return {
        status: answer.status,
        body: (await answer.text()).replaceAll(reference, "<ref>"),
      };
    };
    const absent = randomUUID();
    const finVariant = (
      await oauth.deps.db
        .select({ id: metricVariant.id })
        .from(metricVariant)
        .where(eq(metricVariant.measure_id, finance.b))
    )[0]?.id;
    const hiddenMetric = filed.z?.name ?? "";
    const nobody = name("nobody");
    const paths: [string, string, string, string][] = [
      [`/metrics/${hiddenMetric}`, hiddenMetric, `/metrics/${nobody}`, nobody],
      [
        `/metrics/${hiddenMetric}/variants`,
        hiddenMetric,
        `/metrics/${nobody}/variants`,
        nobody,
      ],
      [
        `/variants/${finVariant ?? ""}`,
        finVariant ?? "",
        `/variants/${absent}`,
        absent,
      ],
      [
        `/elements/dataset/${id.finance}/docs`,
        id.finance,
        `/elements/dataset/${absent}/docs`,
        absent,
      ],
    ];
    for (const [hide, hiddenRef, miss, missRef] of paths) {
      const shown = await outcome(hide, hiddenRef);
      expect(shown.status, hide).toBe(404);
      expect(shown, hide).toEqual(await outcome(miss, missRef));
    }
  });
});

describe("an app the caller is not in", () => {
  it("is neither described nor listed for a person who holds only a direct share", async () => {
    const share = asPerson(reaching({ powerbi_dataset_ids: [id.sales] }));
    const absent = randomUUID();
    const docs = await refusal(
      () => getDocs(share, { kind: "app", id: id.sales_app }),
      id.sales_app,
    );
    expect(docs).toEqual(
      await refusal(() => getDocs(share, { kind: "app", id: absent }), absent),
    );
    expect((await getDataset(share, id.sales)).apps).toEqual([]);
    // The app's audience still sees it.
    const audience = asPerson(reaching({ powerbi_app_ids: [id.sales_app] }));
    expect(
      await getDocs(audience, { kind: "app", id: id.sales_app }),
    ).toMatchObject({ element: { kind: "app", id: id.sales_app } });
    expect((await getDataset(audience, id.sales)).apps).toMatchObject([
      { id: id.sales_app },
    ]);
  });
});
