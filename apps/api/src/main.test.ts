import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testEnvironment,
} from "../test/deps.js";
import { startApi } from "./main.js";

// startApi, up to the first thing it does after the tenant check: the
// database, the migrations and the jobs are not under test here.
vi.mock("./db/migrate.js", () => ({
  migrateDatabase: () => Promise.resolve(),
}));
vi.mock("./deps.js", () => ({
  buildDeps: () => Promise.resolve(createTestDeps()),
}));
vi.mock("./services/connection/jobs.js", () => ({
  queueRekeyAtStart: () => Promise.reject(new Error("went past the checks")),
}));
const refuse = vi.hoisted(() => vi.fn());
vi.mock("./services/setup/tenant.js", () => ({ refuseAnotherTenant: refuse }));

const refuseDemo = vi.hoisted(() => vi.fn());
vi.mock("./services/demo/locks.js", () => ({
  refuseDemoOffTheSample: refuseDemo,
}));

afterAll(closeTestPools);

describe("startApi", () => {
  it("refuses to start against another tenant, before it takes any request", async () => {
    refuse.mockRejectedValueOnce(new Error("another tenant"));
    await expect(
      startApi(testEnvironment("api"), new AbortController().signal),
    ).rejects.toThrow("another tenant");
    expect(refuse).toHaveBeenCalledTimes(1);
  });

  it("refuses to start a demo that is off the sample, before it takes any request", async () => {
    refuseDemo.mockRejectedValueOnce(new Error("demo off the sample"));
    await expect(
      startApi(testEnvironment("api"), new AbortController().signal),
    ).rejects.toThrow("demo off the sample");
    expect(refuseDemo).toHaveBeenCalledTimes(1);
  });
});
