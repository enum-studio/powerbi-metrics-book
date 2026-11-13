import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, createTestDeps } from "../../test/deps.js";
import { countRequest, deleteStaleCounts } from "./rate-limit.js";

afterAll(closeTestPools);

const { db } = createTestDeps();
const worker = createTestDeps({ container: "worker" }).db;
const RULE = { window_seconds: 60, max: 3 };
const at = (iso: string) => new Date(iso);

describe("countRequest", () => {
  it("allows max requests in a window, then answers when the window frees up", async () => {
    const key = `test:${randomUUID()}`;
    const now = at("2026-10-25T12:00:15Z");
    const verdicts = [];
    for (let n = 0; n < 4; n += 1)
      verdicts.push(await countRequest(db, key, RULE, now));
    expect(verdicts).toEqual([
      { allowed: true },
      { allowed: true },
      { allowed: true },
      { allowed: false, retry_after_seconds: 45 },
    ]);
    expect(
      await countRequest(db, key, RULE, at("2026-10-25T12:01:00Z")),
    ).toEqual({ allowed: true });
  });

  it("counts each key apart", async () => {
    const [one, two] = [`test:${randomUUID()}`, `test:${randomUUID()}`];
    const now = at("2026-10-25T12:00:00Z");
    for (let n = 0; n < 3; n += 1) await countRequest(db, one, RULE, now);
    expect(await countRequest(db, two, RULE, now)).toEqual({ allowed: true });
    expect((await countRequest(db, one, RULE, now)).allowed).toBe(false);
  });

  it("counts a replica whose clock is behind into the newer window, never restarting it", async () => {
    const key = `test:${randomUUID()}`;
    for (let n = 0; n < 3; n += 1)
      await countRequest(db, key, RULE, at("2026-10-25T12:01:00Z"));
    expect(
      await countRequest(db, key, RULE, at("2026-10-25T12:00:59Z")),
    ).toEqual({ allowed: false, retry_after_seconds: 61 });
  });

  it("counts concurrent requests once each", async () => {
    const key = `test:${randomUUID()}`;
    const now = at("2026-10-25T12:00:00Z");
    const verdicts = await Promise.all(
      Array.from({ length: 6 }, () => countRequest(db, key, RULE, now)),
    );
    expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(3);
  });
});

describe("deleteStaleCounts", () => {
  it("drops counts whose window started over a day ago, and keeps the rest", async () => {
    const [stale, fresh] = [`test:${randomUUID()}`, `test:${randomUUID()}`];
    await countRequest(db, stale, RULE, at("2026-10-24T11:59:00Z"));
    await countRequest(db, fresh, RULE, at("2026-10-24T12:01:00Z"));
    expect(await deleteStaleCounts(worker, at("2026-10-25T12:00:30Z"))).toBe(1);
    for (let n = 0; n < 3; n += 1)
      await countRequest(db, stale, RULE, at("2026-10-24T11:59:00Z"));
    // The stale key starts over; the fresh one kept its count.
    expect(
      (await countRequest(db, stale, RULE, at("2026-10-24T11:59:00Z"))).allowed,
    ).toBe(false);
    expect(
      await countRequest(
        db,
        fresh,
        { window_seconds: 60, max: 1 },
        at("2026-10-24T12:01:00Z"),
      ),
    ).toMatchObject({ allowed: false });
  });

  it("refuses a rule whose window is longer than a day, which the cleanup would cut short", async () => {
    await expect(
      countRequest(
        db,
        `test:${randomUUID()}`,
        { window_seconds: 86_401, max: 1 },
        at("2026-10-25T12:00:00Z"),
      ),
    ).rejects.toThrow("at most 86400 seconds");
  });
});
