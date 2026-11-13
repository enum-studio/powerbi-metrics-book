import { describe, expect, it } from "vitest";
import {
  type MeasureMap,
  expandMeasures,
  fingerprint,
  measureMap,
  readsSelection,
  recogniseVariant,
  tooLongToRead,
} from "./index.js";
import { simplify } from "./simplify.js";
import { tokensOf } from "./measures.js";
import { lex } from "./tokens.js";

/*
 * Anyone who can publish a Power BI model writes the DAX the worker reads on
 * every sync. Nothing a measure says may run it out of memory or stop it for
 * long: memory runs out with no error to catch, and a long synchronous call
 * stops the worker's heartbeat, its schedule and its other jobs.
 */

const BOUND_MS = 2_000;
const RULES = {
  period_words: {
    previous_year: [],
    previous_quarter: [],
    previous_month: [],
    previous_week: [],
    previous_day: [],
  },
  recognise_blank_as_zero: false,
};

function within<T>(work: () => T): T {
  const started = performance.now();
  const result = work();
  expect(performance.now() - started).toBeLessThan(BOUND_MS);
  return result;
}

const measures = (entries: [string, string][]): MeasureMap =>
  measureMap(
    entries.map(([name, expression]) => ({ name, expression, table: "Sales" })),
  );

/** `base`, then measures named `M1` to `M<n>`, each written from the one before. */
const chain = (n: number, step: (before: string) => string) =>
  measures([
    ["M0", "SUM(Sales[Amount])"],
    ...Array.from({ length: n }, (_, k): [string, string] => [
      `M${String(k + 1)}`,
      step(`[M${String(k)}]`),
    ]),
  ]);

const doubling = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, k) => {
    const name = `v${String(from + k)}`;
    return `VAR v${String(from + k + 1)} = ${name} + ${name}`;
  }).join(" ");

function expectTooLarge(
  result: ReturnType<typeof expandMeasures>,
  says: string,
): void {
  if (!("too_large" in result)) throw new Error("It was not too large");
  expect(result.too_large).toContain(says);
}

describe("a crafted measure's own DAX", () => {
  it.each([
    [
      "thousands of variables",
      `VAR v0 = [m] ${doubling(0, 2_500)} RETURN v2500`,
    ],
    ["variables that double", `VAR v0 = [m] ${doubling(0, 90)} RETURN v90`],
    [
      "many groups of variables that double",
      `${Array.from({ length: 300 }, (_, g) => `VAR g${String(g)} = [m]`).join(" ")} RETURN ${Array.from({ length: 300 }, (_, g) => `g${String(g)} + g${String(g)}`).join(" + ")}`,
    ],
    [
      "a variable written out past the limit",
      `VAR a = ${Array.from({ length: 2_000 }, () => "[m]").join(" + ")} RETURN ${Array.from({ length: 100 }, () => "a").join(" + ")}`,
    ],
    [
      "one name given to many variables, read deep inside calls",
      `${"VAR a = 1 ".repeat(100)} RETURN ${"ABS(".repeat(3_200)} ${Array.from({ length: 4_800 }, () => "a").join(" + ")} ${")".repeat(3_200)} + SUMX(t, a)`,
    ],
    [
      "many names, read deep inside calls",
      `${Array.from({ length: 100 }, (_, v) => `VAR a${String(v)} = 1`).join(" ")} RETURN ${"ABS(".repeat(3_000)} ${Array.from({ length: 4_000 }, (_, r) => `a${String(r % 100)}`).join(" + ")} ${")".repeat(3_000)}`,
    ],
    [
      "a long value read inside date filters",
      `VAR a = MIN(${Array.from({ length: 3_000 }, () => "1").join(" + ")}) RETURN ${"CALCULATE(1, DATESBETWEEN(1, ".repeat(1_000)} ${Array.from({ length: 2_000 }, () => "a").join(" + ")} ${"))".repeat(1_000)}`,
    ],
  ])("takes little time and stays small with %s", (_, dax) => {
    const tokens = lex(dax);
    const out = within(() => simplify(tokens));
    expect(out.length).toBeLessThanOrEqual(Math.max(tokens.length, 20_000));
  });
});

