import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { powerbiConnection } from "../../db/schema/connection.js";
import { modelViewRead, powerbiDataset } from "../../db/schema/mirror.js";
import { queryLog } from "../../db/schema/queries.js";
import { requestRate } from "../../db/schema/rate-limit.js";
import type { Principal } from "../../principal.js";
import { MICROSOFT } from "../auth/roles.js";
import { insertServiceAccount } from "../auth/service-accounts.js";
import { endConnection } from "../connection/store.js";
import { getDataset } from "../mirror/read.js";
import { countRequest } from "../rate-limit.js";
import { executeDax } from "./execute.js";

/*
 * A person's query runs with that person's own delegated token, so Power BI
 * applies their rights and their row-level security; never the scanner's,
 * the app's or another person's. The mock reads the token's oid, and so does
 * this test, from every executeQueries request the api sends.
 */

let f: SignInFixture;
let seal: SignInFixture["deps"]["vault"]["seal"];
/** The claims of each token the api sent to executeQueries, in order. */
const sent: { oid?: string; appid?: string }[] = [];
/** Every URL the api asked for, token endpoints included. */
const outbound: string[] = [];
const tokenHashes: string[] = [];
let disconnectOnQuery = false;
afterEach(() => {
  disconnectOnQuery = false;
  f.deps.vault.seal = seal;
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** The fixture gives people and groups ids of their own; the access lists still name the sample's. */
function renameAccess(tenant: Tenant): void {
  const own = [...tenant.people, ...tenant.groups];
  const original = sampleTenant();
  const ids = new Map(
    [...original.people, ...original.groups].map((item, index) => [
      item.object_id,
      own[index]?.object_id,
    ]),
  );
  for (const item of [...tenant.workspaces, ...tenant.datasets, ...tenant.apps])
    for (const entry of item.users)
      entry.object_id = ids.get(entry.object_id) ?? entry.object_id;
}

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
  seal = f.deps.vault.seal.bind(f.deps.vault);
  renameAccess(f.tenant);
  const mock = await f.settings.get("powerbi.authority");
  await f.settings.set("powerbi.api_url", `${mock}/powerbi`);
  await f.settings.set("access.metadata_visibility", "everyone");
  await loadSampleMirror(createDb(testPool("worker_rw")));
  // A result is kept only for a service account that exists.
  await insertServiceAccount(
    { ...f.deps, principal: principals.admin },
    {
      name: "sample_data_tool",
      owner_email: "tool@example.test",
      roles: ["viewer"],
    },
  );
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

function contextFor(principal: Principal): ServiceContext {
  const { fetcher } = f.deps;
  return {
    ...f.deps,
    access: cerbosAccess(f.settings),
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", "sample-app-secret"],
      ["result_link_key", "test-result-link-key"],
    ]),
    fetcher: {
      ...fetcher,
      fetchFixed: async (url, init) => {
        outbound.push(String(url));
        if (String(url).endsWith("/executeQueries")) {
          const bearer = new Headers(init?.headers).get("authorization") ?? "";
          tokenHashes.push(digest(bearer));
          const [, payload = ""] = bearer.split(".");
          sent.push(
            JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
              oid?: string;
            },
          );
          if (disconnectOnQuery)
            await f.deps.db.transaction((tx) =>
              endConnection(tx, principal.id, { status: "disconnected" }),
            );
        }
        return fetcher.fetchFixed(url, init);
      },
    },
    principal,
  };
}

async function connected(mailbox: string) {
  const who = f.person(mailbox);
  const { cookie } = await f.signIn(who, MICROSOFT);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  const id = await f.userId(who.email);
  return { who, context: contextFor({ ...principals.viewer, id }) };
}

/** A service account its admin gave the workspace. */
const serviceAccount = (workspace_id: string) =>
  contextFor({
    kind: "service_account",
    id: "sample_data_tool",
    roles: ["viewer"],
    attributes: {
      powerbi_workspace_ids: [workspace_id],
      powerbi_app_ids: [],
      powerbi_dataset_ids: [],
    },
    via: "api",
    client_id: null,
  });

