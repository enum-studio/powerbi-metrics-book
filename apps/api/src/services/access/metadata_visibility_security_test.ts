import { randomUUID } from "node:crypto";
import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { find, startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import type { Db, ServiceContext, SettingValues } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import {
  metric,
  metricVariant,
  term,
  termColumn,
} from "../../db/schema/book.js";
import {
  personIdentity,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
} from "../../db/schema/mirror.js";
import { personSignIn } from "../../db/schema/roles.js";
import { ServiceError } from "../../errors.js";
import { MICROSOFT, SIGN_IN_FRESH_MS, assignRole } from "../auth/roles.js";
import { personPrincipal } from "../auth/principal.js";
import { getMetric, listMetrics } from "../book/metrics.js";
import { getTerm, listTerms } from "../book/terms.js";
import { listVariants } from "../book/variants.js";
import { getDataset, listApps, listDatasets } from "../mirror/read.js";
import { runSync, type SyncOutcome } from "../sync/run.js";

afterAll(closeTestPools);

/*
 * Under metadata_visibility: powerbi a person sees only what Power BI's
 * access lists give their current Microsoft account and Entra groups. Each
 * test syncs a tenant from the mock into a transaction that is rolled back,
 * records each sample person's account and groups as read now, and asks the
 * services as the api would.
 */

const SALES = "Sales";
const MARKETING = "Marketing";
const RETAIL = "Retail";
const FINANCE = "Finance";
const userIdOf = (mailbox: string) => `sample-${mailbox}`;
const named = <T extends { name: string }>(items: T[], name: string) =>
  find(items, (item) => item.name === name);
const personIn = (tenant: Tenant, mailbox: string) =>
  find(tenant.people, (p) => p.email === `${mailbox}@sample.example`);
const stale = () => new Date(Date.now() - SIGN_IN_FRESH_MS - 60_000);

async function afterSync(
  tenant: Tenant,
  work: (
    tx: Db,
    as: (mailbox: string) => Promise<ServiceContext>,
    synced: SyncOutcome,
  ) => Promise<void>,
  visibility: {
    mode: SettingValues["access.metadata_visibility"];
    policies: "defaults" | "override";
  } = { mode: "powerbi", policies: "defaults" },
) {
  const { mock, deps: powerbi } = await startPowerBi(tenant);
  try {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const synced = await runSync(
        createTestDeps({ ...powerbi, container: "worker", db: tx }),
        { kind: "full", trigger: "manual", poll_ms: 1 },
      );
      await setRole(tx, "api_rw");
      const settings = new MemorySettings({
        "access.metadata_visibility": visibility.mode,
      });
      const deps = createTestDeps({
        db: tx,
        settings,
        access: cerbosAccess(settings, visibility.policies),
      });
      for (const person of tenant.people) {
        const mailbox = person.email.replace("@sample.example", "");
        await tx.insert(personIdentity).values({
          user_id: userIdOf(mailbox),
          microsoft_object_id: person.object_id,
          group_object_ids: person.group_ids,
          groups_read_at: deps.clock(),
        });
        await assignRole(
          tx,
          { role: "viewer", subject_kind: "person", subject: person.email },
          principals.admin,
        );
      }
      const as = async (mailbox: string) => ({
        ...deps,
        principal: await personPrincipal(
          deps,
          {
            id: userIdOf(mailbox),
            email: `${mailbox}@sample.example`,
            email_verified: true,
          },
          { via: "mcp", client_id: null },
        ),
      });
      await work(tx, as, synced);
    });
  } finally {
    await mock.close();
  }
}

/** A sign-in through `provider` at `at`, as sign-in records it. */
async function signedIn(
  tx: Db,
  mailbox: string,
  sign_in: { provider: string; at: Date; group_ids?: string[] },
) {
  await tx
    .insert(user)
    .values({
      id: userIdOf(mailbox),
      name: mailbox,
      email: `${mailbox}@sample.example`,
    })
    .onConflictDoNothing();
  const values = {
    signed_in_at: sign_in.at,
    group_ids: sign_in.group_ids ?? null,
  };
  await tx
    .insert(personSignIn)
    .values({
      user_id: userIdOf(mailbox),
      provider: sign_in.provider,
      ...values,
    })
    .onConflictDoUpdate({
      target: [personSignIn.user_id, personSignIn.provider],
      set: values,
    });
}

const shown = async (context: ServiceContext) =>
  (await listDatasets(context)).items.map((d) => d.name);

async function expectMetricDatasetCount(context: ServiceContext, name: string) {
  const listed = await listMetrics(context, { name_prefix: name, limit: 500 });
  const item = listed.items.find((candidate) => candidate.name === name);
  if (item === undefined)
    throw new Error(`${name} is not visible in the metric list`);
  const variants = await listVariants(context, name, { limit: 500 });
  expect(item.dataset_count).toBe(
    new Set(variants.items.map((variant) => variant.dataset.id)).size,
  );
}

