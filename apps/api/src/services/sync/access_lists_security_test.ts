import { randomUUID } from "node:crypto";
import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { find, startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { powerbiAttributes } from "../access/visibility.js";
import { runSync } from "./run.js";
import { storeWorkspace } from "./store.js";

afterAll(closeTestPools);

/*
 * Boundary B5, the mirror's access lists: who may see a workspace or a
 * dataset is what Power BI's lists give. A list Power BI does not send keeps
 * its rows, one it sends empty revokes, and a row that names no email reaches
 * only the object id it names.
 */

const reachOf = async (
  tx: Db,
  holder: {
    microsoft_object_id: string | null;
    group_object_ids?: string[];
  },
) => {
  await setRole(tx, "api_rw");
  return powerbiAttributes(tx, {
    kind: "person",
    microsoft_object_id: holder.microsoft_object_id,
    group_object_ids: holder.group_object_ids ?? [],
  });
};

describe("an access list Power BI does not send", () => {
  it("keeps the rows of a workspace whose users is null, and users: [] still revokes", async () => {
    const tenant = sampleTenant();
    const sales = find(tenant.workspaces, (w) => w.name === "Commercial");
    const viewer = find(
      tenant.people,
      (p) => p.email === "sales-viewer@sample.example",
    ).object_id;
    const { mock, deps: powerbi } = await startPowerBi(tenant);
    try {
      await rolledBack(TEST_RUNNER, async (tx) => {
        const deps = createTestDeps({
          ...powerbi,
          container: "worker",
          db: tx,
        });
        const sync = async () => {
          await setRole(tx, "worker_rw");
          return runSync(deps, {
            kind: "full",
            trigger: "manual",
            poll_ms: 1,
          });
        };
        const reaches = async () =>
          (await reachOf(tx, { microsoft_object_id: viewer }))
            .powerbi_workspace_ids;

        await sync();
        expect(await reaches()).toContain(sales.id);

        sales.users_unlisted = true;
        const unsent = await sync();
        expect(await reaches()).toContain(sales.id);
        expect(unsent.counts.access_lists_unsent).toBe(1);

        sales.users_unlisted = false;
        sales.users = [];
        await sync();
        expect(await reaches()).not.toContain(sales.id);
      });
    } finally {
      await mock.close();
    }
  });
});

describe("an access row with no email", () => {
  it("reaches only the object id it names, and no other person with a null or empty email", async () => {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const person = randomUUID();
      const group = randomUUID();
      const blank = randomUUID();
      const other = randomUUID();
      const named = randomUUID();
      const otherGroup = randomUUID();
      const stranger = randomUUID();
      const entry = (
        principal_type: "user" | "group",
        principal_object_id: string,
        email: string | null,
      ) => ({
        principal_type,
        principal_object_id,
        email,
        access_right: "Viewer",
      });
      const store = (id: string, users: ReturnType<typeof entry>[]) =>
        storeWorkspace(
          tx,
          { id, name: id, state: "active", users },
          new Date(),
          true,
        );
      const byPerson = randomUUID();
      const byGroup = randomUUID();
      const byBlank = randomUUID();
      await store(byPerson, [entry("user", person, null)]);
      await store(byGroup, [entry("group", group, null)]);
      await store(byBlank, [entry("user", blank, "")]);
      // A named person on another workspace, so a match on email alone would show.
      await store(randomUUID(), [entry("user", other, "someone@example.test")]);

      const reach = async (holder: Parameters<typeof reachOf>[1]) =>
        (await reachOf(tx, holder)).powerbi_workspace_ids;

      expect(await reach({ microsoft_object_id: person })).toEqual([byPerson]);
      expect(await reach({ microsoft_object_id: blank })).toEqual([byBlank]);
      expect(
        await reach({ microsoft_object_id: null, group_object_ids: [group] }),
      ).toEqual([byGroup]);
      // A group's object id is not a person's, and a person's is not a group's.
      expect(await reach({ microsoft_object_id: group })).toEqual([]);
      expect(
        await reach({ microsoft_object_id: null, group_object_ids: [person] }),
      ).toEqual([]);
      // Nobody with no object id, and nobody else, matches the rows with no email.
      expect(await reach({ microsoft_object_id: null })).toEqual([]);
      expect(await reach({ microsoft_object_id: stranger })).toEqual([]);
      expect(
        await reach({
          microsoft_object_id: named,
          group_object_ids: [otherGroup],
        }),
      ).toEqual([]);
    });
  });
});
