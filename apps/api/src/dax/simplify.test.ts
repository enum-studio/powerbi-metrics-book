import { describe, expect, it } from "vitest";
import { simplify } from "./simplify.js";
import { lex, render } from "./tokens.js";

const simplified = (dax: string) => render(simplify(lex(dax)));
const SHIFT = "CALCULATE([b], REMOVEFILTERS(d[day]), DATESBETWEEN(d[day], ";

describe("simplify", () => {
  it("keeps a variable's name where it may be read as the option of that name", () => {
    const stepBack = (unit: string) =>
      simplified(
        `VAR ${unit} = 1 RETURN CALCULATE([b], DATEADD(d[day], -1, ${unit}))`,
      );
    expect(stepBack("year")).not.toBe(stepBack("month"));
  });

  it.each([
    [
      "a variable returned as it is",
      "VAR Result = DISTINCTCOUNT(T[id]) RETURN Result",
      "DISTINCTCOUNT(T[id])",
    ],
    [
      "brackets around the whole expression",
      "(SUM(T[a]) + 1)",
      "SUM(T[a]) + 1",
    ],
    ["brackets around a call", "(SUM(T[a])) + 1", "SUM(T[a]) + 1"],
    ["brackets around a measure", "([m]) * 2", "[m] * 2"],
    ["brackets around a number", "[m] * (2)", "[m] * 2"],
    ["brackets in brackets", "((SUM(T[a]))) + 1", "SUM(T[a]) + 1"],
    [
      "brackets around an argument",
      "DIVIDE(([a] - [b]), [b])",
      "DIVIDE([a] - [b], [b])",
    ],
    ["brackets after RETURN", "VAR x = 1 RETURN (x + [m])", "1 + [m]"],
    [
      "a variable written out with its brackets",
      "VAR d = [a] - [b] RETURN [c] * d",
      "[c] * ([a] - [b])",
    ],
    [
      "a chain of variables, as a growth rate is often written",
      "VAR Now = [a] VAR Before = [b] VAR Change = Now - Before VAR Growth = DIVIDE(Change, Before) RETURN Growth",
      "DIVIDE([a] - [b], [b])",
    ],
    [
      "a variable read twice",
      "VAR x = [a] RETURN IF(x > 0, x, 0)",
      "IF([a] > 0, [a], 0)",
    ],
    [
      "a variable under calls that keep the context",
      "VAR x = [a] RETURN COALESCE(ROUND(ABS(x), 2), SWITCH(TRUE(), ISBLANK(x), 0, 1))",
      "COALESCE(ROUND(ABS([a]), 2), SWITCH(TRUE(), ISBLANK([a]), 0, 1))",
    ],
    [
      "a variable nobody reads",
      "VAR Unused = RAND() RETURN SUM(T[a])",
      "SUM(T[a])",
    ],
    ["a random value read once", "VAR x = RAND() RETURN x * 2", "RAND() * 2"],
    [
      "the bounds of a filter on dates, kept in variables",
      `VAR Low = MIN(d[last year]) VAR High = MAX(d[last year]) VAR Shifted = ${SHIFT}Low, High)) RETURN Shifted`,
      `${SHIFT}MIN(d[last year]), MAX(d[last year])))`,
    ],
    [
      "the bounds under a slicer's IF",
      `VAR Low = MIN(d[ly]) VAR High = MAX(d[ly]) RETURN IF(SELECTEDVALUE(s[c]) = "x", ${SHIFT}Low, High)), 0)`,
      `IF(SELECTEDVALUE(s[c]) = "x", ${SHIFT}MIN(d[ly]), MAX(d[ly]))), 0)`,
    ],
  ])("gives one text for %s", (_, written, plain) => {
    expect(simplified(written)).toBe(simplified(plain));
  });

  it.each([
    [
      "a variable read under CALCULATE, which is evaluated before the filter applies",
      "VAR x = SUM(T[a]) RETURN CALCULATE(x, ALL(T))",
      "CALCULATE(SUM(T[a]), ALL(T))",
    ],
    [
      "a measure kept in a variable under CALCULATE, which ignores the shift",
      "VAR x = [m] RETURN CALCULATE(x, SAMEPERIODLASTYEAR(d[day]))",
      "CALCULATE([m], SAMEPERIODLASTYEAR(d[day]))",
    ],
    [
      "a variable read in an iterator, which stays one value on every row",
      "VAR x = [m] RETURN SUMX(T, x)",
      "SUMX(T, [m])",
    ],
    [
      "a variable read in a boolean filter, which iterates the column",
      "VAR x = [m] RETURN CALCULATE([b], d[day] > x)",
      "CALCULATE([b], d[day] > [m])",
    ],
    [
      "a bound that is a measure, which would transition on each date",
      "VAR x = [m] RETURN CALCULATE([b], DATESBETWEEN(d[day], x, x))",
      "CALCULATE([b], DATESBETWEEN(d[day], [m], [m]))",
    ],
    [
      "a bound under FILTER, not directly a filter of CALCULATE",
      "VAR x = MIN(d[day]) RETURN CALCULATE([b], FILTER(ALL(d), d[day] > x))",
      "CALCULATE([b], FILTER(ALL(d), d[day] > MIN(d[day])))",
    ],
    [
      "a bound under KEEPFILTERS",
      "VAR x = MIN(d[day]) RETURN CALCULATE([b], KEEPFILTERS(DATESBETWEEN(d[day], x, x)))",
      "CALCULATE([b], KEEPFILTERS(DATESBETWEEN(d[day], MIN(d[day]), MIN(d[day]))))",
    ],
    [
      "a random value read twice",
      "VAR x = RAND() RETURN x - x",
      "RAND() - RAND()",
    ],
    ["the time read twice", "VAR x = NOW() RETURN x - x", "NOW() - NOW()"],
    [
      "a table kept in a variable",
      "VAR t = FILTER(T, T[a] > 0) RETURN COUNTROWS(t)",
      "COUNTROWS(FILTER(T, T[a] > 0))",
    ],
    ["brackets that bind", "([a] + [b]) * [c]", "[a] + [b] * [c]"],
    [
      "brackets on the right of a minus",
      "[a] - ([b] - [c])",
      "[a] - [b] - [c]",
    ],
    ["brackets on the right of an equals", "x = (y && z)", "x = y && z"],
    ["a different number", "VAR x = [m] RETURN x + 1", "[m] + 2"],
  ])("keeps apart %s", (_, one, other) => {
    expect(simplified(one)).not.toBe(simplified(other));
  });

  it("names the variables it keeps by their order, so their names do not matter", () => {
    expect(simplified("VAR Total = [m] RETURN SUMX(T, Total)")).toBe(
      simplified("VAR Amount = [m] RETURN SUMX(T, Amount)"),
    );
    expect(
      simplified("VAR a = [m] VAR b = [n] RETURN SUMX(T, a - b)"),
    ).not.toBe(simplified("VAR a = [m] VAR b = [n] RETURN SUMX(T, b - a)"));
  });

  it("leaves a block with another block inside as it is written, as a name there may be another variable", () => {
    const nested = "VAR a = 1 RETURN IF([m], VAR a = 2 RETURN a, a)";
    expect(simplified(nested)).toBe(render(lex(nested)));
  });

  it.each([
    "VAR x RETURN x",
    "VAR x = 1",
    "VAR = 1 RETURN 1",
    "VAR x = RETURN x",
    "VAR Order = 1 RETURN Order",
    ")(",
    "(",
    "",
  ])("leaves what is no block as it is: %s", (dax) => {
    expect(simplified(dax)).toBe(render(lex(dax)));
  });

  it("keeps a row of a table constructor and a tuple whole", () => {
    expect(simplified("{(1, 2), (3, 4)}")).toBe("{(1,2),(3,4)}");
    expect(simplified("(1, 2) IN {(1, 2)}")).toBe("(1,2)IN{(1,2)}");
  });

  it("stops writing variables out before an expression grows without bound", () => {
    const doubling = Array.from(
      { length: 40 },
      (_, n) => `VAR v${String(n + 1)} = v${String(n)} + v${String(n)}`,
    ).join(" ");
    const tokens = simplify(lex(`VAR v0 = [m] ${doubling} RETURN v40`));
    expect(tokens.length).toBeLessThan(250_000);
  });

  it("leaves an expression past the limit as it is written", () => {
    const long = `(${Array.from({ length: 12_000 }, () => "1").join(" + ")})`;
    expect(simplified(long)).toBe(render(lex(long)));
  });

  it("takes deep brackets without running out of stack", () => {
    const deep = `${"(".repeat(9_000)}1${")".repeat(9_000)}`;
    expect(simplified(deep)).toBe("1");
  });
});