describe("metric dataset counts follow visible variants", () => {
  it("does not count a dataset the person cannot see", () =>
    afterSync(sampleTenant(), async (_tx, as) => {
      const analyst = await as("analyst");
      const viewer = await as("viewer");
      const analystVariants = await listVariants(analyst, "orders", {
        limit: 500,
      });
      const viewerVariants = await listVariants(viewer, "orders", {
        limit: 500,
      });
      expect(
        analystVariants.items.map((variant) => variant.dataset.name),
      ).toContain(MARKETING);
      expect(
        viewerVariants.items.map((variant) => variant.dataset.name),
      ).not.toContain(MARKETING);
      await expectMetricDatasetCount(viewer, "orders");
    }));

  it.each(["powerbi", "everyone", "policy"] as const)(
    "matches a person's variants under metadata_visibility: %s",
    (mode) =>
      afterSync(
        sampleTenant(),
        async (tx, as) => {
          if (mode === "policy") {
            await setRole(tx, "worker_rw");
            await tx
              .update(powerbiDataset)
              .set({ endorsement: "Certified" })
              .where(
                eq(powerbiDataset.id, named(sampleTenant().datasets, SALES).id),
              );
            await setRole(tx, "api_rw");
          }
          const viewer = await as("viewer");
          await expectMetricDatasetCount(viewer, "orders");
        },
        {
          mode,
          policies: mode === "policy" ? "override" : "defaults",
        },
      ),
  );

  it("keeps a service account's count inside its workspace grant", () =>
    afterSync(sampleTenant(), async (_tx, as) => {
      const viewer = await as("viewer");
      const salesWorkspace = named(sampleTenant().workspaces, SALES).id;
      const serviceAccount: ServiceContext = {
        ...viewer,
        principal: {
          ...viewer.principal,
          kind: "service_account",
          id: "sample-sales-only",
          via: "api",
          attributes: {
            powerbi_workspace_ids: [salesWorkspace],
            powerbi_app_ids: [],
            powerbi_dataset_ids: [],
          },
        },
      };
      await expectMetricDatasetCount(serviceAccount, "orders");
      const variants = await listVariants(serviceAccount, "orders", {
        limit: 500,
      });
      expect(
        variants.items.map((variant) => variant.dataset.name),
      ).not.toContain(MARKETING);
    }));

  it("drops switched-off datasets from metric and term counts and backing", () =>
    afterSync(sampleTenant(), async (tx, as) => {
      const sales = named(sampleTenant().datasets, SALES);
      const marketing = named(sampleTenant().datasets, MARKETING);
      const viewer = await as("analyst");
      const beforeMetric = await listMetrics(viewer, {
        name_prefix: "orders",
      });
      const beforeOrders = beforeMetric.items.find(
        (item) => item.name === "orders",
      );
      if (beforeOrders === undefined) throw new Error("orders is not visible");
      const [salesColumn] = await tx
        .select({ id: powerbiColumn.id })
        .from(powerbiColumn)
        .where(eq(powerbiColumn.dataset_id, sales.id))
        .limit(1);
      const [marketingColumn] = await tx
        .select({ id: powerbiColumn.id })
        .from(powerbiColumn)
        .where(eq(powerbiColumn.dataset_id, marketing.id))
        .limit(1);
      if (salesColumn === undefined || marketingColumn === undefined)
        throw new Error("A sample dataset has no columns");
      const [salesTerm] = await tx
        .insert(term)
        .values({ name: `sales_switch_${randomUUID()}` })
        .returning({ id: term.id, name: term.name });
      if (salesTerm === undefined) throw new Error("The term was not created");
      await tx.insert(termColumn).values([
        { term_id: salesTerm.id, column_id: salesColumn.id },
        { term_id: salesTerm.id, column_id: marketingColumn.id },
      ]);
      const beforeTerms = await listTerms(viewer, {
        name_prefix: salesTerm.name,
      });
      expect(beforeTerms.items[0]?.column_count).toBe(2);
      await setRole(tx, "worker_rw");
      await tx
        .update(powerbiDataset)
        .set({ enabled: false })
        .where(eq(powerbiDataset.id, sales.id));
      await setRole(tx, "api_rw");

      const afterMetric = await listMetrics(viewer, { name_prefix: "orders" });
      const afterOrders = afterMetric.items.find(
        (item) => item.name === "orders",
      );
      if (afterOrders === undefined) throw new Error("orders is not visible");
      expect(afterOrders.dataset_count).toBe(beforeOrders.dataset_count - 1);
      const afterTerms = await listTerms(viewer, {
        name_prefix: salesTerm.name,
      });
      expect(afterTerms.items[0]?.column_count).toBe(1);
      expect(afterTerms.items[0]?.type).toBe("dimension");
      const detail = await getTerm(viewer, salesTerm.id);
      expect(detail.columns).toHaveLength(1);
      expect(detail.type).toBe("dimension");
    }));
});

