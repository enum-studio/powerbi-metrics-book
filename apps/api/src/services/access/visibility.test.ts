import { randomUUID } from "node:crypto";
import {
  EXPECTED_QUERY_ACCESS,
  EXPECTED_VISIBILITY,
  type Person,
  sampleTenant,
} from "@powerbi-metrics-book/powerbi-mock";
import { and, asc, eq, inArray } from "drizzle-orm";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { connect, find, startPowerBi } from "../../../test/powerbi-support.js";
import { startSignIn } from "../../../test/sign-in-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import type { Db, SettingValues } from "../../context.js";
import { personIdentity, powerbiDataset } from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { executeQuery } from "../../powerbi/execute.js";
import { appServicePrincipalToken } from "../../powerbi/identity.js";
import type { Principal } from "../../principal.js";
import { personPrincipal } from "../auth/principal.js";
import { assignRole } from "../auth/roles.js";
import { runSync } from "../sync/run.js";

afterAll(closeTestPools);

/*
 * Each test syncs the sample tenant from the mock into a transaction that is
 * rolled back, records every sample person's Microsoft account and groups as
 * a fresh connection would, and asks Cerbos, under each visibility mode,
 * which datasets the person the api builds may describe.
 */

const tenant = sampleTenant();
const SALES = "Sales";
const FINANCE = "Finance";
const MARKETING = "Marketing";
const RETAIL = "Retail";
const named = <T extends { name: string }>(items: T[], name: string) =>
  find(items, (item) => item.name === name);
const everyDataset = tenant.datasets.map((d) => d.name).sort();

type Mode = SettingValues["access.metadata_visibility"];
type Synced = {
  tx: Db;
  person: (mailbox: string) => Person;
  /** A sample person, or a mailbox with no Microsoft account on record. */
  principal: (mailbox: string) => Promise<Principal>;
  describable: (principal: Principal, mode: Mode) => Promise<string[]>;
};

const userIdOf = (person: Person) => `sample-${person.object_id}`;

async function afterSync(work: (synced: Synced) => Promise<void>) {
  const { mock, deps: powerbi } = await startPowerBi(tenant);
  try {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      await runSync(
        createTestDeps({ ...powerbi, container: "worker", db: tx }),
        {
          kind: "full",
          trigger: "manual",
          poll_ms: 1,
        },
      );
      await setRole(tx, "api_rw");
      const deps = createTestDeps({ db: tx });
      const viewer = (email: string) =>
        assignRole(
          tx,
          { role: "viewer", subject_kind: "person", subject: email },
          principals.admin,
        );
      for (const person of tenant.people) {
        await tx.insert(personIdentity).values({
          user_id: userIdOf(person),
          microsoft_object_id: person.object_id,
          group_object_ids: person.group_ids,
          groups_read_at: deps.clock(),
        });
        await viewer(person.email);
      }
      const person = (mailbox: string) =>
        find(tenant.people, (p) => p.email === `${mailbox}@sample.example`);
      await work({
        tx,
        person,
        async principal(mailbox) {
          const email = `${mailbox}@sample.example`;
          const found = tenant.people.find((p) => p.email === email);
          if (found === undefined) await viewer(email);
          return personPrincipal(
            deps,
            {
              id: found === undefined ? `sample-${mailbox}` : userIdOf(found),
              email,
              email_verified: true,
            },
            { via: "browser", client_id: null },
          );
        },
        async describable(principal, mode) {
          const access = cerbosAccess(
            new MemorySettings({ "access.metadata_visibility": mode }),
          );
          const rows = await tx
            .select({ name: powerbiDataset.name })
            .from(powerbiDataset)
            .where(
              and(
                await access.describableDatasets(principal),
                inArray(
                  powerbiDataset.id,
                  tenant.datasets.map((d) => d.id),
                ),
              ),
            )
            .orderBy(asc(powerbiDataset.name));
          return rows.map((row) => row.name);
        },
      });
    });
  } finally {
    await mock.close();
  }
}

