import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testConfig,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { refuseDemoOffTheSample } from "./locks.js";

/*
 * Demo mode opens only on the sample tenant (spec 2026-11-12-public-demo, 1):
 * the api can name a visitor's address, the authority is the mock, the
 * database is unbound or bound to the sample, and usage capture is off. Each
 * lock alone keeps it shut.
 */

afterAll(closeTestPools);

const MOCK = "http://localhost:4010";
const MICROSOFT = "https://login.microsoftonline.com";

const bind = (sample: boolean) =>
  testPool("api_rw").query(
    "insert into deployment_tenant (tenant_id, sample) values ($1, $2)",
    [randomUUID(), sample],
  );

const PROXY = { TRUSTED_PROXY: "10.0.0.2" };

const check = (
  demo: boolean,
  settings: { authority: string; capture: boolean },
  container: "api" | "worker" = "api",
  address: Record<string, string> = PROXY,
) =>
  refuseDemoOffTheSample(
    createTestDeps({
      container,
      config: testConfig(container, {
        DEMO_MODE: demo ? "1" : "0",
        ...address,
      }),
      settings: new MemorySettings({
        "powerbi.authority": settings.authority,
        "usage.capture": settings.capture,
      }),
    }),
  );

describe("refuseDemoOffTheSample", () => {
  beforeEach(() => testPool("migrator").query("delete from deployment_tenant"));

  it("refuses an api that cannot name a visitor's address", async () => {
    await bind(true);
    await expect(
      check(true, { authority: MOCK, capture: false }, "api", {}),
    ).rejects.toThrow(
      "Demo mode limits each visitor by address, and without TRUSTED_PROXY every visitor is the proxy: set TRUSTED_PROXY as deploy/demo/README.md step 3 says.",
    );
  });

  it("names a visitor's address by TRUSTED_PROXY or X-Real-IP", async () => {
    await bind(true);
    await expect(
      check(true, { authority: MOCK, capture: false }, "api", PROXY),
    ).resolves.toBeUndefined();
    await expect(
      check(true, { authority: MOCK, capture: false }, "api", {
        CLIENT_ADDRESS_HEADER: "x-real-ip",
      }),
    ).resolves.toBeUndefined();
  });

  it("asks the worker, which has no visitors, for no address", async () => {
    await bind(true);
    await expect(
      check(true, { authority: MOCK, capture: false }, "worker", {}),
    ).resolves.toBeUndefined();
  });

  it("refuses an authority off the mock", async () => {
    await bind(true);
    await expect(
      check(true, { authority: MICROSOFT, capture: false }),
    ).rejects.toThrow(
      "Demo mode runs only on the mock, and powerbi.authority points at login.microsoftonline.com.",
    );
  });

  it("refuses a database bound to a tenant other than the sample", async () => {
    await bind(false);
    await expect(
      check(true, { authority: MOCK, capture: false }),
    ).rejects.toThrow(
      "Demo mode runs only on the sample tenant's database, and this database belongs to another tenant.",
    );
  });

  it("refuses usage capture, so no visitor's search is written", async () => {
    await bind(true);
    await expect(
      check(true, { authority: MOCK, capture: true }),
    ).rejects.toThrow(
      "Demo mode writes nothing per visitor, and usage.capture is on: set it to false.",
    );
  });

  it("opens with every lock open, on a sample database or an unbound one", async () => {
    await expect(
      check(true, { authority: MOCK, capture: false }),
    ).resolves.toBeUndefined();
    await bind(true);
    await expect(
      check(true, { authority: MOCK, capture: false }),
    ).resolves.toBeUndefined();
  });

  it("checks nothing with demo mode off", async () => {
    await bind(false);
    await expect(
      check(false, { authority: MICROSOFT, capture: true }),
    ).resolves.toBeUndefined();
  });
});
