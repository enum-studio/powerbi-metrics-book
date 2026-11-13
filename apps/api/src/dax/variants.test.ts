import { describe, expect, it } from "vitest";
import {
  type Comparison,
  type MeasureMap,
  type Period,
  type Shift,
  type VariantRules,
  measureMap,
  recogniseVariant,
} from "./index.js";

const measures = (entries: Record<string, string>): MeasureMap =>
  measureMap(
    Object.entries(entries).map(([name, expression]) => ({
      name,
      expression,
      table: "Sales",
    })),
  );

const period = (value: Period): Shift => ({
  period: value,
  comparison: "none",
  comparison_period: null,
});
const compared = (comparison: Comparison, against: Period): Shift => ({
  period: "current",
  comparison,
  comparison_period: against,
});

// The measures every row's `Variant` can refer to.
const DATASET = {
  "Net Sales": "SUM('Sales'[Amount])",
  Units: "SUM('Sales'[Quantity])",
  "Net Sales PY": "CALCULATE([Net Sales], SAMEPERIODLASTYEAR('Date'[Date]))",
  "Net Sales PM": "CALCULATE([Net Sales], DATEADD('Date'[Date], -1, MONTH))",
  "Net Sales YTD": "TOTALYTD([Net Sales], 'Date'[Date])",
  "Units PY": "CALCULATE([Units], SAMEPERIODLASTYEAR('Date'[Date]))",
  "Net Sales Red": `CALCULATE([Net Sales], 'Product'[Color] = "Red")`,
  "Net Sales PY Red": `CALCULATE([Net Sales], SAMEPERIODLASTYEAR('Date'[Date]), 'Product'[Color] = "Red")`,
};

const D = "'Date'[Date]";

/** A shift by a calendar column that holds the same dates a period back. */
const CALENDAR = (column: string, clear = "REMOVEFILTERS('Date'[Date])") =>
  `CALCULATE([Net Sales], ${clear}, DATESBETWEEN(${D}, MIN('Date'[${column}]), MAX('Date'[${column}])))`;

const NO_RULES: VariantRules = {
  period_words: {
    previous_year: [],
    previous_quarter: [],
    previous_month: [],
    previous_week: [],
    previous_day: [],
  },
  recognise_blank_as_zero: false,
};

const RULES: VariantRules = {
  period_words: {
    previous_year: ["Last year", "LY"],
    previous_quarter: ["Last quarter", "LQ"],
    previous_month: ["Last month", "LM"],
    previous_week: ["Last week", "LW"],
    previous_day: ["Last day"],
  },
  recognise_blank_as_zero: true,
};

