import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestDeps, principals, testPool } from "../../../test/deps.js";
import { id, useMirror } from "../../../test/mirror-fixtures.js";
import { accessFrom } from "../../../test/doubles.js";
import { publishedIdentities } from "../../../test/secrets-support.js";
import { createDb } from "../../db/client.js";
import { createSecretReader } from "../secrets/store.js";
import { csvLink, verifyCsvLink } from "./links.js";
import { createResultStore } from "./store.js";

/*
 * A CSV link is the owner's for 15 minutes and for one result: a link with
 * its id, owner or expiry changed is refused, and so is an expired one. The
 * key is made on first use, once, even when two links are asked for at once.
 */

const db = createDb(testPool("api_rw"));
const identities = await publishedIdentities(db);
const deps = createTestDeps({
  access: accessFrom(() => true),
  secrets: createSecretReader(
    { container: "api", db, env: {} },
    identities.api,
  ),
});
const store = createResultStore(deps);

useMirror();

const owner = { ...principals.viewer, id: `owner-${randomUUID()}` };
const saved = () =>
  store.save(
    {
      query_id: randomUUID(),
      owner,
      dataset: { id: id.sales, name: "Sales" },
      columns: [{ name: "[Orders]", type: "number" }],
      truncation_note: null,
      preview_rows: 20,
    },
    [[1]],
  );

const partsOf = (url: string) => {
  const link = new URL(url);
  return {
    id: link.pathname.split("/").at(-2) ?? "",
    expires: link.searchParams.get("expires") ?? "",
    signature: link.searchParams.get("signature") ?? "",
  };
};
const verify = (parts: ReturnType<typeof partsOf>, at = deps) =>
  verifyCsvLink(at, parts.id, parts.expires, parts.signature);
const NOT_VALID = {
  kind: "refused",
  message:
    "This CSV link is not valid. Ask for a fresh one with get_result_csv_link.",
};

describe("a CSV link", () => {
  it("is signed with one key made on first use, even when two links are asked for at once", async () => {
    expect(await deps.secrets.read("result_link_key")).toBeNull();
    const [first, second] = await Promise.all([saved(), saved()]);
    expect(await deps.secrets.read("result_link_key")).not.toBeNull();
    for (const anchor of [first, second])
      await expect(verify(partsOf(anchor.csv_url))).resolves.toEqual({
        kind: "person",
        id: owner.id,
      });
  });

  it("is refused with its id, owner or expiry changed", async () => {
    const [anchor, another] = await Promise.all([saved(), saved()]);
    const parts = partsOf(anchor.csv_url);
    await expect(
      verify({ ...parts, id: another.result_id }),
    ).rejects.toMatchObject(NOT_VALID);
    await expect(
      verify({ ...parts, expires: String(Number(parts.expires) + 60) }),
    ).rejects.toMatchObject(NOT_VALID);
    for (const signed of [
      { owner_kind: "person" as const, owner_id: `other-${randomUUID()}` },
      { owner_kind: "service_account" as const, owner_id: owner.id },
    ]) {
      const forged = await csvLink(deps, { id: anchor.result_id, ...signed });
      await expect(verify(partsOf(forged.csv_url))).rejects.toMatchObject(
        NOT_VALID,
      );
    }
    await expect(verify({ ...parts, id: "not-an-id" })).rejects.toMatchObject(
      NOT_VALID,
    );
  });

  it("is refused once its 15 minutes are over", async () => {
    const anchor = await saved();
    const parts = partsOf(anchor.csv_url);
    expect(
      Date.parse(anchor.csv_url_expires_at) - Date.now(),
    ).toBeLessThanOrEqual(15 * 60_000);
    const later = { ...deps, clock: () => new Date(Date.now() + 15 * 60_000) };
    await expect(verify(parts, later)).rejects.toMatchObject({
      kind: "refused",
      message:
        "This CSV link expired. Ask for a fresh one with get_result_csv_link.",
    });
  });
});
