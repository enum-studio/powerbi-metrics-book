import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import type { ServiceContext } from "../../context.js";
import { getQuery, logQuery, searchQueryLog } from "./log.js";

/*
 * Under a policy that hides entries (access/layering_tests/override leaves a
 * principal its own), a page of the log gives away nothing of a hidden entry:
 * not its id or time through next_cursor, and not whether its DAX holds a word.
 */

const deps = createTestDeps({
  access: cerbosAccess(new MemorySettings(), "override"),
});
const asking = (id: string): ServiceContext => ({
  ...deps,
  principal: { ...principals.viewer, id },
});
const me = asking(`me-${randomUUID()}`);
const someoneElse = asking(`other-${randomUUID()}`);
let minutes = 0;

afterAll(closeTestPools);

/** Logs a query a minute after the one before, so newest first is a fixed order, unless a test gives entries one time. */
async function logged(
  context: ServiceContext,
  dax: string,
  at?: Date,
): Promise<string> {
  const id = randomUUID();
  minutes += 1;
  await logQuery(context, {
    id,
    at: at ?? new Date(Date.UTC(2026, 9, 25, 9, minutes)),
    dataset: null,
    dax,
    purpose: null,
    status: "succeeded",
    error: null,
    duration_ms: 40,
    measure_names: [],
    metric_ids: [],
  });
  return id;
}

/** A word no other test's entry holds. */
const uniqueWord = () => `word${randomUUID().replaceAll("-", "")}`;

const decoded = (cursor: string) =>
  Buffer.from(cursor, "base64url").toString("utf8");

/** Every page of a search with one entry to a page. */
async function walk(context: ServiceContext, text: string) {
  const pages = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await searchQueryLog(context, { text, limit: 1, cursor });
    pages.push(page);
    if (page.next_cursor === null) return pages;
    cursor = page.next_cursor;
  }
}

describe("searchQueryLog under a policy that hides entries", () => {
  it("answers a word only a hidden entry holds exactly like a word nobody holds", async () => {
    const hiddenWord = uniqueWord();
    // Two, so a page of one would have more to come.
    await logged(someoneElse, `EVALUATE {"${hiddenWord}"}`);
    await logged(someoneElse, `EVALUATE {"${hiddenWord}"}`);
    const hidden = await searchQueryLog(me, { text: hiddenWord, limit: 1 });
    const nobody = await searchQueryLog(me, { text: uniqueWord(), limit: 1 });
    expect(hidden).toEqual({ items: [], next_cursor: null });
    expect(hidden).toEqual(nobody);
  });

  it("builds no cursor from a hidden entry", async () => {
    const word = uniqueWord();
    const hidden = [];
    hidden.push(await logged(someoneElse, `EVALUATE {"${word}"}`));
    await logged(me, `EVALUATE {"${word}"}`);
    hidden.push(await logged(someoneElse, `EVALUATE {"${word}"}`));
    hidden.push(await logged(someoneElse, `EVALUATE {"${word}"}`));
    for (const page of await walk(me, word)) {
      const cursor = decoded(page.next_cursor ?? "");
      for (const id of hidden) expect(cursor).not.toContain(id);
    }
  });

  it("reaches every readable entry, one to a page, with no empty page and no page past the last", async () => {
    const word = uniqueWord();
    const mine = [];
    await logged(someoneElse, `EVALUATE {"${word}"}`);
    mine.push(await logged(me, `EVALUATE {"${word}"}`));
    await logged(someoneElse, `EVALUATE {"${word}"}`);
    await logged(someoneElse, `EVALUATE {"${word}"}`);
    mine.push(await logged(me, `EVALUATE {"${word}"}`));
    mine.push(await logged(me, `EVALUATE {"${word}"}`));
    await logged(someoneElse, `EVALUATE {"${word}"}`);
    const pages = await walk(me, word);
    expect(pages.map((page) => page.items.map((entry) => entry.id))).toEqual(
      mine.toReversed().map((id) => [id]),
    );
  });

  it("pages through entries of one time by their id, with no cursor from a hidden one", async () => {
    const word = uniqueWord();
    const at = new Date(Date.UTC(2026, 9, 26, 9));
    const entries = await Promise.all(
      [me, someoneElse, me, someoneElse, me, someoneElse].map(async (who) => ({
        who,
        id: await logged(who, `EVALUATE {"${word}"}`, at),
      })),
    );
    const mine = entries.filter(({ who }) => who === me).map(({ id }) => id);
    const hidden = entries
      .filter(({ who }) => who === someoneElse)
      .map(({ id }) => id);
    const pages = await walk(me, word);
    expect(pages.map((page) => page.items.map((entry) => entry.id))).toEqual(
      mine
        .toSorted()
        .toReversed()
        .map((id) => [id]),
    );
    for (const page of pages) {
      const cursor = decoded(page.next_cursor ?? "");
      for (const id of hidden) expect(cursor).not.toContain(id);
    }
  });

  it("gives a forged cursor at a hidden entry nothing but what is readable after it", async () => {
    const word = uniqueWord();
    const older = await logged(me, `EVALUATE {"${word}"}`);
    const hiddenOlder = await logged(someoneElse, `EVALUATE {"${word}"}`);
    const at = new Date(Date.UTC(2026, 9, 25, 9, minutes)).toISOString();
    const forged = Buffer.from(`${at}|${hiddenOlder}`).toString("base64url");
    const page = await searchQueryLog(me, {
      text: word,
      limit: 1,
      cursor: forged,
    });
    expect(page.items.map((entry) => entry.id)).toEqual([older]);
    expect(page.next_cursor).toBeNull();
  });

  it("decides a list the way it decides one entry, by kind and id both", async () => {
    const word = uniqueWord();
    const namesake: ServiceContext = {
      ...me,
      principal: { ...me.principal, kind: "service_account" },
    };
    const persons = await logged(me, `EVALUATE {"${word}"}`);
    const accounts = await logged(namesake, `EVALUATE {"${word}"}`);
    const theirs = await logged(someoneElse, `EVALUATE {"${word}"}`);
    for (const [reader, own] of [
      [me, persons],
      [namesake, accounts],
      [someoneElse, theirs],
    ] as const) {
      const { items } = await searchQueryLog(reader, { text: word });
      expect(items.map((entry) => entry.id)).toEqual([own]);
      for (const id of [persons, accounts, theirs]) {
        const entry = getQuery(reader, id);
        if (id === own) await expect(entry).resolves.toMatchObject({ id });
        else await expect(entry).rejects.toMatchObject({ kind: "not_found" });
      }
    }
  });
});