describe("recogniseVariant", () => {
  it.each([
    // Period shapes.
    [
      `CALCULATE([Net Sales], SAMEPERIODLASTYEAR(${D}))`,
      "Net Sales",
      period("previous_year"),
    ],
    [
      `CALCULATE([Net Sales], DATEADD(${D}, -1, YEAR))`,
      "Net Sales",
      period("previous_year"),
    ],
    [
      `CALCULATE([Net Sales], PARALLELPERIOD(${D}, -12, MONTH))`,
      "Net Sales",
      period("previous_year"),
    ],
    [
      `CALCULATE([Net Sales], PARALLELPERIOD(${D}, -1, YEAR))`,
      "Net Sales",
      period("previous_year"),
    ],
    [
      `CALCULATE([Net Sales], DATEADD(${D}, -1, QUARTER))`,
      "Net Sales",
      period("previous_quarter"),
    ],
    [
      `CALCULATE([Net Sales], DATEADD(${D}, -1, MONTH))`,
      "Net Sales",
      period("previous_month"),
    ],
    [
      `CALCULATE([Net Sales], DATEADD(${D}, -1, DAY))`,
      "Net Sales",
      period("previous_day"),
    ],
    [`TOTALYTD([Net Sales], ${D})`, "Net Sales", period("year_to_date")],
    [`TOTALQTD([Net Sales], ${D})`, "Net Sales", period("quarter_to_date")],
    [`TOTALMTD([Net Sales], ${D})`, "Net Sales", period("month_to_date")],
    [
      `CALCULATE([Net Sales], DATESYTD(${D}))`,
      "Net Sales",
      period("year_to_date"),
    ],
    [
      `CALCULATE([Net Sales], DATESQTD(${D}))`,
      "Net Sales",
      period("quarter_to_date"),
    ],
    [
      `CALCULATE([Net Sales], DATESMTD(${D}))`,
      "Net Sales",
      period("month_to_date"),
    ],
    [
      `CALCULATE([Net Sales], DATESYTD(SAMEPERIODLASTYEAR(${D})))`,
      "Net Sales",
      period("previous_year_to_date"),
    ],
    [
      `CALCULATE([Net Sales YTD], SAMEPERIODLASTYEAR(${D}))`,
      "Net Sales",
      period("previous_year_to_date"),
    ],
    // Only SAMEPERIODLASTYEAR of a year-to-date measure is the previous year to date.
    [
      `CALCULATE([Net Sales YTD], PARALLELPERIOD(${D}, -1, YEAR))`,
      "Net Sales YTD",
      period("previous_year"),
    ],
    [
      `CALCULATE([Net Sales PM], SAMEPERIODLASTYEAR(${D}))`,
      "Net Sales PM",
      period("previous_year"),
    ],
    // Case, qualification, an unqualified date column, whitespace and comments do not matter.
    [
      "calculate ( 'Sales'[net sales] , sameperiodlastyear ( [Date] ) ) -- last year",
      "net sales",
      period("previous_year"),
    ],
    [
      `CALCULATE([Net Sales], DATEADD(${D}, - 1.0, year))`,
      "Net Sales",
      period("previous_year"),
    ],
    // Comparison shapes.
    [
      "[Net Sales] - [Net Sales PY]",
      "Net Sales",
      compared("difference", "previous_year"),
    ],
    [
      "[Net Sales] - [Net Sales PM]",
      "Net Sales",
      compared("difference", "previous_month"),
    ],
    [
      "DIVIDE([Net Sales] - [Net Sales PY], [Net Sales PY])",
      "Net Sales",
      compared("growth_rate", "previous_year"),
    ],
    [
      "DIVIDE([Net Sales], [Net Sales PY]) - 1",
      "Net Sales",
      compared("growth_rate", "previous_year"),
    ],
    [
      "DIVIDE([Net Sales], 'Sales'[Net Sales PY])",
      "Net Sales",
      compared("ratio", "previous_year"),
    ],
    [
      "DIVIDE([Net Sales], [Net Sales YTD])",
      "Net Sales",
      compared("ratio", "year_to_date"),
    ],
    // The same shapes in other spellings: brackets and variables that change nothing.
    [
      "DIVIDE(([Net Sales] - [Net Sales PY]), [Net Sales PY])",
      "Net Sales",
      compared("growth_rate", "previous_year"),
    ],
    [
      "VAR Now = [Net Sales] VAR Before = [Net Sales PY] VAR Change = Now - Before VAR Growth = DIVIDE(Change, Before) RETURN Growth",
      "Net Sales",
      compared("growth_rate", "previous_year"),
    ],
    [
      `VAR Shifted = CALCULATE([Net Sales], SAMEPERIODLASTYEAR(${D})) RETURN Shifted`,
      "Net Sales",
      period("previous_year"),
    ],
    [
      `CALCULATE([Net Sales], DATEADD(${D}, -7, DAY))`,
      "Net Sales",
      period("previous_week"),
    ],
    [
      `CALCULATE([Net Sales], DATEADD(${D}, -1, WEEK))`,
      "Net Sales",
      period("previous_week"),
    ],
  ])("%s is a variant of %s", (expression, base, shift) => {
    const dataset = measures({ ...DATASET, Variant: expression });
    expect(recogniseVariant("Variant", dataset, NO_RULES)).toEqual({
      base,
      shift,
    });
  });

  it.each([
    [
      "an extra filter",
      `CALCULATE([Net Sales], SAMEPERIODLASTYEAR(${D}), 'Product'[Color] = "Red")`,
    ],
    [
      "a FILTER",
      `CALCULATE([Net Sales], FILTER(ALL('Date'), 'Date'[Year] = 2025))`,
    ],
    [
      "KEEPFILTERS around the shift",
      `CALCULATE([Net Sales], KEEPFILTERS(SAMEPERIODLASTYEAR(${D})))`,
    ],
    ["two years back", `CALCULATE([Net Sales], DATEADD(${D}, -2, YEAR))`],
    ["one year forward", `CALCULATE([Net Sales], DATEADD(${D}, 1, YEAR))`],
    [
      "twelve months by DATEADD",
      `CALCULATE([Net Sales], DATEADD(${D}, -12, MONTH))`,
    ],
    [
      "a parallel quarter",
      `CALCULATE([Net Sales], PARALLELPERIOD(${D}, -1, QUARTER))`,
    ],
    [
      "a parallel shift of three months, not twelve",
      `CALCULATE([Net Sales], PARALLELPERIOD(${D}, -3, MONTH))`,
    ],
    [
      "a quarter to date of last year, not a year to date",
      `CALCULATE([Net Sales], DATESQTD(SAMEPERIODLASTYEAR(${D})))`,
    ],
    [
      "a shift where TOTALYTD wants the date column",
      `TOTALYTD([Net Sales], DATEADD(${D}, -1, YEAR))`,
    ],
    [
      "a year shift under CALCULATETABLE, not CALCULATE",
      `CALCULATETABLE([Net Sales], DATEADD(${D}, -1, YEAR))`,
    ],
    [
      "a DATEADD offset of minus one times two",
      `CALCULATE([Net Sales], DATEADD(${D}, -1 * 2, YEAR))`,
    ],
    ["a year end date on TOTALYTD", `TOTALYTD([Net Sales], ${D}, "6/30")`],
    [
      "a filter on TOTALYTD",
      `TOTALYTD([Net Sales], ${D}, 'Product'[Color] = "Red")`,
    ],
    [
      "a year end date on DATESYTD",
      `CALCULATE([Net Sales], DATESYTD(${D}, "6/30"))`,
    ],
    [
      "a year end date inside the previous year to date",
      `CALCULATE([Net Sales], DATESYTD(SAMEPERIODLASTYEAR(${D}), "6/30"))`,
    ],
    [
      "an inline expression, not a measure",
      `CALCULATE(SUM('Sales'[Amount]), SAMEPERIODLASTYEAR(${D}))`,
    ],
    [
      "arithmetic around the base",
      `CALCULATE([Net Sales] * 2, SAMEPERIODLASTYEAR(${D}))`,
    ],
    [
      "a measure where the date column goes",
      "CALCULATE([Net Sales], SAMEPERIODLASTYEAR([Units]))",
    ],
    ["a plain base measure", "SUM('Sales'[Amount]) - SUM('Sales'[Cost])"],
    [
      "a comparison against a measure that is not a period variant",
      "[Net Sales] - [Net Sales Red]",
    ],
    [
      "a comparison against a filtered previous year",
      "[Net Sales] - [Net Sales PY Red]",
    ],
    ["a different base on each side", "[Net Sales] - [Units PY]"],
    ["the sides reversed", "[Net Sales PY] - [Net Sales]"],
    ["a sum, not a difference", "[Net Sales] + [Net Sales PY]"],
    ["an alternate result on DIVIDE", "DIVIDE([Net Sales], [Net Sales PY], 0)"],
    [
      "a growth rate over another period",
      "DIVIDE([Net Sales] - [Net Sales PY], [Net Sales PM])",
    ],
    [
      "a growth rate with a different base",
      "DIVIDE([Units], [Net Sales PY]) - 1",
    ],
    ["minus two after DIVIDE", "DIVIDE([Net Sales], [Net Sales PY]) - 2"],
    ["a shift of six days", `CALCULATE([Net Sales], DATEADD(${D}, -6, DAY))`],
    [
      "a shift of 365 days, which is no year in a leap year",
      `CALCULATE([Net Sales], DATEADD(${D}, -365, DAY))`,
    ],
    [
      "a measure kept in a variable, which CALCULATE cannot shift",
      `VAR Kept = [Net Sales] RETURN CALCULATE(Kept, SAMEPERIODLASTYEAR(${D}))`,
    ],
    ["a calendar column with no rules to read it", CALENDAR("Date last year")],
    [
      "blank as zero with no rule for it",
      `COALESCE(CALCULATE([Net Sales], SAMEPERIODLASTYEAR(${D})), 0)`,
    ],
  ])("%s is no variant", (_, expression) => {
    const dataset = measures({ ...DATASET, Variant: expression });
    expect(recogniseVariant("Variant", dataset, NO_RULES)).toBeNull();
  });

  it.each([
    [
      "clearing the date column",
      CALENDAR("Date last year"),
      period("previous_year"),
    ],
    [
      "clearing the calendar",
      CALENDAR("Date last month", "REMOVEFILTERS('Date')"),
      period("previous_month"),
    ],
    [
      "clearing with ALL",
      CALENDAR("Date last week", "ALL('Date'[Date])"),
      period("previous_week"),
    ],
    [
      "with no clearing",
      `CALCULATE([Net Sales], DATESBETWEEN(${D}, MIN('Date'[Date LY]), MAX('Date'[Date LY])))`,
      period("previous_year"),
    ],
    [
      "with another column of the calendar cleared",
      CALENDAR("Date last month", "REMOVEFILTERS('Date'[Month])"),
      period("previous_month"),
    ],
    [
      "with DATEADD saying the same on the same column",
      CALENDAR("Date last quarter", `DATEADD(${D}, -1, QUARTER)`),
      period("previous_quarter"),
    ],
    [
      "with its bounds in variables",
      `VAR Low = MIN('Date'[Date last year]) VAR High = MAX('Date'[Date last year]) VAR Shifted = CALCULATE([Net Sales], REMOVEFILTERS('Date'[Date]), DATESBETWEEN(${D}, Low, High)) RETURN Shifted`,
      period("previous_year"),
    ],
    [
      "with a slicer picking the date",
      `VAR Basis = SELECTEDVALUE('Basis'[Basis], "Order") RETURN IF(Basis = "Order", ${CALENDAR("Date last month")}, CALCULATE([Net Sales], DATEADD('Ship date'[Date], -1, MONTH)))`,
      period("previous_month"),
    ],
  ])("reads a shift by a calendar column %s", (_, expression, shift) => {
    const dataset = measures({ ...DATASET, Variant: expression });
    expect(recogniseVariant("Variant", dataset, RULES)).toEqual({
      base: "Net Sales",
      shift,
    });
  });

  it("adds no note where the zero changes nothing: a blank less 1 is -1 as 0 less 1 is", () => {
    const dataset = measures({
      ...DATASET,
      Variant: "DIVIDE([Net Sales], [Net Sales PY], 0) - 1",
    });
    expect(recogniseVariant("Variant", dataset, RULES)).toEqual({
      base: "Net Sales",
      shift: compared("growth_rate", "previous_year"),
    });
  });

  it("compares against a measure shifted by a calendar column", () => {
    const dataset = measures({
      ...DATASET,
      "Sales LM": CALENDAR("Date last month"),
      Variant: "DIVIDE( ( [Net Sales] - [Sales LM] ), [Sales LM] )",
    });
    expect(recogniseVariant("Variant", dataset, RULES)).toEqual({
      base: "Net Sales",
      shift: compared("growth_rate", "previous_month"),
    });
  });

  it.each([
    [
      "a shift",
      `COALESCE(${CALENDAR("Date last year")}, 0)`,
      period("previous_year"),
    ],
    [
      "a slicer's shift",
      `COALESCE(IF(SELECTEDVALUE('Basis'[Basis]) = "Order", ${CALENDAR("Date last year")}, ${CALENDAR("Date last year")}), 0)`,
      period("previous_year"),
    ],
    [
      "a growth rate",
      "COALESCE(DIVIDE([Net Sales] - [Net Sales PY], [Net Sales PY]), 0)",
      compared("growth_rate", "previous_year"),
    ],
    [
      "a growth rate by DIVIDE's alternate result",
      "DIVIDE([Net Sales] - [Net Sales PY], [Net Sales PY], 0)",
      compared("growth_rate", "previous_year"),
    ],
    [
      "a ratio by DIVIDE's alternate result",
      "DIVIDE([Net Sales], [Net Sales PY], 0)",
      compared("ratio", "previous_year"),
    ],
    [
      "a difference against a shift that shows 0",
      "[Net Sales] - [Sales LM zero]",
      compared("difference", "previous_month"),
    ],
    [
      "a growth rate against a shift that shows 0",
      "DIVIDE([Net Sales] - [Sales LM zero], [Sales LM zero])",
      compared("growth_rate", "previous_month"),
    ],
    [
      "the previous year of a year to date that shows 0",
      `CALCULATE([Sales YTD zero], SAMEPERIODLASTYEAR(${D}))`,
      period("previous_year_to_date"),
    ],
  ])("says blank shows as zero on %s", (_, expression, shift) => {
    const dataset = measures({
      ...DATASET,
      "Sales LM zero": `COALESCE(${CALENDAR("Date last month")}, 0)`,
      "Sales YTD zero": `COALESCE(TOTALYTD([Net Sales], ${D}), 0)`,
      Variant: expression,
    });
    expect(recogniseVariant("Variant", dataset, RULES)).toEqual({
      base: "Net Sales",
      shift,
      blank_as_zero: true,
    });
  });

  it.each([
    [
      "an extra filter",
      `CALCULATE([Net Sales], REMOVEFILTERS(${D}), DATESBETWEEN(${D}, MIN('Date'[Date LY]), MAX('Date'[Date LY])), 'Product'[Color] = "Red")`,
    ],
    [
      "a filter cleared on another table",
      CALENDAR("Date last year", "REMOVEFILTERS('Product'[Color])"),
    ],
    [
      "another column cleared with no calendar read, which drops that filter",
      "CALCULATE([Net Sales], ALL(Sales[Region]), DATEADD(Sales[Order date], -1, YEAR))",
    ],
    [
      "the table holding the measure cleared, which is no calendar",
      "CALCULATE([Net Sales], REMOVEFILTERS(Sales), DATESBETWEEN(Sales[Order date], MIN(Sales[Date LY]), MAX(Sales[Date LY])))",
    ],
    [
      "the dates between the first and last of the same column, which is no step back",
      `CALCULATE([Net Sales], DATESBETWEEN('Date'[Date LY], MIN('Date'[Date LY]), MAX('Date'[Date LY])))`,
    ],
    [
      "two ways of going back that say different periods",
      CALENDAR("Date last quarter", `DATEADD(${D}, -1, MONTH)`),
    ],
    [
      "two ways of going back on different columns",
      CALENDAR("Date last quarter", "DATEADD('Date'[Ship date], -1, QUARTER)"),
    ],
    [
      "bounds from another table",
      `CALCULATE([Net Sales], DATESBETWEEN(${D}, MIN('Other'[Date LY]), MAX('Other'[Date LY])))`,
    ],
    [
      "bounds from two columns",
      `CALCULATE([Net Sales], DATESBETWEEN(${D}, MIN('Date'[Date LY]), MAX('Date'[Date LM])))`,
    ],
    [
      "the bounds swapped",
      `CALCULATE([Net Sales], DATESBETWEEN(${D}, MAX('Date'[Date LY]), MIN('Date'[Date LY])))`,
    ],
    [
      "fixed bounds",
      `CALCULATE([Net Sales], DATESBETWEEN(${D}, DATE(2024, 1, 1), MAX('Date'[Date LY])))`,
    ],
    ["a column that names no period", CALENDAR("Fiscal shift")],
    ["a column that names two periods", CALENDAR("Date last year last month")],
    ["a word inside a longer word", CALENDAR("Date only")],
    [
      "DATEADD saying another period than the column",
      CALENDAR("Date last day", `DATEADD(${D}, -7, DAY)`),
    ],
    [
      "a whole table cleared with no calendar column",
      `CALCULATE([Net Sales], REMOVEFILTERS('Sales'), DATEADD('Sales'[Date], -1, YEAR))`,
    ],
    ["nothing but clearing", `CALCULATE([Net Sales], REMOVEFILTERS(${D}))`],
    [
      "two arguments to REMOVEFILTERS",
      `CALCULATE([Net Sales], REMOVEFILTERS(${D}, 'Date'[Year]), DATESBETWEEN(${D}, MIN('Date'[Date LY]), MAX('Date'[Date LY])))`,
    ],
    [
      "a slicer's two different periods",
      `IF(SELECTEDVALUE('Basis'[Basis]) = "x", ${CALENDAR("Date last year")}, ${CALENDAR("Date last month")})`,
    ],
    [
      "a slicer's two different measures",
      `IF(SELECTEDVALUE('Basis'[Basis]) = "x", CALCULATE([Net Sales], SAMEPERIODLASTYEAR(${D})), CALCULATE([Units], SAMEPERIODLASTYEAR(${D})))`,
    ],
    [
      "a test that reads a measure",
      `IF([Units] > 0, ${CALENDAR("Date last year")}, ${CALENDAR("Date last year")})`,
    ],
    [
      "a test against a measure",
      `IF(SELECTEDVALUE('Basis'[Basis]) = [Units], ${CALENDAR("Date last year")}, ${CALENDAR("Date last year")})`,
    ],
    [
      "an IF with one branch",
      `IF(SELECTEDVALUE('Basis'[Basis]) = "x", ${CALENDAR("Date last year")})`,
    ],
    ["a default other than zero", `COALESCE(${CALENDAR("Date last year")}, 1)`],
    [
      "three arguments to COALESCE",
      `COALESCE(${CALENDAR("Date last year")}, 0, 1)`,
    ],
    ["blank as zero on the base itself", "COALESCE([Net Sales], 0)"],
    [
      "an alternate result other than zero",
      "DIVIDE([Net Sales], [Net Sales PY], 1)",
    ],
  ])("%s is no shift by a calendar column", (_, expression) => {
    const dataset = measures({ ...DATASET, Variant: expression });
    expect(recogniseVariant("Variant", dataset, RULES)).toBeNull();
  });

  describe("with the measures on a table of their own", () => {
    const onTheirOwnTable = (entries: Record<string, string>) =>
      measureMap(
        Object.entries(entries).map(([name, expression]) => ({
          name,
          expression,
          table: "_Measures",
        })),
      );
    const shiftOn = (table: string, clear: string) =>
      `CALCULATE([Lines], ${clear}, DATESBETWEEN(${table}[On], MIN(${table}[Date last year]), MAX(${table}[Date last year])))`;

    it.each([
      ["the table", "Sales", "REMOVEFILTERS(Sales)"],
      ["the table, quoted", "'Sales'", "ALL('Sales')"],
      ["another of its columns", "Sales", "REMOVEFILTERS(Sales[Channel])"],
    ])("is no shift that clears %s the base reads", (_, table, clear) => {
      const dataset = onTheirOwnTable({
        Lines: "COUNTROWS(Sales)",
        Variant: shiftOn(table, clear),
      });
      expect(recogniseVariant("Variant", dataset, RULES)).toBeNull();
    });

    it("is no shift that clears a table the base reads through another measure", () => {
      const dataset = onTheirOwnTable({
        Rows: "COUNTROWS(Sales)",
        Lines: "[Rows] * 2",
        Variant: shiftOn("Sales", "REMOVEFILTERS(Sales)"),
      });
      expect(recogniseVariant("Variant", dataset, RULES)).toBeNull();
    });

    it("is no shift that clears a measure, which is not a column", () => {
      const dataset = measureMap([
        { name: "Lines", expression: "COUNTROWS(Sales)", table: "_Measures" },
        { name: "On it", expression: "1", table: "Date" },
        {
          name: "Variant",
          expression: `CALCULATE([Lines], ALL('Date'[On it]), DATESBETWEEN(${D}, MIN('Date'[Date LY]), MAX('Date'[Date LY])))`,
          table: "_Measures",
        },
      ]);
      expect(recogniseVariant("Variant", dataset, RULES)).toBeNull();
    });

    it("is a shift that clears a calendar the base does not read", () => {
      const dataset = onTheirOwnTable({
        Lines: "COUNTROWS(Sales)",
        Variant: shiftOn("'Date'", "REMOVEFILTERS('Date')"),
      });
      expect(recogniseVariant("Variant", dataset, RULES)).toMatchObject({
        base: "Lines",
        shift: period("previous_year"),
      });
    });
  });

  it("keeps the note of either side of a slicer's choice, in either order", () => {
    const shift = (base: string) =>
      `CALCULATE([${base}], SAMEPERIODLASTYEAR(${D}))`;
    const test = "SELECTEDVALUE('Basis'[Basis]) = \"x\"";
    const YEAR = {
      YTD: `TOTALYTD([Net Sales], ${D})`,
      "YTD or 0": `COALESCE(TOTALYTD([Net Sales], ${D}), 0)`,
    };
    for (const [one, other] of [
      ["YTD", "YTD or 0"],
      ["YTD or 0", "YTD"],
    ] as const) {
      const dataset = measures({
        ...DATASET,
        ...YEAR,
        Variant: `IF(${test}, ${shift(one)}, ${shift(other)})`,
      });
      expect(recogniseVariant("Variant", dataset, RULES)).toMatchObject({
        shift: period("previous_year_to_date"),
        blank_as_zero: true,
      });
    }
  });

  it("files nothing whose own name says another period than its calendar column", () => {
    const dataset = measures({
      ...DATASET,
      "Sales LY": CALENDAR("Date last month"),
      "Sales LM": CALENDAR("Date last month"),
      "Sales MoM": CALENDAR("Date last month"),
    });
    expect(recogniseVariant("Sales LY", dataset, RULES)).toBeNull();
    expect(recogniseVariant("Sales LM", dataset, RULES)?.shift).toEqual(
      period("previous_month"),
    );
    // A name that says no period is no contradiction.
    expect(recogniseVariant("Sales MoM", dataset, RULES)?.shift).toEqual(
      period("previous_month"),
    );
  });

  it("reads a company's own words for a period", () => {
    const dataset = measures({
      ...DATASET,
      Variant: CALENDAR("Dato sidste år"),
    });
    expect(recogniseVariant("Variant", dataset, RULES)).toBeNull();
    const danish: VariantRules = {
      ...RULES,
      period_words: { ...RULES.period_words, previous_year: ["Sidste år"] },
    };
    expect(recogniseVariant("Variant", dataset, danish)?.shift).toEqual(
      period("previous_year"),
    );
  });

  describe("a shift composed of shifted measures", () => {
    const lastYear = (measure: string) =>
      `CALCULATE([${measure}], SAMEPERIODLASTYEAR(${D}))`;
    const monthBack = (measure: string) =>
      `CALCULATE([${measure}], DATEADD(${D}, -1, MONTH))`;
    const yearToDate = (measure: string) => `TOTALYTD([${measure}], ${D})`;
    const bySlicer = (measure: string) =>
      `IF(SELECTEDVALUE('Basis'[Basis]) = "x", ${lastYear(measure)}, CALCULATE([${measure}], SAMEPERIODLASTYEAR('Ship date'[Date])))`;
    const byCalendar = (measure: string) =>
      `CALCULATE([${measure}], REMOVEFILTERS('Date'), DATESBETWEEN(${D}, MIN('Date'[Date last month]), MAX('Date'[Date last month])))`;

    const RATIO = {
      Num: "SUM('Sales'[Amount])",
      Den: "SUM('Sales'[Quantity])",
      Cost: "SUM('Sales'[Cost amount])",
      Hundred: "100",
      "Num LY": lastYear("Num"),
      "Den LY": lastYear("Den"),
      "Cost LY": lastYear("Cost"),
      "Num PM": monthBack("Num"),
      "Den PM": monthBack("Den"),
      "Num YTD": yearToDate("Num"),
      "Den YTD": yearToDate("Den"),
      "Num LY YTD": lastYear("Num YTD"),
      "Den LY YTD": lastYear("Den YTD"),
      "Den YTD by ship date": `TOTALYTD([Den], 'Ship date'[Date])`,
      "Den LY YTD by ship date": lastYear("Den YTD by ship date"),
      "Num or 0": `COALESCE(${lastYear("Num")}, 0)`,
      "Den or 0": `COALESCE(${lastYear("Den")}, 0)`,
      "Num slicer": bySlicer("Num"),
      "Den slicer": bySlicer("Den"),
      "Num calendar": byCalendar("Num"),
      "Den calendar": byCalendar("Den"),
      "Den parallel": `CALCULATE([Den], PARALLELPERIOD(${D}, -1, YEAR))`,
      "Den by ship date": `CALCULATE([Den], SAMEPERIODLASTYEAR('Ship date'[Date]))`,
      "Den Red": `CALCULATE([Den], SAMEPERIODLASTYEAR(${D}), 'Product'[Color] = "Red")`,
      Ratio: "DIVIDE([Num], [Den])",
    };
    const dataset = (expression: string, more: Record<string, string> = {}) =>
      measures({ ...RATIO, ...more, Variant: expression });

    it.each([
      [
        "the plain ratio",
        "DIVIDE([Num LY], [Den LY])",
        period("previous_year"),
      ],
      [
        "written with variables and a table's name",
        "VAR N = 'Sales'[Num LY] VAR Under = [Den LY] VAR R = DIVIDE(N, Under) RETURN R",
        period("previous_year"),
      ],
      [
        "by another period",
        "DIVIDE([Num PM], [Den PM])",
        period("previous_month"),
      ],
      [
        "by a period to date",
        "DIVIDE([Num YTD], [Den YTD])",
        period("year_to_date"),
      ],
      [
        "by the previous year of a year to date",
        "DIVIDE([Num LY YTD], [Den LY YTD])",
        period("previous_year_to_date"),
      ],
      [
        "by a slicer's one choice on both sides",
        "DIVIDE([Num slicer], [Den slicer])",
        period("previous_year"),
      ],
    ])("files %s under the base's metric", (_, expression, shift) => {
      expect(
        recogniseVariant("Variant", dataset(expression), NO_RULES),
      ).toEqual({ base: "Ratio", shift });
    });

    it("reads a shift by a calendar column on both sides", () => {
      expect(
        recogniseVariant(
          "Variant",
          dataset("DIVIDE([Num calendar], [Den calendar])"),
          RULES,
        ),
      ).toEqual({ base: "Ratio", shift: period("previous_month") });
    });

    it.each([
      [
        "a ratio times a literal",
        "DIVIDE([Num], [Den]) * 100",
        "DIVIDE([Num LY], [Den LY]) * 100",
      ],
      [
        "a difference over a measure",
        "DIVIDE([Num] - [Cost], [Den])",
        "DIVIDE([Num LY] - [Cost LY], [Den LY])",
      ],
      ["a plain difference", "[Num] - [Cost]", "[Num LY] - [Cost LY]"],
      [
        "brackets that bind",
        "([Num] + [Cost]) * 2",
        "([Num LY] + [Cost LY]) * 2",
      ],
      [
        "one measure and a literal",
        "DIVIDE([Num], 1000)",
        "DIVIDE([Num LY], 1000)",
      ],
      ["a minus sign", "-[Num]", "-[Num LY]"],
    ])("reads a base that holds other operators: %s", (_, base, expression) => {
      expect(
        recogniseVariant("Variant", dataset(expression, { Base: base }), RULES),
      ).toEqual({ base: "Base", shift: period("previous_year") });
    });

    it("reads through a measure that is itself composed", () => {
      const more = {
        Margin: "[Num] - [Cost]",
        "Margin LY": "[Num LY] - [Cost LY]",
        "Margin rate": "DIVIDE([Margin], [Num])",
      };
      expect(
        recogniseVariant(
          "Variant",
          dataset("DIVIDE([Margin LY], [Num LY])", more),
          NO_RULES,
        ),
      ).toEqual({ base: "Margin rate", shift: period("previous_year") });
    });

    it.each([
      [
        "a difference",
        "[Ratio] - [Ratio LY]",
        compared("difference", "previous_year"),
      ],
      [
        "a growth rate",
        "DIVIDE([Ratio] - [Ratio LY], [Ratio LY])",
        compared("growth_rate", "previous_year"),
      ],
      [
        "a ratio",
        "DIVIDE([Ratio], [Ratio LY])",
        compared("ratio", "previous_year"),
      ],
    ])("compares against a composed shift: %s", (_, expression, shift) => {
      const more = { "Ratio LY": "DIVIDE([Num LY], [Den LY])" };
      expect(
        recogniseVariant("Variant", dataset(expression, more), NO_RULES),
      ).toEqual({ base: "Ratio", shift });
    });

    it("takes the previous year of a composed year to date as the previous year to date", () => {
      const more = { "Ratio YTD": "DIVIDE([Num YTD], [Den YTD])" };
      expect(
        recogniseVariant(
          "Variant",
          dataset(lastYear("Ratio YTD"), more),
          NO_RULES,
        ),
      ).toEqual({ base: "Ratio", shift: period("previous_year_to_date") });
    });

    it("names the first by name of two measures of one calculation", () => {
      const more = { "A ratio": "DIVIDE( 'Sales'[Num], [Den] )" };
      expect(
        recogniseVariant(
          "Variant",
          dataset("DIVIDE([Num LY], [Den LY])", more),
          NO_RULES,
        ),
      ).toMatchObject({ base: "A ratio" });
    });

    it.each([
      ["a zero", "DIVIDE([Num], [Den], 0)", "DIVIDE([Num LY], [Den LY], 0)"],
      [
        "another literal",
        "DIVIDE([Num], [Den], 1)",
        "DIVIDE([Num LY], [Den LY], 1)",
      ],
    ])(
      "needs no reading and adds no note when the base has the same alternate result: %s",
      (_, base, expression) => {
        expect(
          recogniseVariant(
            "Variant",
            dataset(expression, { Base: base }),
            NO_RULES,
          ),
        ).toEqual({ base: "Base", shift: period("previous_year") });
      },
    );

    it("reads it written the long way on every side, with one zero on both and no note", () => {
      const back = (measure: string) =>
        `VAR High = MAX('Date'[Date last year]) VAR Low = MIN('Date'[Date last year]) VAR Back = CALCULATE([${measure}], REMOVEFILTERS(${D}), DATESBETWEEN(${D}, Low, High)) RETURN Back`;
      const of = dataset(
        "VAR Top = [Num back] VAR Under = [Den back] RETURN DIVIDE(Top, Under, 0)",
        {
          "Num back": back("Num"),
          "Den back": back("Den").replaceAll("Back", "Earlier"),
          "Long ratio":
            "VAR Upper = [Num] VAR Lower = [Den] RETURN DIVIDE(Upper, Lower, 0)",
        },
      );
      expect(recogniseVariant("Variant", of, RULES)).toEqual({
        base: "Long ratio",
        shift: period("previous_year"),
      });
    });

    it("prefers the base with the same alternate result to one it would add a note to", () => {
      expect(
        recogniseVariant(
          "Variant",
          dataset("DIVIDE([Num LY], [Den LY], 0)", {
            "Z ratio": "DIVIDE([Num], [Den], 0)",
          }),
          RULES,
        ),
      ).toEqual({ base: "Z ratio", shift: period("previous_year") });
    });

    it.each([
      ["DIVIDE's alternate result", "DIVIDE([Num LY], [Den LY], 0)"],
      ["COALESCE around it", "COALESCE(DIVIDE([Num LY], [Den LY]), 0)"],
      ["the numerator's shift", "DIVIDE([Num or 0], [Den LY])"],
      ["the denominator's shift", "DIVIDE([Num LY], [Den or 0])"],
      ["both shifts", "DIVIDE([Num or 0], [Den or 0])"],
    ])("says a zero shows for a blank from %s", (_, expression) => {
      expect(recogniseVariant("Variant", dataset(expression), RULES)).toEqual({
        base: "Ratio",
        shift: period("previous_year"),
        blank_as_zero: true,
      });
    });

    describe("with a measure's own zero under a times", () => {
      const more = {
        Rate: "[Num] / [Den]",
        "Rate LY": lastYear("Rate"),
        Sum: "[Num] + [Cost]",
        "Sum or 0": "[Num or 0] + [Cost LY]",
      };
      const withBase = (base: string, expression: string) =>
        measures({ ...RATIO, ...more, Base: base, Variant: expression });

      // 0 times infinity is NaN and a blank times infinity is a blank, so this is
      // NaN where the base is 1. A measure gets to infinity by a slash inside it.
      it.each([
        [
          "a measure with a slash inside it",
          "1 + [Num] * [Rate]",
          "1 + [Num or 0] * [Rate LY]",
        ],
        ["another measure", "[Num] * [Cost]", "[Num or 0] * [Cost LY]"],
        [
          "brackets around a sum",
          "([Num] + [Cost]) * 2",
          "([Num or 0] + [Cost LY]) * 2",
        ],
        [
          "a ratio it divides",
          "DIVIDE([Num], [Den]) * 2",
          "DIVIDE([Num or 0], [Den LY]) * 2",
        ],
        ["a measure that carries the zero on", "[Sum] * 2", "[Sum or 0] * 2"],
        ["only a literal, a missed merge", "[Num] * 100", "[Num or 0] * 100"],
      ])("keeps it apart, with %s", (_, base, expression) => {
        expect(
          recogniseVariant("Variant", withBase(base, expression), RULES),
        ).toBeNull();
      });

      it("files the same calculation with no zero, and no note", () => {
        expect(
          recogniseVariant(
            "Variant",
            withBase("1 + [Num] * [Rate]", "1 + [Num LY] * [Rate LY]"),
            RULES,
          ),
        ).toEqual({ base: "Base", shift: period("previous_year") });
      });

      it("files a zero on the whole DIVIDE, as it shows only where the base is blank", () => {
        expect(
          recogniseVariant(
            "Variant",
            withBase(
              "DIVIDE([Num] * [Rate], [Den])",
              "DIVIDE([Num LY] * [Rate LY], [Den LY], 0)",
            ),
            RULES,
          ),
        ).toEqual({
          base: "Base",
          shift: period("previous_year"),
          blank_as_zero: true,
        });
      });

      it("files a measure's own zero where no times is", () => {
        expect(
          recogniseVariant(
            "Variant",
            withBase("1 + [Num] - [Rate]", "1 + [Num or 0] - [Rate LY]"),
            RULES,
          ),
        ).toEqual({
          base: "Base",
          shift: period("previous_year"),
          blank_as_zero: true,
        });
      });
    });

    it("carries the note on to a comparison against a composed shift", () => {
      const more = { "Ratio LY": "DIVIDE([Num LY], [Den LY], 0)" };
      expect(
        recogniseVariant(
          "Variant",
          dataset("[Ratio] - [Ratio LY]", more),
          RULES,
        ),
      ).toEqual({
        base: "Ratio",
        shift: compared("difference", "previous_year"),
        blank_as_zero: true,
      });
    });

    it.each([
      ["DIVIDE's alternate result", "DIVIDE([Num LY], [Den LY], 0)"],
      ["COALESCE around it", "COALESCE(DIVIDE([Num LY], [Den LY]), 0)"],
      ["a shift that shows 0", "DIVIDE([Num or 0], [Den LY])"],
    ])("reads no zero from %s with no rule for it", (_, expression) => {
      expect(
        recogniseVariant("Variant", dataset(expression), NO_RULES),
      ).toBeNull();
    });

    it.each([
      ["only the numerator shifted", "DIVIDE([Num LY], [Den])"],
      ["only the denominator shifted", "DIVIDE([Num], [Den LY])"],
      ["the sides reversed", "DIVIDE([Den LY], [Num LY])"],
      ["two periods", "DIVIDE([Num LY], [Den PM])"],
      [
        "one period by two filters, which cover other dates on part of a month",
        "DIVIDE([Num LY], [Den parallel])",
      ],
      [
        "one period along two date columns",
        "DIVIDE([Num LY], [Den by ship date])",
      ],
      [
        "a previous year and a previous year to date",
        "DIVIDE([Num LY YTD], [Den LY])",
      ],
      [
        "one period from two years to date",
        "DIVIDE([Num LY YTD], [Den LY YTD by ship date])",
      ],
      ["a shift with one more filter", "DIVIDE([Num LY], [Den Red])"],
      [
        "a period by a calendar and by a filter",
        "DIVIDE([Num calendar], [Den PM])",
      ],
      ["no measure of that calculation", "DIVIDE([Num LY], [Cost LY])"],
      ["a measure that is no shift", "DIVIDE([Num LY], [Hundred])"],
      ["another operator than the base's", "DIVIDE([Num LY], [Den LY]) * 100"],
      ["a slash where the base has DIVIDE", "[Num LY] / [Den LY]"],
      [
        "a date filter of its own",
        `CALCULATE(DIVIDE([Num LY], [Den LY]), ${D})`,
      ],
      [
        "a second alternate result, not a zero",
        "DIVIDE([Num LY], [Den LY], 1)",
      ],
    ])("%s is no composed shift", (_, expression) => {
      expect(
        recogniseVariant("Variant", dataset(expression), RULES),
      ).toBeNull();
    });

    it.each([
      [
        "more operators than the shift",
        "DIVIDE([Num], [Den]) * 100",
        "DIVIDE([Num LY], [Den LY])",
      ],
      [
        "another measure than the shift",
        "DIVIDE([Num] - [Cost], [Den])",
        "DIVIDE([Num LY], [Den LY])",
      ],
      [
        "a column, which no filter around the shift would reach",
        "DIVIDE([Num], SUM('Sales'[Quantity]))",
        "DIVIDE([Num LY], SUM('Sales'[Quantity]))",
      ],
      [
        "a column of no measure, which no filter would reach",
        "DIVIDE([Num], [Quantity])",
        "DIVIDE([Num LY], [Quantity])",
      ],
      [
        "a measure left unshifted, which no filter would reach",
        "DIVIDE([Num], [Hundred])",
        "DIVIDE([Num LY], [Hundred])",
      ],
      [
        "a function outside the arithmetic",
        "ABS(DIVIDE([Num], [Den]))",
        "ABS(DIVIDE([Num LY], [Den LY]))",
      ],
      [
        "a test",
        "IF([Den] > 0, DIVIDE([Num], [Den]))",
        "IF([Den LY] > 0, DIVIDE([Num LY], [Den LY]))",
      ],
      [
        "a slash, where a zero for a blank can give NaN",
        "[Num] / [Den]",
        "[Num LY] / [Den LY]",
      ],
      ["a power", "[Num] ^ 2", "[Num LY] ^ 2"],
      [
        "a zero the shift does not have",
        "DIVIDE([Num], [Den], 0)",
        "DIVIDE([Num LY], [Den LY])",
      ],
      [
        "another alternate result than the shift",
        "DIVIDE([Num], [Den], 1)",
        "DIVIDE([Num LY], [Den LY], 0)",
      ],
      [
        "a zero read only at the whole calculation",
        "DIVIDE([Num], [Den]) * 100",
        "DIVIDE([Num LY], [Den LY], 0) * 100",
      ],
      ["no measure at all", "1 + 1", "1 + 1"],
    ])("a base with %s keeps the shift apart", (_, base, expression) => {
      const others = Object.entries(RATIO).filter(([n]) => n !== "Ratio");
      const without = measures({
        ...Object.fromEntries(others),
        Base: base,
        Variant: expression,
      });
      expect(recogniseVariant("Variant", without, RULES)).toBeNull();
    });

    it("files nothing whose own name says another period than its calendar column", () => {
      const more = {
        "Ratio LY": "DIVIDE([Num calendar], [Den calendar])",
        "Ratio LM": "DIVIDE([Num calendar], [Den calendar])",
      };
      const of = dataset("1", more);
      expect(recogniseVariant("Ratio LY", of, RULES)).toBeNull();
      expect(recogniseVariant("Ratio LM", of, RULES)?.shift).toEqual(
        period("previous_month"),
      );
    });

    it("lets the DAX decide when no calendar column is read", () => {
      const of = dataset("1", { "Ratio LY": "DIVIDE([Num PM], [Den PM])" });
      expect(recogniseVariant("Ratio LY", of, RULES)?.shift).toEqual(
        period("previous_month"),
      );
    });

    describe("with a date column written bare", () => {
      const onTables = (den: string) =>
        measureMap([
          { name: "N", expression: "SUM(Sales[Amount])", table: "Sales" },
          { name: "M", expression: "SUM(Sales[Units])", table: den },
          {
            name: "N LY",
            expression: "CALCULATE([N], SAMEPERIODLASTYEAR([Date]))",
            table: "Sales",
          },
          {
            name: "M LY",
            expression: "CALCULATE([M], SAMEPERIODLASTYEAR([Date]))",
            table: den,
          },
          { name: "Ratio", expression: "DIVIDE([N], [M])", table: "Sales" },
          {
            name: "Variant",
            expression: "DIVIDE([N LY], [M LY])",
            table: "Sales",
          },
        ]);

      it("reads one filter on one home table", () => {
        expect(
          recogniseVariant("Variant", onTables("Sales"), NO_RULES),
        ).toMatchObject({ base: "Ratio", shift: period("previous_year") });
      });

      it("reads one column written bare on its own table and with the table name", () => {
        const dataset = measureMap([
          { name: "N", expression: "SUM(Sales[Amount])", table: "Sales" },
          { name: "M", expression: "SUM(Sales[Units])", table: "Sales" },
          {
            name: "N LY",
            expression: "CALCULATE([N], SAMEPERIODLASTYEAR([Date]))",
            table: "Date",
          },
          {
            name: "M LY",
            expression: "CALCULATE([M], SAMEPERIODLASTYEAR('Date'[Date]))",
            table: "Sales",
          },
          { name: "Ratio", expression: "DIVIDE([N], [M])", table: "Sales" },
          {
            name: "Variant",
            expression: "DIVIDE([N LY], [M LY])",
            table: "Sales",
          },
        ]);
        expect(recogniseVariant("Variant", dataset, NO_RULES)).toMatchObject({
          base: "Ratio",
          shift: period("previous_year"),
        });
      });

      it("keeps apart two home tables, where it is two columns", () => {
        expect(
          recogniseVariant("Variant", onTables("Returns"), NO_RULES),
        ).toBeNull();
      });
    });

    it("compares against a shift of another measure that writes the same calculation", () => {
      const more = {
        "A copy": "DIVIDE( 'Sales'[Num], [Den] )",
        "Ratio LY": "DIVIDE([Num LY], [Den LY])",
      };
      expect(
        recogniseVariant(
          "Variant",
          dataset("[Ratio] - [Ratio LY]", more),
          RULES,
        ),
      ).toEqual({
        base: "Ratio",
        shift: compared("difference", "previous_year"),
      });
    });

    it("does not compare against a shift of a calculation only like its own", () => {
      const more = {
        Other: "DIVIDE([Num], [Cost])",
        "Other LY": "DIVIDE([Num LY], [Cost LY])",
      };
      expect(
        recogniseVariant(
          "Variant",
          dataset("[Ratio] - [Other LY]", more),
          RULES,
        ),
      ).toBeNull();
    });

    it("is not thrown off by another measure's broken DAX", () => {
      const of = dataset("DIVIDE([Num LY], [Den LY])", {
        Broken: "'not closed",
      });
      expect(recogniseVariant("Variant", of, RULES)).toMatchObject({
        base: "Ratio",
      });
    });
  });

  it("gives null for a measure on a reference cycle", () => {
    const dataset = measures({
      Ahead: `CALCULATE([Behind], SAMEPERIODLASTYEAR(${D}))`,
      Behind: `CALCULATE([Ahead], SAMEPERIODLASTYEAR(${D}))`,
    });
    expect(recogniseVariant("Ahead", dataset, NO_RULES)).toBeNull();
  });
});
