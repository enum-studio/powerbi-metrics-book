import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cerbosAccess,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { id, useMirror } from "../../../test/mirror-fixtures.js";
import {
  accessFrom,
  MemorySecrets,
  MemorySettings,
} from "../../../test/doubles.js";
import type { Principal } from "../../principal.js";
import { resultCsv } from "./csv.js";
import { verifyCsvLink } from "./links.js";
import { createResultStore } from "./store.js";

/*
 * A result holds rows read under its owner's row-level security, so only the
 * owner reads it, whatever the policy says: the access here allows every
 * request, and the store alone keeps the result to its owner.
 */

const deps = createTestDeps({
  access: accessFrom(() => true),
  secrets: new MemorySecrets([["result_link_key", "test-result-link-key"]]),
});
const store = createResultStore(deps);

useMirror();

const person = (id: string, role: keyof typeof principals = "viewer") => ({
  ...principals[role],
  id,
});

async function savedFor(owner: Principal) {
  return store.save(
    {
      query_id: randomUUID(),
      owner,
      dataset: { id: id.sales, name: "Sales" },
      columns: [
        { name: "Date[Year]", type: "number" },
        { name: "[Net sales]", type: "number" },
      ],
      truncation_note: null,
      preview_rows: 20,
    },
    [
      [2025, 1204331.5],
      [2026, 1312004.25],
    ],
  );
}

async function csvOf(principal: Principal, resultId: string) {
  let text = "";
  for await (const line of resultCsv({ ...deps, principal }, resultId))
    text += line;
  return text;
}

describe("a result", () => {
  it("is not_found for another person reading it by id", async () => {
    const owner = person(`owner-${randomUUID()}`);
    const anchor = await savedFor(owner);
    const other = person(`other-${randomUUID()}`);
    await expect(
      store.read(other, anchor.result_id, { offset: 0, limit: 10 }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      store.read(owner, anchor.result_id, { offset: 0, limit: 10 }),
    ).resolves.toMatchObject({
      rows: [
        [2025, 1204331.5],
        [2026, 1312004.25],
      ],
    });
  });

  it("is not_found to another person, a curator and an admin, by id and by CSV, while the owner's link is valid", async () => {
    const owner = person(`owner-${randomUUID()}`);
    const anchor = await savedFor(owner);
    const link = new URL(anchor.csv_url);
    await expect(
      verifyCsvLink(
        deps,
        anchor.result_id,
        link.searchParams.get("expires") ?? "",
        link.searchParams.get("signature") ?? "",
      ),
    ).resolves.toEqual({ kind: "person", id: owner.id });
    expect(await csvOf(owner, anchor.result_id)).toBe(
      "Date[Year],[Net sales]\r\n2025,1204331.5\r\n2026,1312004.25\r\n",
    );
    const others = [
      person(`other-${randomUUID()}`),
      person(`curator-${randomUUID()}`, "curator"),
      person(`admin-${randomUUID()}`, "admin"),
    ];
    for (const other of others) {
      await expect(
        store.read(other, anchor.result_id, { offset: 0, limit: 10 }),
      ).rejects.toMatchObject({
        kind: "not_found",
        message: "No such result.",
      });
      await expect(csvOf(other, anchor.result_id)).rejects.toMatchObject({
        kind: "not_found",
        message: "No such result.",
      });
    }
  });

  it("is not_found to a service account whose name is its owner's id, and stays its owner's under the default policy", async () => {
    const owner = person(`shared-name-${randomUUID()}`);
    const anchor = await savedFor(owner);
    const namesake: Principal = {
      ...owner,
      kind: "service_account",
      via: "api",
    };
    const withCerbos = createResultStore({
      ...deps,
      access: cerbosAccess(new MemorySettings()),
    });
    await expect(
      withCerbos.read(namesake, anchor.result_id, { offset: 0, limit: 10 }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      withCerbos.read(owner, anchor.result_id, { offset: 1, limit: 10 }),
    ).resolves.toMatchObject({ rows: [[2026, 1312004.25]], next_offset: null });
  });
});