const named = (name: string) => {
  const found = f.tenant.datasets.find((d) => d.name === name);
  if (found === undefined) throw new Error(`no ${name} in the sample`);
  return found;
};

describe("a query", () => {
  it("keeps separate consents for a shared account, uses each person's token and logs the account", async () => {
    const sealed: string[] = [];
    const consents = new Map<string, (string | undefined)[]>();
    f.deps.vault.seal = (token) => {
      sealed.push(digest(token));
      return seal(token);
    };
    const ids: string[] = [];
    const shared = f.person("analyst");
    for (const mailbox of ["viewer", "sales-viewer"]) {
      const who = f.person(mailbox);
      const { cookie } = await f.signIn(who, MICROSOFT);
      f.actAs(shared);
      sealed.length = 0;
      expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
      ids.push(await f.userId(who.email));
      consents.set(await f.userId(who.email), [sealed[0], sealed.at(-1)]);
      await setTimeout(1100);
    }
    const rows = await f.deps.db
      .select()
      .from(powerbiConnection)
      .where(eq(powerbiConnection.microsoft_object_id, shared.object_id));
    const own = ids.map((id) => rows.find((row) => row.user_id === id));
    expect(
      own.every((row) => row?.microsoft_object_id === shared.object_id),
    ).toBe(true);
    const hashes: string[] = [];
    tokenHashes.length = 0;
    disconnectOnQuery = true;
    for (const row of own) {
      if (
        row?.access_token_ciphertext == null ||
        row.refresh_token_ciphertext == null
      )
        throw new Error("no connected account");
      const access = await f.deps.vault.open(row.access_token_ciphertext);
      expect([
        digest(access),
        digest(await f.deps.vault.open(row.refresh_token_ciphertext)),
      ]).toEqual(consents.get(row.user_id));
      hashes.push(digest(`Bearer ${access}`));
      const result = await executeDax(
        contextFor({ ...principals.viewer, id: row.user_id }),
        { dataset: "Sales", dax: "EVALUATE 'Channel'" },
      );
      const [logged] = await f.deps.db
        .select()
        .from(queryLog)
        .where(eq(queryLog.result_id, result.result_id));
      expect(logged).toMatchObject({
        principal_id: row.user_id,
        powerbi_account: shared.user_principal_name,
      });
    }
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(tokenHashes).toEqual(hashes);
  });

  it("runs with the asking person's own token, whatever another person may reach", async () => {
    const analyst = await connected("analyst");
    const outsider = await connected("outsider");
    const query = { dataset: "Sales", dax: "EVALUATE 'Channel'" };
    sent.length = 0;
    await expect(executeDax(analyst.context, query)).resolves.toMatchObject({
      truncated: false,
    });
    await expect(executeDax(outsider.context, query)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(sent.map((claims) => claims.oid)).toEqual([
      analyst.who.object_id,
      outsider.who.object_id,
    ]);
  });

  it("runs a service account's query as the app, only when an admin allows service-account queries", async () => {
    const marketing = named("Marketing");
    const app = f.tenant.service_principals.find(
      (sp) => !sp.may_call_admin_apis,
    );
    const tool = serviceAccount(marketing.workspace_id);
    const query = {
      dataset: marketing.id,
      dax: `EVALUATE '${marketing.tables[0]?.name ?? ""}'`,
    };
    sent.length = 0;
    await expect(executeDax(tool, query)).rejects.toMatchObject({
      kind: "refused",
    });
    expect(sent).toEqual([]);
    await f.settings.set("powerbi.service_account_queries", true);
    await expect(executeDax(tool, query)).resolves.toMatchObject({
      dataset: { id: marketing.id },
    });
    expect(sent.map((claims) => [claims.oid, claims.appid])).toEqual([
      [app?.object_id, app?.app_id],
    ]);
  });

  it("is refused to a service account on a model with row-level security, before any token is fetched", async () => {
    const finance = named("Finance");
    expect(finance.has_row_level_security).toBe(true);
    await f.settings.set("powerbi.service_account_queries", true);
    outbound.length = 0;
    await expect(
      executeDax(serviceAccount(finance.workspace_id), {
        dataset: finance.id,
        dax: "EVALUATE 'Date'",
      }),
    ).rejects.toMatchObject({
      kind: "refused",
      message:
        "Finance has row-level security, and Power BI answers a model with row-level security only to a person. Ask a person to run this query.",
    });
    expect(outbound).toEqual([]);
  });

  it("is refused to a service account on a model that needs a person's identity without roles of its own, before any token is fetched", async () => {
    const archive = named("Campaign archive");
    expect(archive.has_row_level_security).toBe(false);
    await f.settings.set("powerbi.service_account_queries", true);
    outbound.length = 0;
    await expect(
      executeDax(serviceAccount(archive.workspace_id), {
        dataset: archive.id,
        dax: "EVALUATE 'Campaign'",
      }),
    ).rejects.toMatchObject({
      kind: "refused",
      message:
        "Campaign archive needs a person's identity in Power BI, through single sign-on to its source or a live connection's roles, so Power BI answers it only to a person. Ask a person to run this query.",
    });
    expect(outbound).toEqual([]);
  });
});

describe("a read of a dataset's relationships", () => {
  /** Sales unread, and nobody's five minutes counted: the queries above may have read it for the PII check. */
  async function unread() {
    const sales = named("Sales");
    await createDb(testPool("worker_rw"))
      .update(powerbiDataset)
      .set({ relationships_source: null, relationships_read_at: null })
      .where(eq(powerbiDataset.id, sales.id));
    const migrator = createDb(testPool("migrator"));
    await migrator
      .delete(requestRate)
      .where(like(requestRate.key, "relationships:%"));
    await migrator.delete(modelViewRead);
    return sales;
  }

  it("runs with each person's own token when two people overlap, each under their own limit", async () => {
    const sales = await unread();
    const people = [await connected("admin"), await connected("analyst")];
    const logged = () =>
      Promise.all(
        people.map(async ({ context }) => {
          const rows = await f.deps.db
            .select({ id: queryLog.id })
            .from(queryLog)
            .where(eq(queryLog.principal_id, context.principal.id));
          return rows.length;
        }),
      );
    const before = await logged();
    sent.length = 0;
    const answers = await Promise.all(
      people.map(({ context }) => getDataset(context, sales.id)),
    );
    for (const answer of answers)
      expect(answer.relationships_source).toBe("info_view");
    // Each reads the three INFO views (relationships, measures, columns) with their own token, and each read is logged under its own person.
    expect(sent.map((claims) => claims.oid).sort()).toEqual(
      people
        .flatMap(({ who }) => [who.object_id, who.object_id, who.object_id])
        .sort(),
    );
    expect(await logged()).toEqual(before.map((count) => count + 3));
  });

  it("never waits on another person's running read", async () => {
    const sales = await unread();
    const admin = await connected("admin");
    const analyst = await connected("analyst");
    // The admin's read is running; the analyst's own five minutes are used, with no read of theirs running.
    await f.deps.db.insert(modelViewRead).values({
      user_id: admin.context.principal.id,
      dataset_id: sales.id,
      started_at: sql`now()`,
    });
    await countRequest(
      f.deps.db,
      `relationships:${analyst.context.principal.id}:${sales.id}`,
      { window_seconds: 5 * 60, max: 1 },
      analyst.context.clock(),
    );
    sent.length = 0;
    const started = performance.now();
    const answer = await getDataset(analyst.context, sales.id);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(sent).toEqual([]);
    expect(answer.relationships_note).toMatch(
      /^Relationships are unknown for now/,
    );
  });
});