/** What a refusal shows its caller, with the name it was asked for taken out. */
async function refusal(answer: Promise<unknown>, asked: string) {
  const error = await answer.then(
    () => expect.fail("answered"),
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ServiceError)) throw error;
  const { kind, message, detail } = error;
  return { kind, message: message.replace(asked, "<asked>"), detail };
}

describe("metadata Power BI does not show a person", () => {
  it("answers the outsider's list, dataset and metric exactly like missing ones", () =>
    afterSync(sampleTenant(), async (tx, as) => {
      const finance = named(sampleTenant().datasets, FINANCE).id;
      const [filed] = await tx
        .select({ name: metric.name })
        .from(metricVariant)
        .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
        .innerJoin(
          powerbiMeasure,
          eq(powerbiMeasure.id, metricVariant.measure_id),
        )
        .where(eq(powerbiMeasure.dataset_id, finance))
        .limit(1);
      if (filed === undefined)
        throw new Error("the sync filed no Finance metric");

      const leader = await as("leader");
      expect(await shown(leader)).toEqual([FINANCE]);
      await getDataset(leader, finance);
      await getMetric(leader, filed.name);

      const outsider = await as("outsider");
      expect(await listDatasets(outsider)).toEqual({
        total: 0,
        items: [],
        next_cursor: null,
      });
      const missing = randomUUID();
      expect(await refusal(getDataset(outsider, finance), finance)).toEqual(
        await refusal(getDataset(outsider, missing), missing),
      );
      expect(
        await refusal(getMetric(outsider, filed.name), filed.name),
      ).toEqual(await refusal(getMetric(outsider, missing), missing));
    }));

  it("counts no Entra group read more than seven days ago, whatever the account", () =>
    afterSync(sampleTenant(), async (tx, as) => {
      expect(await shown(await as("analyst"))).toContain(SALES);
      await signedIn(tx, "analyst", { provider: MICROSOFT, at: new Date() });
      await tx
        .update(personIdentity)
        .set({ groups_read_at: stale() })
        .where(eq(personIdentity.user_id, userIdOf("analyst")));
      // The account signed in today keeps the share made to it alone.
      expect(await shown(await as("analyst"))).toEqual(["Marketing"]);
    }));

  it("matches no Microsoft account whose connection ended more than seven days ago", () =>
    afterSync(sampleTenant(), async (tx, as) => {
      // An ended connection clears groups_read_at (endConnection).
      await tx
        .update(personIdentity)
        .set({ groups_read_at: null })
        .where(eq(personIdentity.user_id, userIdOf("sales-viewer")));
      await signedIn(tx, "sales-viewer", { provider: MICROSOFT, at: stale() });
      const viewer = await as("sales-viewer");
      expect(viewer.principal.attributes.powerbi_workspace_ids).toEqual([]);
      expect(await shown(viewer)).toEqual([]);
      await signedIn(tx, "sales-viewer", {
        provider: MICROSOFT,
        at: new Date(),
      });
      expect(await shown(await as("sales-viewer"))).toEqual([RETAIL, SALES]);
    }));

  it("matches no connected account that Microsoft has not proved for seven days, and never revives its groups", () =>
    afterSync(sampleTenant(), async (tx, as) => {
      const analyst = personIn(sampleTenant(), "analyst");
      await tx
        .insert(user)
        .values({
          id: userIdOf("analyst"),
          name: "analyst",
          email: analyst.email,
        })
        .onConflictDoNothing();
      // Connected eight days ago, its groups read then: the connection, not
      // person_identity, is what a connected person is seen through.
      await tx.insert(powerbiConnection).values({
        user_id: userIdOf("analyst"),
        microsoft_object_id: analyst.object_id,
        group_object_ids: analyst.group_ids,
        groups_read_at: stale(),
        // Read a moment ago and failed, so using the principal reads nothing.
        groups_attempted_at: new Date(),
        access_token_ciphertext: new Uint8Array([1]),
        access_token_expires_at: new Date(),
        refresh_token_ciphertext: new Uint8Array([1]),
        recipient: "age1unused",
        status: "connected",
        connected_at: stale(),
      });
      const connected = await as("analyst");
      expect(connected.principal.attributes.powerbi_workspace_ids).toEqual([]);
      expect(await shown(connected)).toEqual([]);
      // Connected again today: the account counts, its stale groups do not.
      await tx
        .update(powerbiConnection)
        .set({ connected_at: new Date() })
        .where(eq(powerbiConnection.user_id, userIdOf("analyst")));
      expect(await shown(await as("analyst"))).toEqual([MARKETING]);
    }));

  it("never takes a group another sign-in provider names for an Entra group", () =>
    afterSync(sampleTenant(), async (tx, as) => {
      await signedIn(tx, "outsider", {
        provider: "sample_oidc",
        at: new Date(),
        group_ids: personIn(sampleTenant(), "analyst").group_ids,
      });
      const outsider = await as("outsider");
      expect(outsider.principal.attributes.powerbi_workspace_ids).toEqual([]);
      expect(await shown(outsider)).toEqual([]);
    }));

  it("gives nothing for an access-list entry whose right is None or missing, and counts the missing", () => {
    const tenant = sampleTenant();
    const none = personIn(tenant, "sales-viewer").object_id;
    for (const workspace of tenant.workspaces)
      workspace.users = workspace.users.map((entry) =>
        entry.object_id === none ? { ...entry, access_right: "None" } : entry,
      );
    // The mock writes the right under its key; without one, the entry names none.
    const missing = personIn(tenant, "app-reader").object_id;
    for (const app of tenant.apps)
      for (const entry of app.users)
        if (entry.object_id === missing)
          Reflect.deleteProperty(entry, "access_right");
    return afterSync(tenant, async (_tx, as, synced) => {
      expect(await shown(await as("sales-viewer"))).toEqual([]);
      expect(await shown(await as("app-reader"))).toEqual([]);
      expect(await shown(await as("viewer"))).toEqual([RETAIL, SALES]);
      expect(synced.counts.access_without_right).toBe(1);
    });
  });
});

