import pg from "pg";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySecrets } from "../../../test/doubles.js";
import { loadSampleMirror } from "../../../test/sample-mirror.js";
import {
  followConnect,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import type { ServiceContext } from "../../context.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  powerbiDataset,
  powerbiRelationship,
  powerbiTable,
} from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import type { Principal } from "../../principal.js";
import { MICROSOFT } from "../auth/roles.js";
import * as rules from "../pii/rules.js";
import { checkQuery, knownTablesOf, UNCHECKABLE } from "../pii/query-check.js";
import { executeDax } from "./execute.js";

const DATASET = "Sales";
const reader = createDb(testPool("api_rw"));
const worker = createDb(testPool("worker_rw"));
const ruleId = randomUUID();
let f: SignInFixture;
let datasetId = "";

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
  const ids = new Map(
    [...sampleTenant().people, ...sampleTenant().groups].map((person, i) => [
      person.object_id,
      [...f.tenant.people, ...f.tenant.groups][i]?.object_id,
    ]),
  );
  for (const item of [
    ...f.tenant.workspaces,
    ...f.tenant.datasets,
    ...f.tenant.apps,
  ])
    for (const user of item.users)
      user.object_id = ids.get(user.object_id) ?? user.object_id;
  const authority = await f.settings.get("powerbi.authority");
  await f.settings.set("powerbi.api_url", `${authority}/powerbi`);
  await f.settings.set("access.metadata_visibility", "everyone");
  await loadSampleMirror(worker);
  datasetId =
    f.tenant.datasets.find((dataset) => dataset.name === DATASET)?.id ?? "";
  await reader.insert(piiRule).values({
    id: ruleId,
    kind: "column",
    table_name: "Sales lines",
    name: "Net amount",
    pii: true,
    set_by_kind: "person",
    set_by_id: "security-test",
    set_via: "api",
  });
});

afterAll(async () => {
  await reader.delete(piiRule).where(eq(piiRule.id, ruleId));
  if (datasetId !== "")
    await worker
      .update(powerbiDataset)
      .set({
        relationships_source: "scanner",
        relationships_read_at: new Date(),
        schema_changed_at: null,
      })
      .where(eq(powerbiDataset.id, datasetId));
  await f.close();
  await closeTestPools();
});

function contextFor(principal: Principal): ServiceContext {
  return {
    ...f.deps,
    access: cerbosAccess(f.settings),
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", "sample-app-secret"],
      ["result_link_key", "test-result-link-key"],
    ]),
    principal,
  };
}

function viewer(id: string): Principal {
  return {
    ...principals.viewer,
    id,
    attributes: {
      ...principals.viewer.attributes,
      powerbi_dataset_ids: [datasetId],
    },
  };
}

const run = (principal: Principal) =>
  executeDax(contextFor(principal), {
    dataset: DATASET,
    dax: "EVALUATE TOPN(1, 'Date')",
  });
const denials = (id: string) =>
  reader
    .select({
      action: auditEvent.action,
      detail: auditEvent.detail,
      decision: auditEvent.decision,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.principal_id, id),
        eq(auditEvent.action, "query.pii_refused"),
      ),
    );