describe("a crafted measure's text", () => {
  const LONG = `"${"x".repeat(10_000)}"`;

  it("says one long literal read many times is too large, before it fills the memory", () => {
    const dax = `VAR a = ${LONG} RETURN ${Array.from({ length: 4_900 }, () => "a").join(" + ")}`;
    expect(dax.length).toBeLessThan(50_000);
    const dataset = measures([["Long", dax]]);
    expectTooLarge(
      within(() => expandMeasures("Long", dataset)),
      "characters",
    );
    expect(within(() => recogniseVariant("Long", dataset, RULES))).toBeNull();
  });

  it("says one long literal reached through many references is too large", () => {
    const dataset = measures([
      ["Long", LONG],
      ["Many", Array.from({ length: 4_900 }, () => "[Long]").join(" + ")],
    ]);
    expectTooLarge(
      within(() => expandMeasures("Many", dataset)),
      "characters",
    );
  });

  it("will not read a measure too long, itself or behind a reference", () => {
    const long = `"${"x".repeat(600_000)}"`;
    expect(tooLongToRead(long)).toContain("characters");
    const dataset = measures([
      ["Long", long],
      ["Reads it", "[Long] + 1"],
    ]);
    for (const name of ["Long", "Reads it"])
      expectTooLarge(
        within(() => expandMeasures(name, dataset)),
        "characters",
      );
  });

  it("reads and fingerprints what is just within the limit in little time", () => {
    const dataset = measures([["Near", "1 + ".repeat(49_000) + "1"]]);
    const result = within(() => expandMeasures("Near", dataset));
    if (!("expanded" in result)) throw new Error("not expanded");
    within(() => fingerprint(result.expanded));
  });

  it("keeps a dataset's readings only up to a limit, and reads the rest again", () => {
    const long = `${"1+".repeat(140_000)}1`;
    const dataset = measures([
      ["First", long],
      ["Second", long],
      ["Short", "1 + 1"],
    ]);
    const first = tokensOf(dataset, "First");
    expect(tokensOf(dataset, "First")).toBe(first);
    const second = tokensOf(dataset, "Second");
    expect(tokensOf(dataset, "Second")).not.toBe(second);
    const short = tokensOf(dataset, "Short");
    expect(tokensOf(dataset, "Short")).toBe(short);
  });

  it("reads one long table name once, however many measures sit on it", () => {
    const table = "a".repeat(200_000);
    const dataset = within(() =>
      measureMap(
        Array.from({ length: 2_000 }, (_, k) => ({
          name: `M${String(k)}`,
          table,
        })),
      ),
    );
    expect(new Set([...dataset.values()].map((m) => m.table)).size).toBe(1);
  });

  it("reads each measure once for a dataset, however many reach it", () => {
    const heavy = `VAR a = 1 RETURN ${"ABS(".repeat(3_200)} ${Array.from({ length: 4_800 }, () => "a").join(" + ")} ${")".repeat(3_200)}`;
    const dataset = measures([
      ["Heavy", heavy],
      ...Array.from({ length: 300 }, (_, k): [string, string] => [
        `R${String(k)}`,
        "[Heavy] + 1",
      ]),
    ]);
    within(() => {
      for (let k = 0; k < 300; k += 1) expandMeasures(`R${String(k)}`, dataset);
    });
  });

  it.each([
    [
      "selection calls nested in selection calls",
      `${"SELECTEDVALUE(T[c], ".repeat(21_000)} 1 ${")".repeat(21_000)}`,
    ],
    [
      "selection calls side by side",
      Array.from({ length: 40_000 }, () => "SELECTEDVALUE(T[c])").join(" & "),
    ],
    [
      "selection calls nested in their first argument",
      `${"SELECTEDVALUE(".repeat(30_000)} T[c] ${")".repeat(30_000)}`,
    ],
  ])("reads the selection in little time with %s", (_, dax) => {
    expect(within(() => readsSelection(dax)).reads).toBe(true);
  });
});