describe("listApps, as the visibility mode shows datasets", () => {
  const SALES_APP = "Sales app";
  const LEADERSHIP_APP = "Leadership app";
  /** Each app the caller sees, with the datasets it shows them. */
  const appsOf = async (context: ServiceContext) =>
    (await listApps(context)).map((app) => [
      app.name,
      app.datasets.map((d) => d.name),
    ]);

  it("under powerbi, lists no app outside the person's audience and workspaces, though it shows a dataset they may describe", () => {
    // The Leadership app, in Finance, also shows Sales through a report bound to it.
    const tenant = sampleTenant();
    const report = randomUUID();
    const leadership = named(tenant.apps, LEADERSHIP_APP);
    tenant.reports.push({
      id: report,
      name: "Leadership sales",
      dataset_id: named(tenant.datasets, SALES).id,
      app_id: leadership.id,
    });
    leadership.report_ids.push(report);
    named(tenant.workspaces, FINANCE).report_ids.push(report);
    return afterSync(tenant, async (_tx, as) => {
      // The analyst reaches Sales only through the Sales workspace's list.
      expect(await appsOf(await as("analyst"))).toEqual([
        [SALES_APP, [RETAIL, SALES]],
      ]);
      expect(await appsOf(await as("leader"))).toEqual([
        [LEADERSHIP_APP, [FINANCE, SALES]],
      ]);
    });
  });

  it("under everyone, lists every app to the outsider", () =>
    afterSync(
      sampleTenant(),
      async (_tx, as) => {
        expect(await appsOf(await as("outsider"))).toEqual([
          [LEADERSHIP_APP, [FINANCE]],
          [SALES_APP, [RETAIL, SALES]],
        ]);
      },
      { mode: "everyone", policies: "defaults" },
    ));

  it("under policy, lists an app whose workspace holds, or which shows, a dataset the policy lets the caller describe", () => {
    // The Leadership app, in Finance, shows Sales alone.
    const tenant = sampleTenant();
    const sales = named(tenant.datasets, SALES).id;
    named(tenant.reports, "Leadership overview").dataset_id = sales;
    return afterSync(
      tenant,
      async (tx, as) => {
        // The example deployment opens certified datasets to everyone signed in.
        const certify = async (id: string) => {
          await setRole(tx, "worker_rw");
          await tx
            .update(powerbiDataset)
            .set({ endorsement: "Certified" })
            .where(eq(powerbiDataset.id, id));
          await setRole(tx, "api_rw");
        };
        expect(await appsOf(await as("outsider"))).toEqual([]);
        await certify(named(tenant.datasets, FINANCE).id);
        expect(await appsOf(await as("outsider"))).toEqual([
          [LEADERSHIP_APP, []],
        ]);
        await certify(sales);
        expect(await appsOf(await as("outsider"))).toEqual([
          [LEADERSHIP_APP, [SALES]],
          [SALES_APP, [SALES]],
        ]);
      },
      { mode: "policy", policies: "override" },
    );
  });
});