describe("a person's Power BI lists", () => {
  it("let the viewer, who reaches Sales only through the Sales app, describe Sales and not Finance", () =>
    afterSync(async ({ principal, describable }) => {
      const seen = await describable(await principal("viewer"), "powerbi");
      expect(seen).toContain(SALES);
      expect(seen).not.toContain(FINANCE);
    }));

  it("give every sample person exactly the datasets EXPECTED_VISIBILITY names under powerbi", () =>
    afterSync(async ({ principal, describable }) => {
      const seen: Record<string, string[]> = {};
      for (const email of Object.keys(EXPECTED_VISIBILITY))
        seen[email] = await describable(
          await principal(email.replace("@sample.example", "")),
          "powerbi",
        );
      expect(seen).toEqual(
        Object.fromEntries(
          Object.entries(EXPECTED_VISIBILITY).map(([email, names]) => [
            email,
            [...names].sort(),
          ]),
        ),
      );
    }));

  it("name the Sales app and nothing else for the viewer", () =>
    afterSync(async ({ principal }) => {
      expect((await principal("viewer")).attributes).toEqual({
        powerbi_workspace_ids: [],
        powerbi_app_ids: [named(tenant.apps, "Sales app").id],
        powerbi_dataset_ids: [],
      });
    }));

  it("reach the analyst's Sales through the Analysts group and Marketing through a direct share", () =>
    afterSync(async ({ tx, person, principal, describable }) => {
      expect((await principal("analyst")).attributes).toEqual({
        powerbi_workspace_ids: [named(tenant.workspaces, SALES).id],
        powerbi_app_ids: [],
        powerbi_dataset_ids: [named(tenant.datasets, MARKETING).id],
      });
      await tx
        .update(personIdentity)
        .set({ group_object_ids: [] })
        .where(
          eq(personIdentity.microsoft_object_id, person("analyst").object_id),
        );
      expect(await describable(await principal("analyst"), "powerbi")).toEqual([
        MARKETING,
      ]);
    }));

  it("leave the outsider and a person with no Microsoft account on record nothing under powerbi", () =>
    afterSync(async ({ principal, describable }) => {
      for (const mailbox of ["outsider", "never-connected"]) {
        const nobody = await principal(mailbox);
        expect(nobody.attributes, mailbox).toEqual({
          powerbi_workspace_ids: [],
          powerbi_app_ids: [],
          powerbi_dataset_ids: [],
        });
        expect(await describable(nobody, "powerbi"), mailbox).toEqual([]);
      }
    }));

  it("give every dataset to anyone under everyone, and none under policy with the default policies", () =>
    afterSync(async ({ principal, describable }) => {
      expect(
        await describable(await principal("outsider"), "everyone"),
      ).toEqual(everyDataset);
      expect(await describable(await principal("admin"), "policy")).toEqual([]);
    }));

  it("send each list as one parameter, so 70,000 ids reach what they name", () =>
    afterSync(async ({ tx, person, principal, describable }) => {
      const padded = (id: string) => [
        id,
        ...Array.from({ length: 70_000 }, () => randomUUID()),
      ];
      await tx
        .update(personIdentity)
        .set({ group_object_ids: padded(person("analyst").group_ids[0] ?? "") })
        .where(
          eq(personIdentity.microsoft_object_id, person("analyst").object_id),
        );
      expect(await describable(await principal("analyst"), "powerbi")).toEqual([
        MARKETING,
        RETAIL,
        SALES,
      ]);
      // One long list at a time: Cerbos takes a request of at most 4 MB.
      const reaching = (
        kind: Principal["kind"],
        lists: Principal["attributes"],
      ): Principal => ({
        ...principals.viewer,
        kind,
        attributes: { ...principals.viewer.attributes, ...lists },
      });
      const sales = named(tenant.workspaces, SALES).id;
      const leadership = named(tenant.apps, "Leadership app").id;
      for (const kind of ["person", "service_account"] as const) {
        expect(
          await describable(
            reaching(kind, { powerbi_workspace_ids: padded(sales) }),
            "powerbi",
          ),
          kind,
        ).toEqual([RETAIL, SALES]);
        expect(
          await describable(
            reaching(kind, { powerbi_app_ids: padded(leadership) }),
            "powerbi",
          ),
          kind,
        ).toEqual([FINANCE]);
      }
    }));
});