describe("PII query relationship checks", () => {
  it("audits uncheckable table folds and rethrows other fold errors", async () => {
    const foldNames = rules.foldNames;
    const principal = viewer(randomUUID());
    const spy = vi.spyOn(rules, "foldNames");
    try {
      spy.mockImplementationOnce((db) => foldNames(db, ["\0"]));
      const message: unknown = expect.stringContaining(UNCHECKABLE);
      await expect(run(principal)).rejects.toMatchObject({
        kind: "refused",
        message,
      });
      expect(await denials(principal.id)).toEqual([
        expect.objectContaining({
          decision: "deny",
          detail: { dataset_id: datasetId, references: [UNCHECKABLE] },
        }),
      ]);
      const outage = new Error("fold unavailable");
      spy.mockRejectedValueOnce(outage);
      await expect(run(viewer(randomUUID()))).rejects.toBe(outage);
      const shutdown = new pg.DatabaseError("shutdown", 0, "error");
      shutdown.code = "57P01";
      spy.mockRejectedValueOnce(shutdown);
      await expect(run(viewer(randomUUID()))).rejects.toBe(shutdown);
    } finally {
      spy.mockRestore();
    }
  });

  it("audits and refuses null, unavailable, and stale relationships", async () => {
    const now = new Date();
    for (const source of [
      null,
      "unavailable",
      "info_view",
      "scanner",
    ] as const) {
      await worker
        .update(powerbiDataset)
        .set({
          relationships_source: source,
          relationships_read_at:
            source === null ? null : new Date(now.getTime() - 60_000),
          schema_changed_at: source === "unavailable" ? null : now,
        })
        .where(eq(powerbiDataset.id, datasetId));
      const principal = viewer(randomUUID());
      await expect(run(principal)).rejects.toMatchObject({ kind: "refused" });
      expect(await denials(principal.id)).toHaveLength(1);
    }
  });

  it.each([false, true])(
    "refreshes viewer relationships and checks their freshness: %s",
    async (changed) => {
      const who = f.person(changed ? "admin" : "analyst");
      const { cookie } = await f.signIn(who, MICROSOFT);
      expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
      await worker
        .update(powerbiDataset)
        .set({
          relationships_source: null,
          relationships_read_at: null,
          schema_changed_at: null,
        })
        .where(eq(powerbiDataset.id, datasetId));
      const principal = viewer(await f.userId(who.email));
      const context = contextFor(principal);
      const fetchFixed = context.fetcher.fetchFixed.bind(context.fetcher);
      context.fetcher = {
        ...context.fetcher,
        fetchFixed: async (url, init) => {
          const response = await fetchFixed(url, init);
          if (changed && String(url).endsWith("/executeQueries"))
            await worker
              .update(powerbiDataset)
              .set({ schema_changed_at: new Date(Date.now() + 60_000) })
              .where(eq(powerbiDataset.id, datasetId));
          return response;
        },
      };
      const result = executeDax(context, {
        dataset: DATASET,
        dax: "EVALUATE TOPN(1, 'Date')",
      });
      if (changed)
        await expect(result).rejects.toMatchObject({ kind: "refused" });
      else expect((await result).row_count).toBeGreaterThan(0);
      const [stored] = await worker
        .select({ source: powerbiDataset.relationships_source })
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, datasetId));
      expect(stored?.source).toBe("info_view");
      expect(
        await worker
          .select()
          .from(powerbiRelationship)
          .where(eq(powerbiRelationship.dataset_id, datasetId)),
      ).not.toHaveLength(0);
      expect(await denials(principal.id)).toHaveLength(changed ? 1 : 0);
    },
  );
  it("refreshes incomplete mirrors before checking foreign keys", async () => {
    const model = f.tenant.datasets.find((d) => d.id === datasetId);
    if (model === undefined) throw new Error("missing sample dataset");
    const saved = structuredClone(model.relationships);
    const who = f.person("analyst");
    const { cookie } = await f.signIn(who, MICROSOFT);
    expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
    const principal = viewer(await f.userId(who.email));
    const context = contextFor(principal);
    context.clock = () => new Date(Date.now() + 600_000);
    const fk = () =>
      executeDax(context, {
        dataset: DATASET,
        dax: "EVALUATE VALUES(Orders_x[CustomerEmail])",
      });
    try {
      await reader
        .update(piiRule)
        .set({ table_name: "Customer_x", name: "Email" })
        .where(eq(piiRule.id, ruleId));
      model.refuses_info_views = true;
      await worker
        .update(powerbiDataset)
        .set({
          schema_error: null,
          relationships_source: null,
          relationships_read_at: null,
          schema_changed_at: null,
        })
        .where(eq(powerbiDataset.id, datasetId));
      expect(
        (
          await executeDax(context, {
            dataset: DATASET,
            dax: "EVALUATE TOPN(1, 'Date')",
          })
        ).row_count,
      ).toBeGreaterThan(0);
      expect(await denials(principal.id)).toHaveLength(0);
      const [unavailable] = await worker
        .select({ source: powerbiDataset.relationships_source })
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, datasetId));
      expect(unavailable?.source).toBe("unavailable");
      await worker
        .update(powerbiDataset)
        .set({ schema_error: "scan unavailable" })
        .where(eq(powerbiDataset.id, datasetId));
      await expect(fk()).rejects.toMatchObject({ kind: "refused" });
      await worker
        .update(powerbiDataset)
        .set({ schema_error: null })
        .where(eq(powerbiDataset.id, datasetId));
      await worker
        .update(powerbiTable)
        .set({ removed_at: new Date() })
        .where(eq(powerbiTable.dataset_id, datasetId));
      await expect(fk()).rejects.toMatchObject({ kind: "refused" });
      await worker
        .update(powerbiDataset)
        .set({ schema_error: "scan unavailable" })
        .where(eq(powerbiDataset.id, datasetId));
      await expect(fk()).rejects.toMatchObject({ kind: "refused" });
      expect(await denials(principal.id)).toHaveLength(3);
      const known = await knownTablesOf(reader, datasetId);
      if (known.names === null) throw new Error("table fold failed");
      expect(
        await checkQuery(
          reader,
          "EVALUATE VALUES('Sales lines'[Email])",
          await rules.piiNamesOf(reader, datasetId),
          known.names,
        ),
      ).toEqual(["[Email]"]);

      model.refuses_info_views = false;
      model.relationships = [
        {
          from_table: "Orders_x",
          from_column: "CustomerEmail",
          to_table: "Customer_x",
          to_column: "Email",
          from_cardinality: "Many",
          to_cardinality: "One",
          cross_filtering_behavior: "OneDirection",
          is_active: true,
        },
      ];
      await worker
        .update(powerbiDataset)
        .set({ relationships_source: null })
        .where(eq(powerbiDataset.id, datasetId));
      context.clock = () => new Date(Date.now() + 1_200_000);
      expect(
        (
          await executeDax(context, {
            dataset: DATASET,
            dax: "EVALUATE TOPN(1, 'Date')",
          })
        ).row_count,
      ).toBeGreaterThan(0);
      await expect(fk()).rejects.toMatchObject({ kind: "refused" });
      const denied = await denials(principal.id);
      expect(denied).toHaveLength(4);
      expect(denied.map((row) => row.detail)).toContainEqual({
        dataset_id: datasetId,
        references: ["[CustomerEmail]"],
      });
    } finally {
      model.relationships = saved;
      model.refuses_info_views = false;
      await reader
        .update(piiRule)
        .set({ table_name: "Sales lines", name: "Net amount" })
        .where(eq(piiRule.id, ruleId));
      await worker
        .update(powerbiTable)
        .set({ removed_at: null })
        .where(eq(powerbiTable.dataset_id, datasetId));
      await worker
        .update(powerbiDataset)
        .set({ schema_error: null })
        .where(eq(powerbiDataset.id, datasetId));
    }
  });
  it.each([
    { older: true, during: false },
    { older: false, during: false },
    { older: true, during: true },
  ])(
    "checks INFO freshness after a failed scan: %j",
    async ({ older, during }) => {
      const who = f.person("analyst");
      const { cookie } = await f.signIn(who, MICROSOFT);
      expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
      const context = contextFor(viewer(await f.userId(who.email)));
      const scan = new Date(
        Date.now() + (older ? 1_800_000 : 2_400_000) + (during ? 1_200_000 : 0),
      );
      const readAt = new Date(scan.getTime() + (older ? -60_000 : 60_000));
      const now = new Date(scan.getTime() + 120_000);
      context.clock = () => now;
      let queries = 0;
      const fetchFixed = context.fetcher.fetchFixed.bind(context.fetcher);
      context.fetcher = {
        ...context.fetcher,
        fetchFixed: async (url, init) => {
          const response = await fetchFixed(url, init);
          if (String(url).endsWith("/executeQueries")) {
            queries += 1;
            if (during)
              await worker
                .update(powerbiDataset)
                .set({ synced_at: new Date(now.getTime() + 60_000) })
                .where(eq(powerbiDataset.id, datasetId));
          }
          return response;
        },
      };
      await worker
        .update(powerbiDataset)
        .set({
          schema_error: "scan unavailable",
          synced_at: scan,
          schema_changed_at: null,
          relationships_source: "info_view",
          relationships_read_at: readAt,
        })
        .where(eq(powerbiDataset.id, datasetId));
      try {
        const result = executeDax(context, {
          dataset: DATASET,
          dax: "EVALUATE TOPN(1, 'Date')",
        });
        if (during)
          await expect(result).rejects.toMatchObject({ kind: "refused" });
        else expect((await result).row_count).toBeGreaterThan(0);
        expect(queries).toBe(during ? 3 : older ? 4 : 1);
        const [stored] = await worker
          .select({ at: powerbiDataset.relationships_read_at })
          .from(powerbiDataset)
          .where(eq(powerbiDataset.id, datasetId));
        expect(stored?.at).toEqual(older ? now : readAt);
      } finally {
        await worker
          .update(powerbiDataset)
          .set({ schema_error: null })
          .where(eq(powerbiDataset.id, datasetId));
      }
    },
  );
});
