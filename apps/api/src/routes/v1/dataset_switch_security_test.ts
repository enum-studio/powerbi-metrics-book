import { NO_SUCH_DATASET } from "../../errors.js";
import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { cerbosAccess, principals, testPool } from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import {
  fileUnder,
  id,
  metricIn,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import {
  followConnect,
  fromSpa,
  startOAuth,
  startSignIn,
  toolAnswer,
} from "../../../test/sign-in-support.js";
import { loadSampleMirror } from "../../../test/sample-mirror.js";
import { createApp } from "../../app.js";
import { metricVariant } from "../../db/schema/book.js";
import {
  buildDocuments,
  collectDocuments,
} from "../../services/search/documents.js";
import { createDb } from "../../db/client.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import { assignRole, MICROSOFT } from "../../services/auth/roles.js";

useMirror();
const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
const worker = createDb(testPool("worker_rw"));
let adminCookie = "";
let viewerCookie = "";
let metricId = "";
let variantId = "";
const mcpTokens = new Map<string, string>();

beforeAll(async () => {
  const admin = await oauth.person();
  await assignRole(
    oauth.deps.db,
    {
      role: "admin",
      subject_kind: "person",
      subject: admin.email,
    },
    principals.admin,
  );
  adminCookie = admin.cookie;
  viewerCookie = (await oauth.person()).cookie;
  metricId = await metricIn(oauth.deps.db, "dataset_switch_metric");
  await fileUnder(oauth.deps.db, metricId, id.net_sales);
  const [variant] = await oauth.deps.db
    .select()
    .from(metricVariant)
    .where(eq(metricVariant.metric_id, metricId));
  if (variant === undefined) throw new Error("Missing variant.");
  variantId = variant.id;
  for (const cookie of [viewerCookie, adminCookie])
    mcpTokens.set(
      cookie,
      (await oauth.connect(cookie, oauth.client())).access_token,
    );
});

const get = (cookie: string, path: string) =>
  oauth.request(`/api/v1${path}`, { headers: { cookie } });
async function mcp(
  cookie: string,
  name: string,
  args: object,
): Promise<unknown> {
  const token = mcpTokens.get(cookie);
  if (token === undefined) throw new Error("Missing MCP credential.");
  const answer = await oauth.request("/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(answer.status).toBe(200);
  return toolAnswer(answer);
}
async function switchDataset(enabled: boolean, dataset: string = id.sales) {
  const answer = await oauth.request(`/api/v1/admin/datasets/${dataset}`, {
    ...fromSpa(adminCookie, { enabled }),
    method: "PUT",
  });
  expect(answer.status).toBe(200);
}

describe("the dataset switch", () => {
  it("hides an off dataset from viewers and admins and restores its catalog when on", async () => {
    for (const enabled of [true, false, true]) {
      await switchDataset(enabled);
      if (enabled) await buildDocuments(worker);
      for (const cookie of [viewerCookie, adminCookie]) {
        const listed = await get(
          cookie,
          `/datasets?workspace=${id.sales_workspace}`,
        );
        expect(listed.status).toBe(200);
        const page = (await listed.json()) as { items: { id: string }[] };
        expect(page.items.map((item) => item.id)).toEqual(
          enabled ? [id.sales] : [],
        );
        const mcpList = await mcp(cookie, "list_datasets", {
          workspace: id.sales_workspace,
        });
        expect(JSON.stringify(mcpList).includes(id.sales)).toBe(enabled);
        expect(
          await mcp(cookie, "get_dataset", { id: id.sales }),
        ).toMatchObject(enabled ? { id: id.sales } : { error: "not_found" });
        if (!enabled)
          expect(
            await mcp(cookie, "execute_dax", {
              dataset: id.sales,
              dax: 'EVALUATE ROW("value", 1)',
            }),
          ).toMatchObject({ error: "not_found" });
        for (const path of [
          `/datasets/${id.sales}`,
          `/datasets/${id.sales}/columns`,
          `/datasets/${id.sales}/measures`,
          `/metrics/${metricId}`,
          `/variants/${variantId}`,
          `/metrics/${metricId}/variants`,
        ]) {
          const answer = await get(cookie, path);
          expect(answer.status, path).toBe(enabled ? 200 : 404);
        }
        const workspaces = await get(cookie, "/workspaces");
        expect(workspaces.status).toBe(200);
        expect(
          JSON.stringify(await workspaces.json()).includes(id.sales_workspace),
        ).toBe(enabled);
        const apps = await get(cookie, "/apps");
        expect(apps.status).toBe(200);
        expect(JSON.stringify(await apps.json()).includes(id.sales)).toBe(
          enabled,
        );
        for (const path of [
          "/metrics",
          "/search?query=dataset_switch_metric",
        ]) {
          const answer = await get(cookie, path);
          expect(answer.status).toBe(200);
          const body = (await answer.json()) as { items: { id: string }[] };
          expect(
            body.items.map((item) => item.id).includes(metricId),
            path,
          ).toBe(enabled);
        }
      }
      const documents = await collectDocuments(worker);
      expect(documents.some((doc) => doc.element_id === id.channel)).toBe(
        enabled,
      );
      await buildDocuments(worker);
      const adminList = await get(adminCookie, "/admin/datasets");
      expect(adminList.status).toBe(200);
      const body = (await adminList.json()) as {
        datasets: { id: string; enabled: boolean }[];
      };
      expect(body.datasets.find((item) => item.id === id.sales)).toMatchObject({
        enabled,
      });
    }
  });

  it("refuses queries while off, even for admins, and runs them again when on", async () => {
    const f = await startSignIn();
    try {
      const sample = await loadSampleMirror(worker);
      const sales = sample.tenant.datasets.find((d) =>
        d.tables.some((t) => t.name === "Sales"),
      );
      if (sales === undefined)
        throw new Error("The sample has no Sales table.");
      const originals = [...sampleTenant().people, ...sampleTenant().groups];
      const own = [...f.tenant.people, ...f.tenant.groups];
      for (const item of [
        ...f.tenant.workspaces,
        ...f.tenant.datasets,
        ...f.tenant.apps,
      ])
        for (const user of item.users) {
          const replacement =
            own[originals.findIndex((p) => p.object_id === user.object_id)];
          if (replacement !== undefined) user.object_id = replacement.object_id;
        }
      await f.settings.set(
        "powerbi.api_url",
        `${await f.settings.get("powerbi.authority")}/powerbi`,
      );
      await f.settings.set("access.metadata_visibility", "everyone");
      const app = createApp({
        ...f.deps,
        access: cerbosAccess(f.settings),
        secrets: new MemorySecrets([
          ["powerbi_app_client_secret", "sample-app-secret"],
          ["result_link_key", "test-link-key"],
        ]),
      });
      for (const role of ["viewer", "admin"] as const) {
        const who = f.person(role);
        await assignRole(
          oauth.deps.db,
          { role, subject_kind: "person", subject: who.email },
          principals.admin,
        );
        const { cookie } = await f.signIn(who, MICROSOFT);
        expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
        mcpTokens.set(
          cookie,
          (await oauth.connect(cookie, oauth.client())).access_token,
        );
        for (const enabled of [true, false, true]) {
          await switchDataset(enabled, sales.id);
          const answer = await app.request(
            "/api/v1/queries",
            fromSpa(cookie, {
              dataset: sales.id,
              dax: "EVALUATE TOPN(1, 'Date')",
            }),
          );
          expect(answer.status).toBe(enabled ? 201 : 404);
          const log = await app.request(
            `/api/v1/queries?dataset=${sales.id}&mine=true&status=succeeded`,
            { headers: { cookie } },
          );
          expect(log.status).toBe(200);
          // The connector names a parent dataset by id and name only.
          for (const [history, dataset] of [
            [
              await log.json(),
              { kind: "dataset", id: sales.id, name: sales.name },
            ],
            [
              await mcp(cookie, "search_query_log", {
                dataset: sales.id,
                mine: true,
                status: "succeeded",
              }),
              { id: sales.id, name: sales.name },
            ],
          ] as const) {
            const entry: unknown = expect.objectContaining({
              dataset,
              status: "succeeded",
            });
            const items: unknown = expect.arrayContaining([entry]);
            expect(history).toMatchObject({ items });
          }
          if (!enabled)
            expect(await answer.json()).toMatchObject({
              error: "not_found",
              message: NO_SUCH_DATASET,
            });
        }
      }
    } finally {
      await f.close();
    }
  });

  it("keeps an off Certified dataset outside describableDatasets under an override policy", async () => {
    const access = cerbosAccess(
      new MemorySettings({ "access.metadata_visibility": "policy" }),
      "override",
    );
    await worker
      .update(powerbiDataset)
      .set({ endorsement: "Certified" })
      .where(eq(powerbiDataset.id, id.sales));
    for (const enabled of [true, false, true]) {
      await switchDataset(enabled);
      for (const principal of [principals.viewer, principals.admin]) {
        const rows = await oauth.deps.db
          .select({ id: powerbiDataset.id })
          .from(powerbiDataset)
          .where(
            and(
              eq(powerbiDataset.id, id.sales),
              await access.describableDatasets(principal),
            ),
          );
        expect(rows).toEqual(enabled ? [{ id: id.sales }] : []);
        const [stored] = await oauth.deps.db
          .select({
            enabled: powerbiDataset.enabled,
            endorsement: powerbiDataset.endorsement,
          })
          .from(powerbiDataset)
          .where(eq(powerbiDataset.id, id.sales));
        if (stored === undefined) throw new Error("Missing dataset.");
        for (const action of ["describe", "query"]) {
          expect(
            await access.check(
              principal,
              { kind: "dataset", id: id.sales, attr: stored },
              action,
            ),
          ).toBe(enabled);
        }
      }
    }
  });
});