describe("a crafted dataset around a composed shift", () => {
  const SHIFTS: [string, string][] = [
    ["N", "SUM(Sales[Amount])"],
    ["D", "SUM(Sales[Quantity])"],
    ["N LY", "CALCULATE([N], SAMEPERIODLASTYEAR('Date'[Date]))"],
    ["D LY", "CALCULATE([D], SAMEPERIODLASTYEAR('Date'[Date]))"],
    ["Ratio", "DIVIDE([N], [D])"],
    ["Variant", "DIVIDE([N LY], [D LY])"],
  ];

  it("reads no long measure to look for a base", () => {
    const long = "1 + ".repeat(120_000);
    const dataset = measures([
      ...SHIFTS,
      ...Array.from({ length: 300 }, (_, k): [string, string] => [
        `Long ${String(k)}`,
        `${long}${String(k)}`,
      ]),
    ]);
    expect(
      within(() => recogniseVariant("Variant", dataset, RULES)),
    ).toMatchObject({ base: "Ratio" });
  });

  it("looks for its bases once for a dataset, however many measures ask", () => {
    const asking = Array.from({ length: 4_000 }, (_, k): [string, string] => [
      `Asks ${String(k)}`,
      `DIVIDE([N LY], [D LY]) * ${String(k + 2)}`,
    ]);
    const bases = asking.map(([name, expression]): [string, string] => [
      `Base of ${name}`,
      expression.replaceAll(" LY", ""),
    ]);
    const dataset = measures([...SHIFTS, ...asking, ...bases]);
    within(() => {
      for (const [name] of asking)
        expect(recogniseVariant(name, dataset, RULES)).toMatchObject({
          base: `Base of ${name}`,
        });
    });
  });

  it("reads no measure as a base or a shift when its variables write it out long", () => {
    const fanned =
      "VAR b=[K] VAR c=b+b+b+b VAR d=c+c+c+c VAR e=d+d+d+d VAR f=e+e+e+e RETURN f+f+f+f";
    const dataset = measures([
      ...SHIFTS,
      ["Ratio written out", fanned.replace("[K]", "[N]")],
      ["Variant written out", fanned.replace("[K]", "[N LY]")],
    ]);
    expect(recogniseVariant("Variant written out", dataset, RULES)).toBeNull();
  });

  it("keeps little of a short measure whose variables write it out long", () => {
    const dataset = measures([
      ...SHIFTS,
      ["0 Asks", "[N LY] + 1"],
      ...Array.from({ length: 40 }, (_, k): [string, string] => [
        `Long once written ${String(k)}`,
        `VAR a=${String(k + 1)}${"9".repeat(3_870)} VAR b=a+a+a+a VAR c=b+b+b+b VAR d=c+c+c+c VAR e=d+d+d+d VAR f=e+e+e+e RETURN f+f+f+f`,
      ]),
    ]);
    const before = process.memoryUsage().heapUsed;
    within(() => recogniseVariant("0 Asks", dataset, RULES));
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64_000_000);
    // What a dataset's map holds lives as long as the map, so it is read last.
    expect(dataset.size).toBe(SHIFTS.length + 41);
  });

  it("gives null, and throws nothing, when a long name is written out many times", () => {
    const long = "n".repeat(140_000);
    const dataset = measures([
      [long, "SUM(Sales[Amount])"],
      ["a", `CALCULATE([${long}], SAMEPERIODLASTYEAR('Date'[Date]))`],
      [
        "Long once written",
        "VAR b=[a] VAR c=b+b+b+b VAR d=c+c+c+c VAR e=d+d+d+d VAR f=e+e+e+e VAR g=f+f+f+f RETURN g+g+g+g",
      ],
    ]);
    expect(recogniseVariant("Long once written", dataset, RULES)).toBeNull();
  });

  it("will not read too long a measure as a composed shift", () => {
    const padded = `DIVIDE([N LY], [D LY]) /* ${"x".repeat(4_000)} */`;
    const dataset = measures([...SHIFTS, ["Padded", padded]]);
    expect(recogniseVariant("Padded", dataset, RULES)).toBeNull();
    const base = measures([
      ...SHIFTS.filter(([name]) => name !== "Ratio"),
      ["Ratio", `DIVIDE([N], [D]) /* ${"x".repeat(4_000)} */`],
    ]);
    expect(recogniseVariant("Variant", base, RULES)).toBeNull();
    const shift = measures([
      ...SHIFTS.filter(([name]) => name !== "N LY"),
      [
        "N LY",
        `CALCULATE([N], SAMEPERIODLASTYEAR('Date'[Date])) /* ${"x".repeat(4_000)} */`,
      ],
    ]);
    expect(recogniseVariant("Variant", shift, RULES)).toBeNull();
  });

  it("will not let a measure's name pass for two references", () => {
    const dataset = measures([
      ...SHIFTS.filter(([name]) => name !== "Ratio"),
      ["N] , [D", "SUM(Sales[Amount])"],
      ["Ratio", "DIVIDE([N]] , [D])"],
    ]);
    expect(recogniseVariant("Variant", dataset, RULES)).toBeNull();
  });
});

describe("crafted references between measures", () => {
  it("says a measure that doubles at every level is too large, before it fills the memory", () => {
    const dataset = chain(40, (before) => `${before} + ${before}`);
    const result = within(() => expandMeasures("M40", dataset));
    expectTooLarge(result, "characters");
    expect(recogniseVariant("M40", dataset, RULES)).toBeNull();
  });

  it("says a chain past the depth limit is too large, and does not run out of stack", () => {
    const dataset = chain(
      6_001,
      (before) => `CALCULATE(${before}, SAMEPERIODLASTYEAR('Date'[Date]))`,
    );
    const result = within(() => expandMeasures("M6001", dataset));
    expectTooLarge(result, "levels");
    expect(within(() => recogniseVariant("M6001", dataset, RULES))).toBeNull();
  });

  it("still reads a chain within the limits", () => {
    const dataset = chain(
      150,
      (before) => `CALCULATE(${before}, SAMEPERIODLASTYEAR('Date'[Date]))`,
    );
    expect(within(() => expandMeasures("M150", dataset))).toHaveProperty(
      "expanded",
    );
    expect(
      within(() => recogniseVariant("M150", dataset, RULES)),
    ).toMatchObject({
      base: "M149",
    });
  });
});
