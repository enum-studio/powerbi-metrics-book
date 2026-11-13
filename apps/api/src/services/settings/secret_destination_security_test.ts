// Where a secret is sent (Microsoft identity, Power BI, Graph, the embedding
// provider) is the operator's to set, in the environment. An admin may
// replace a secret but never read one, so an admin who could move one of
// these addresses could send the secret to a host of their own.
import { drizzle } from "drizzle-orm/node-postgres";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inRollback } from "../../../test/database.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import type { SettingKey, SignInProvider } from "../../context.js";
import * as schema from "../../db/schema/index.js";
import { secret, secret_ciphertext } from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import { importBook } from "../admin/export.js";
import { setSetting } from "../admin/settings.js";
import { SETTING_KEYS, SETTINGS } from "./registry.js";
import { createSettingsStore } from "./store.js";

afterAll(closeTestPools);

const DESTINATIONS = [
  "powerbi.authority",
  "powerbi.api_url",
  "powerbi.graph_url",
  "email.base_url",
  "search.base_url",
] as const satisfies readonly SettingKey[];

const ELSEWHERE = "https://collector.example.net";

describe("the settings that say where a secret is sent", () => {
  it("are exactly the environment-only ones", () => {
    expect(
      SETTING_KEYS.filter((key) => SETTINGS[key].environment_only === true),
    ).toEqual(DESTINATIONS);
  });

  it.each(DESTINATIONS)("refuses %s to anyone but the environment", (key) =>
    inRollback(testPool("api_rw"), async (client) => {
      const store = createSettingsStore(drizzle({ client, schema }), {});
      const refused: unknown = await store
        .set(key, ELSEWHERE, principals.admin)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(ServiceError);
      expect(refused).toMatchObject({ kind: "conflict" });
      expect(await store.get(key)).toBe(SETTINGS[key].default);
    }),
  );

  it.each(DESTINATIONS)(
    "never reads %s from a row saved in the database",
    (key) =>
      inRollback(testPool("migrator"), async (client) => {
        const db = drizzle({ client, schema });
        await db.execute(
          sql`insert into setting (key, value, set_by) values (${key}, ${JSON.stringify(ELSEWHERE)}::jsonb, 'someone')`,
        );
        const store = createSettingsStore(db, {});
        expect(await store.get(key)).toBe(SETTINGS[key].default);
        expect(await store.source(key)).toBe("default");
        const listed = (await store.list()).find((each) => each.key === key);
        expect(listed).toMatchObject({
          value: SETTINGS[key].default,
          source: "default",
          environment_only: true,
        });
      }),
  );

  it.each(DESTINATIONS)("takes %s from the environment", (key) =>
    inRollback(testPool("api_rw"), async (client) => {
      const variable = key.replaceAll(".", "_").toUpperCase();
      const store = createSettingsStore(drizzle({ client, schema }), {
        [variable]: ELSEWHERE,
      });
      expect(await store.get(key)).toBe(ELSEWHERE);
      expect(await store.source(key)).toBe("environment");
    }),
  );
});

/*
 * A sign-in provider's secret goes to its issuer's token endpoint, and the
 * issuer is a setting an admin may change. So the secret belongs to the
 * provider as it was when the secret was entered: moving the provider to
 * another issuer or kind, or removing it, deletes its secret.
 */
describe("a sign-in provider's secret", () => {
  const base = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
  const admin = {
    ...base,
    settings: createSettingsStore(base.db, {}),
    principal: principals.admin,
  };
  const OKTA: SignInProvider = {
    id: "okta",
    kind: "oidc",
    label: "Okta",
    client_id: "abc",
    issuer: "https://example.okta.com",
  };
  const GOOGLE: SignInProvider = {
    id: "google",
    kind: "google",
    label: "Google",
    client_id: "def",
    issuer: null,
  };
  const NAMES = [
    "sign_in_okta_client_secret",
    "sign_in_google_client_secret",
  ] as const;
  const save = (providers: SignInProvider[]) =>
    setSetting(admin, "sign_in.providers", providers, { save_failing: true });
  const kept = async () =>
    (
      await admin.db
        .select({ name: secret.name })
        .from(secret)
        .where(inArray(secret.name, [...NAMES]))
    )
      .map((row) => row.name)
      .sort();

  beforeEach(async () => {
    await save([OKTA, GOOGLE]);
    await admin.db.delete(secret).where(inArray(secret.name, [...NAMES]));
    // As the writer leaves them: the row and a ciphertext, which goes with it.
    for (const name of NAMES) {
      await admin.db.insert(secret).values({
        name,
        readers: ["api"],
        set_at: new Date(),
      });
      await admin.db.insert(secret_ciphertext).values({
        name,
        reader: "api",
        recipient: "age1test",
        ciphertext: new Uint8Array([1, 2, 3]),
      });
    }
  });

  it("stays while the provider keeps its kind and issuer", async () => {
    await save([{ ...OKTA, label: "Okta SSO", client_id: "xyz" }, GOOGLE]);
    expect(await kept()).toEqual([...NAMES].sort());
  });

  it("is deleted, with its ciphertext, when the provider moves to another issuer", async () => {
    await save([{ ...OKTA, issuer: "https://collector.example.net" }, GOOGLE]);
    expect(await kept()).toEqual(["sign_in_google_client_secret"]);
    expect(
      await admin.db
        .select()
        .from(secret_ciphertext)
        .where(inArray(secret_ciphertext.name, ["sign_in_okta_client_secret"])),
    ).toEqual([]);
  });

  it("is deleted when the provider changes kind under the same id", async () => {
    await save([{ ...OKTA, kind: "google", issuer: null }, GOOGLE]);
    expect(await kept()).toEqual(["sign_in_google_client_secret"]);
  });

  it("is deleted when the provider is removed", async () => {
    await save([GOOGLE]);
    expect(await kept()).toEqual(["sign_in_google_client_secret"]);
  });

  it("is deleted when an imported book.yml moves the provider", async () => {
    const moved = { ...OKTA, issuer: "https://collector.example.net" };
    // book.yml is YAML, and JSON is YAML.
    const file = JSON.stringify({
      format: 1,
      settings: { "sign_in.providers": [moved, GOOGLE] },
    });
    await importBook(admin, file, { apply: true, save_failing: true });
    expect(await kept()).toEqual(["sign_in_google_client_secret"]);
  });
});
