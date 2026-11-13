import { randomUUID } from "node:crypto";
import {
  sampleTenant,
  startMockPowerBi,
} from "@powerbi-metrics-book/powerbi-mock";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  closeTestPools,
  principals,
  testConfig,
  testPool,
} from "../test/deps.js";
import { holdingSecretsTables } from "../test/secrets-support.js";
import { container_identity } from "./db/schema/secrets.js";
import { buildDeps } from "./deps.js";
import { generateIdentity } from "./services/secrets/age.js";
import { createDb } from "./db/client.js";

afterAll(closeTestPools);

describe("buildDeps", () => {
  it("wires a container's roles, settings, fetcher, secrets and access against the real services", () =>
    holdingSecretsTables(async () => {
      const mock = await startMockPowerBi({ tenant: sampleTenant() });
      const identity = await generateIdentity();
      const config = {
        ...testConfig("worker"),
        age_identity: identity,
        cerbos_url: new URL(inject("cerbos_url")),
      };
      // The environment wins over what is saved, so the mock's hosts need
      // no settings row.
      const deps = await buildDeps(config, {
        POWERBI_AUTHORITY: mock.url,
        POWERBI_API_URL: `${mock.url}/powerbi`,
        POWERBI_GRAPH_URL: `${mock.url}/graph`,
      });
      try {
        expect(deps.container).toBe("worker");
        const role = (db: typeof deps.db) =>
          db.execute<{ role: string }>(sql`select current_user as role`);
        expect((await role(deps.db)).rows).toEqual([{ role: "worker_rw" }]);
        expect((await role(deps.auditDb)).rows).toEqual([
          { role: "audit_writer" },
        ]);

        expect(await deps.settings.get("powerbi.authority")).toBe(mock.url);
        expect(
          (await deps.fetcher.fetchFixed(`${mock.url}/health`)).status,
        ).toBe(200);
        await expect(
          deps.fetcher.fetchFixed("https://example.com/"),
        ).rejects.toMatchObject({ kind: "upstream" });

        // The recipient is published for the api to encrypt to, and the
        // reader is this container's: it is refused the api's secret.
        const published = await createDb(testPool("migrator"))
          .select()
          .from(container_identity);
        expect(published.map((row) => row.recipient)).toContain(
          deps.identity.recipient,
        );
        await expect(
          deps.secrets.read("powerbi_scanner_client_secret"),
        ).resolves.toBeNull();
        await expect(
          deps.secrets.read("result_link_key"),
        ).rejects.toMatchObject({ kind: "refused" });

        expect(
          await deps.access.check(
            principals.admin,
            { kind: "admin", id: randomUUID(), attr: {} },
            "read",
          ),
        ).toBe(true);
      } finally {
        await deps.close();
        await mock.close();
        await testPool("migrator").query(
          "delete from container_identity where recipient = $1",
          [deps.identity.recipient],
        );
      }
    }));
});
