import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it } from "vitest";
import type { Resource } from "../../context.js";
import type { Principal } from "../../principal.js";
import { cerbosAccess, principals } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { createAccess } from "./cerbos.js";

/*
 * The client's own work, against the real Cerbos: the visibility mode read
 * from settings on every call, how a refusal is thrown, and the bound on a
 * service account. The rules themselves are tested in access/tests.
 */

const dataset: Resource = {
  kind: "dataset",
  id: randomUUID(),
  attr: { workspace_id: randomUUID(), app_ids: [], enabled: true },
};

const off: Resource = { ...dataset, attr: { ...dataset.attr, enabled: false } };
const PII: Resource = { kind: "pii", id: "pii", attr: {} };

/** Nothing listens here, so any answer at all was given before Cerbos. */
function deadCerbos() {
  return createAccess({
    cerbosUrl: new URL("http://127.0.0.1:9"),
    settings: new MemorySettings(),
  });
}

/** A Cerbos whose deployment policy allows every action to everyone. */
const allowsAll = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += String(chunk);
  });
  request.on("end", () => {
    const { resources } = JSON.parse(body) as {
      resources: { actions: string[]; resource: object }[];
    };
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        results: resources.map(({ actions, resource }) => ({
          resource,
          actions: Object.fromEntries(
            actions.map((action) => [action, "EFFECT_ALLOW"]),
          ),
        })),
      }),
    );
  });
});
const stubbed = new Promise<URL>((resolve) =>
  allowsAll.listen(0, "127.0.0.1", () => {
    const address = allowsAll.address() as AddressInfo;
    resolve(new URL(`http://127.0.0.1:${String(address.port)}`));
  }),
);
afterAll(() => void allowsAll.close());

function serviceAccount(workspaceIds: string[]): Principal {
  const { attributes } = principals.viewer;
  return {
    ...principals.viewer,
    kind: "service_account",
    attributes: { ...attributes, powerbi_workspace_ids: workspaceIds },
  };
}