describe("the mock against EXPECTED_QUERY_ACCESS", () => {
  it("answers each principal's query on the org path and the groups path as it says, with tokens from the identity routes", async () => {
    // Revoked lists are as anyone's; the revoked person is asked after reconnecting.
    const reconnected = {
      ...tenant,
      people: tenant.people.map((p) => ({ ...p, revoked: false })),
    };
    const fixture = await startPowerBi(reconnected);
    const { mock, deps } = fixture;
    const dax = "EVALUATE TOPN(1, 'Date')";
    const tokenFor = async (principal: string) => {
      const found = reconnected.people.find((p) => p.email === principal);
      if (found !== undefined)
        return (await connect(fixture, found)).access_token;
      expect(principal).toBe(await deps.settings.get("powerbi.app_client_id"));
      return appServicePrincipalToken(deps);
    };
    // The api queries on the org path only, so the groups path has no client.
    const onGroupsPath = async (token: string, dataset_id: string) => {
      const { workspace_id } = find(
        tenant.datasets,
        (d) => d.id === dataset_id,
      );
      const answer = await request(
        `${mock.url}/powerbi/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ queries: [{ query: dax }] }),
        },
      );
      await answer.body.dump();
      return answer.statusCode === 200;
    };
    const onOrgPath = (token: string, dataset_id: string) =>
      executeQuery(deps, { token, dataset_id, dax, timeout_ms: 10_000 }).then(
        () => true,
        (error: unknown) => {
          if (error instanceof ServiceError && error.kind === "not_found")
            return false;
          throw error;
        },
      );
    try {
      const actual: typeof EXPECTED_QUERY_ACCESS = {};
      for (const [principal, byDataset] of Object.entries(
        EXPECTED_QUERY_ACCESS,
      )) {
        const token = await tokenFor(principal);
        actual[principal] = {};
        for (const name of Object.keys(byDataset)) {
          const { id } = named(tenant.datasets, name);
          actual[principal][name] = {
            org_path: await onOrgPath(token, id),
            groups_path: await onGroupsPath(token, id),
          };
        }
      }
      expect(actual).toEqual(EXPECTED_QUERY_ACCESS);
    } finally {
      await mock.close();
    }
  });
});

describe("authenticate", () => {
  it("fills the lists of a person signed in with Microsoft, from their session", async () => {
    const f = await startSignIn();
    // These sign-ins reach their people through the default role.
    await f.settings.set("access.default_role", "viewer");
    // The fixture gives people and groups ids of its own; its access lists follow them.
    const own = new Map([
      ...tenant.people.map((p) => {
        const mailbox = p.email.replace("@sample.example", "");
        return [p.object_id, f.person(mailbox).object_id] as const;
      }),
      ...tenant.groups.map((g) => [g.object_id, f.group(g.name)] as const),
    ]);
    for (const listed of [
      ...f.tenant.workspaces,
      ...f.tenant.datasets,
      ...f.tenant.apps,
    ])
      listed.users = listed.users.map((entry) => ({
        ...entry,
        object_id: own.get(entry.object_id) ?? entry.object_id,
      }));
    const { mock, deps: powerbi } = await startPowerBi(f.tenant);
    try {
      // The app reads through its own pool, so this sync commits, in this file's own database.
      await runSync(createTestDeps({ ...powerbi, container: "worker" }), {
        kind: "full",
        trigger: "manual",
        poll_ms: 1,
      });
      f.app.get("/api/v1/test/principal", (c) =>
        c.json(c.get("principal") ?? null),
      );
      const { cookie } = await f.signIn(f.person("analyst"), "microsoft");
      const answer = await f.request("/api/v1/test/principal", {
        headers: { cookie },
      });
      expect(await answer.json()).toMatchObject({
        kind: "person",
        via: "browser",
        attributes: {
          powerbi_workspace_ids: [named(f.tenant.workspaces, SALES).id],
          powerbi_app_ids: [],
          powerbi_dataset_ids: [named(f.tenant.datasets, MARKETING).id],
        },
      });
    } finally {
      await mock.close();
      await f.close();
    }
  });
});