describe("searchQueryLog under the sample deployment's parental consent policy", () => {
  const access = cerbosAccess(new MemorySettings(), "sample");
  const sampleDeps = createTestDeps({ access });
  const viewer = (id: string): ServiceContext => ({
    ...sampleDeps,
    principal: { ...principals.viewer, id },
  });
  const ada = viewer(`ada-${randomUUID()}`);
  const grace = viewer(`grace-${randomUUID()}`);
  const curator: ServiceContext = {
    ...sampleDeps,
    principal: principals.curator,
  };

  it("leaves a viewer their own entries and a curator all of them, in a search as in one entry", async () => {
    const word = uniqueWord();
    const adas = await logged(ada, `EVALUATE {"${word}"}`);
    const graces = await logged(grace, `EVALUATE {"${word}"}`);
    const accounts = await logged(
      { ...ada, principal: { ...ada.principal, kind: "service_account" } },
      `EVALUATE {"${word}"}`,
    );
    const { items } = await searchQueryLog(ada, { text: word });
    expect(items.map((entry) => entry.id)).toEqual([adas]);
    await expect(getQuery(ada, adas)).resolves.toMatchObject({ id: adas });
    for (const id of [graces, accounts])
      await expect(getQuery(ada, id)).rejects.toMatchObject({
        kind: "not_found",
      });
    const all = await searchQueryLog(curator, { text: word });
    expect(all.items.map((entry) => entry.id)).toEqual([
      accounts,
      graces,
      adas,
    ]);
    for (const id of [adas, graces, accounts])
      await expect(getQuery(curator, id)).resolves.toMatchObject({ id });
  });

  it("keeps a service account named like a person to its own entries, and the person to theirs", async () => {
    const word = uniqueWord();
    const namesake: ServiceContext = {
      ...ada,
      principal: { ...ada.principal, kind: "service_account" },
    };
    const persons = await logged(ada, `EVALUATE {"${word}"}`);
    const accounts = await logged(namesake, `EVALUATE {"${word}"}`);
    for (const [reader, own, other] of [
      [ada, persons, accounts],
      [namesake, accounts, persons],
    ] as const) {
      const { items } = await searchQueryLog(reader, { text: word });
      expect(items.map((entry) => entry.id)).toEqual([own]);
      await expect(getQuery(reader, other)).rejects.toMatchObject({
        kind: "not_found",
      });
    }
  });

  it("answers a word only a hidden entry holds exactly like a word nobody holds", async () => {
    const hiddenWord = uniqueWord();
    await logged(grace, `EVALUATE {"${hiddenWord}"}`);
    await logged(grace, `EVALUATE {"${hiddenWord}"}`);
    expect(await searchQueryLog(ada, { text: hiddenWord, limit: 1 })).toEqual({
      items: [],
      next_cursor: null,
    });
  });
});