describe("createAccess", () => {
  it("refuses a service account a dataset outside its grant without asking Cerbos", async () => {
    // Nothing listens here, so any answer at all was given before Cerbos.
    const access = createAccess({
      cerbosUrl: new URL("http://127.0.0.1:9"),
      settings: new MemorySettings({
        "access.metadata_visibility": "everyone",
      }),
    });
    const elsewhere = serviceAccount([randomUUID()]);
    expect(await access.check(elsewhere, dataset, "describe")).toBe(false);
    await expect(
      access.require(elsewhere, dataset, "query"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("asks Cerbos about a dataset inside a service account's grant", async () => {
    const access = cerbosAccess(new MemorySettings());
    const granted = serviceAccount([String(dataset.attr.workspace_id)]);
    expect(await access.check(granted, dataset, "query")).toBe(true);
  });

  it("keeps a service account to its grant when a deployment policy widens", async () => {
    // The example deployment opens certified datasets to everyone signed in.
    const access = cerbosAccess(new MemorySettings(), "override");
    const certified: Resource = {
      ...dataset,
      attr: { ...dataset.attr, endorsement: "Certified" },
    };
    expect(await access.check(principals.viewer, certified, "describe")).toBe(
      true,
    );
    expect(await access.check(serviceAccount([]), certified, "describe")).toBe(
      false,
    );
    const granted = serviceAccount([String(dataset.attr.workspace_id)]);
    expect(await access.check(granted, certified, "query")).toBe(true);
  });

  it.each(["powerbi_workspace_ids", "powerbi_app_ids", "powerbi_dataset_ids"])(
    "throws for a principal with no %s, on a check and on lists",
    async (list) => {
      const access = cerbosAccess(new MemorySettings());
      for (const whole of [principals.viewer, serviceAccount([])]) {
        const principal: Principal = {
          ...whole,
          attributes: Object.fromEntries(
            Object.entries(whole.attributes).filter(([name]) => name !== list),
          ),
        };
        await expect(
          access.check(principal, dataset, "describe"),
        ).rejects.toThrow(`has no ${list}`);
        await expect(access.describableDatasets(principal)).rejects.toThrow(
          `has no ${list}`,
        );
      }
    },
  );

  it("reads access.metadata_visibility on every call", async () => {
    const settings = new MemorySettings();
    const access = cerbosAccess(settings);
    expect(await access.check(principals.viewer, dataset, "describe")).toBe(
      false,
    );
    await settings.set("access.metadata_visibility", "everyone");
    expect(await access.check(principals.viewer, dataset, "describe")).toBe(
      true,
    );
  });

  it("refuses a dataset as not_found, so it answers like a missing one", async () => {
    const access = cerbosAccess(new MemorySettings());
    await expect(
      access.require(principals.viewer, dataset, "query"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses anything else as refused, and lets an allowed action through", async () => {
    const access = cerbosAccess(new MemorySettings());
    const book: Resource = { kind: "book", id: "book", attr: {} };
    await expect(
      access.require(principals.viewer, book, "curate"),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(
      access.require(principals.curator, book, "curate"),
    ).resolves.toBeUndefined();
  });

  it.each(["describe", "query"])(
    "refuses an admin %s on an off dataset without asking Cerbos",
    async (action) => {
      const access = deadCerbos();
      expect(await access.check(principals.admin, off, action)).toBe(false);
      await expect(
        access.require(principals.admin, off, action),
      ).rejects.toMatchObject({ kind: "not_found" });
    },
  );

  it("refuses an off dataset to a service account whose grant covers it", async () => {
    const granted = serviceAccount([String(dataset.attr.workspace_id)]);
    expect(await deadCerbos().check(granted, off, "query")).toBe(false);
  });

  it("asks Cerbos about a dataset that is on", async () => {
    const access = cerbosAccess(
      new MemorySettings({ "access.metadata_visibility": "everyone" }),
    );
    expect(await access.check(principals.admin, dataset, "describe")).toBe(
      true,
    );
  });

  it("throws for a dataset resource with no boolean enabled, naming it", async () => {
    const access = deadCerbos();
    for (const attr of [
      { workspace_id: "w", app_ids: [] },
      { workspace_id: "w", app_ids: [], enabled: "false" },
      { workspace_id: "w", app_ids: [], enabled: null },
    ]) {
      const unmarked: Resource = { ...dataset, attr };
      await expect(
        access.check(principals.admin, unmarked, "describe"),
      ).rejects.toThrow(dataset.id);
    }
  });

  it("limits describableDatasets to enabled datasets, for a service account too", async () => {
    const access = cerbosAccess(
      new MemorySettings({ "access.metadata_visibility": "everyone" }),
    );
    const sqlOf = (condition: Parameters<PgDialect["sqlToQuery"]>[0]) =>
      new PgDialect().sqlToQuery(condition).sql;
    expect(
      sqlOf(await access.reachableDatasets(principals.admin)),
    ).not.toContain('"powerbi_dataset"."enabled"');
    expect(sqlOf(await access.describableDatasets(principals.admin))).toContain(
      '"powerbi_dataset"."enabled"',
    );
    const reachable = await access.reachableDatasets(
      serviceAccount([String(dataset.attr.workspace_id)]),
    );
    expect(sqlOf(reachable)).toContain('"powerbi_dataset"."workspace_id"');
    expect(sqlOf(reachable)).not.toContain('"powerbi_dataset"."enabled"');
    const granted = await access.describableDatasets(
      serviceAccount([String(dataset.attr.workspace_id)]),
    );
    expect(sqlOf(granted)).toContain('"powerbi_dataset"."enabled"');
    expect(sqlOf(granted)).toContain('"powerbi_dataset"."workspace_id"');
  });

  it("refuses a service account every action on pii, even holding pii_reader", async () => {
    const access = cerbosAccess(new MemorySettings());
    const account: Principal = {
      ...serviceAccount([]),
      roles: ["pii_reader"],
    };
    expect(await access.check(account, PII, "read")).toBe(false);
    expect(await access.check(account, PII, "manage")).toBe(false);
    await expect(access.require(account, PII, "read")).rejects.toMatchObject({
      kind: "refused",
    });
  });

  it("lets a person holding pii_reader read pii, and no shipped role without it", async () => {
    const access = cerbosAccess(new MemorySettings());
    const reader: Principal = { ...principals.viewer, roles: ["pii_reader"] };
    expect(await access.check(reader, PII, "read")).toBe(true);
    for (const principal of Object.values(principals))
      expect(await access.check(principal, PII, "read")).toBe(false);
  });

  it("refuses pii to all but a person holding pii_reader when a deployment policy allows it to everyone", async () => {
    const access = createAccess({
      cerbosUrl: await stubbed,
      settings: new MemorySettings(),
    });
    // The stub allows anything, so the floor alone refuses.
    expect(await access.check(principals.viewer, dataset, "describe")).toBe(
      true,
    );
    for (const principal of Object.values(principals))
      expect(await access.check(principal, PII, "read")).toBe(false);
    const account: Principal = { ...serviceAccount([]), roles: ["pii_reader"] };
    expect(await access.check(account, PII, "read")).toBe(false);
    const reader: Principal = { ...principals.viewer, roles: ["pii_reader"] };
    expect(await access.check(reader, PII, "read")).toBe(true);
  });
});
