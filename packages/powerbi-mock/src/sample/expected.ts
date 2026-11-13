/**
 * What later tests assert against the sample tenant. Written by hand from
 * the measures in `tenant.ts` and the spec's rules, never computed from the
 * drafter, so a test fails when the drafter changes its mind. A change to the
 * sample changes these on purpose. Every name is invented sample data.
 */

// The DAX module's shift, restated: the mock is a package of its own and
// imports nothing from the api.
export type Period =
  | "current"
  | "previous_year"
  | "previous_quarter"
  | "previous_month"
  | "previous_week"
  | "previous_day"
  | "year_to_date"
  | "quarter_to_date"
  | "month_to_date"
  | "previous_year_to_date"
  | "rolling_12_months"
  | "other";
export type Comparison = "none" | "difference" | "growth_rate" | "ratio";
export type Shift = {
  period: Period;
  comparison: Comparison;
  comparison_period: Period | null;
};

/** A measure of the sample, by its dataset's name and its own. */
export type SampleMeasure = { dataset: string; measure: string };
/** A measure a variant pattern files under a metric; `of` is the base measure it shifts, in the same dataset. */
export type ExpectedVariant = SampleMeasure & {
  of: string;
  shift: Shift;
  note?: string;
};
/** Base variants share one fingerprint, once in each dataset that holds the calculation. */
export type ExpectedDraft = {
  base: SampleMeasure[];
  variants: ExpectedVariant[];
};

const SALES = "Sales";
const FINANCE = "Finance";
const MARKETING = "Marketing";
const CAMPAIGN_ARCHIVE = "Campaign archive";
const RETAIL = "Retail";

const period = (p: Period): Shift => ({
  period: p,
  comparison: "none",
  comparison_period: null,
});
const against = (comparison: Comparison, p: Period): Shift => ({
  period: "current",
  comparison,
  comparison_period: p,
});
const variantsOf = (
  dataset: string,
  of: string,
  shifts: [measure: string, shift: Shift][],
): ExpectedVariant[] =>
  shifts.map(([measure, shift]) => ({ dataset, measure, of, shift }));
const alone = (dataset: string, measure: string): ExpectedDraft => ({
  base: [{ dataset, measure }],
  variants: [],
});
/** The note on a variant that shows 0 where its calculation is blank. */
export const BLANK_AS_ZERO_NOTE = "Shows 0 where the calculation is blank.";
const suggested = (
  oneDataset: string,
  oneMeasure: string,
  otherDataset: string,
  otherMeasure: string,
) => ({
  measures: [
    { dataset: oneDataset, measure: oneMeasure },
    { dataset: otherDataset, measure: otherMeasure },
  ] as [SampleMeasure, SampleMeasure],
  why: "The names differ by a period word or a nearby measure name.",
  suggested_by_name: true,
});

/**
 * Every draft the drafter makes from the sample under the default
 * conventions. With EXPECTED_DISMISSED and EXPECTED_CYCLE it names every
 * measure of the sample exactly once.
 */
/**
 * The sample's measures that read as time-shifted with no proof of how: each is
 * a draft of its own, filed period `other`.
 */
export const EXPECTED_UNPROVEN_SHIFTS: string[] = [
  "Web net sales LY",
  "Web order lines LM",
  "Order lines held",
  "Order lines LQ",
  "Average order value LY",
  "Gross margin % on PY margin",
  "Gross margin points PY",
  "Ad spend LY",
];

export const EXPECTED_DRAFTS: ExpectedDraft[] = [
  {
    // One calculation under one name in two datasets; Marketing's is spelled
    // with other case and spacing and carries a comment.
    base: [
      { dataset: SALES, measure: "Net sales" },
      { dataset: MARKETING, measure: "Net Sales" },
    ],
    variants: variantsOf(SALES, "Net sales", [
      ["Net sales LY", period("previous_year")],
      ["Net sales YTD", period("year_to_date")],
      ["Net sales QTD", period("quarter_to_date")],
      ["Net sales MTD", period("month_to_date")],
      // The previous year of a year-to-date variant is the previous year to date of its base.
      ["Net sales LY YTD", period("previous_year_to_date")],
      ["Net sales vs LY", against("difference", "previous_year")],
      ["Net sales growth", against("growth_rate", "previous_year")],
    ]),
  },
  {
    // That calculation under another name: a reader of Finance alone must not
    // learn the words Net sales, so it stays a draft of its own and is offered
    // as a merge.
    base: [{ dataset: FINANCE, measure: "Revenue" }],
    variants: variantsOf(FINANCE, "Revenue", [
      ["Revenue PY", period("previous_year")],
      ["Revenue PQ", period("previous_quarter")],
      ["Revenue YTD", period("year_to_date")],
      ["Revenue PY YTD", period("previous_year_to_date")],
    ]),
  },
  {
    // One calculation in two spellings, with its shifts written the long way:
    // variables, brackets, calendar columns, zero for a blank and a slicer.
    base: [
      { dataset: SALES, measure: "Order lines" },
      { dataset: MARKETING, measure: "Order lines" },
    ],
    variants: [
      ...variantsOf(SALES, "Order lines", [
        ["Order lines LM", period("previous_month")],
        ["Order lines LY", period("previous_year")],
        ["Order lines MoM", against("growth_rate", "previous_month")],
        ["Order lines YoY", against("growth_rate", "previous_year")],
      ]),
      ...variantsOf(SALES, "Order lines", [
        ["Order lines LW", period("previous_week")],
        ["Order lines WoW", against("growth_rate", "previous_week")],
      ]).map((variant) => ({ ...variant, note: BLANK_AS_ZERO_NOTE })),
    ],
  },
  {
    base: [
      { dataset: SALES, measure: "Orders" },
      { dataset: MARKETING, measure: "Orders" },
    ],
    variants: variantsOf(SALES, "Orders", [
      ["Orders PY", period("previous_year")],
      ["Orders PM", period("previous_month")],
      ["Orders YoY %", against("growth_rate", "previous_year")],
      ["Orders index vs PY", against("ratio", "previous_year")],
    ]),
  },
  {
    base: [{ dataset: SALES, measure: "Units sold" }],
    variants: variantsOf(SALES, "Units sold", [
      ["Units sold LY", period("previous_year")],
      ["Units sold PM", period("previous_month")],
    ]),
  },
  {
    base: [{ dataset: FINANCE, measure: "Gross margin" }],
    variants: variantsOf(FINANCE, "Gross margin", [
      ["Gross margin QTD", period("quarter_to_date")],
      ["Gross margin MTD", period("month_to_date")],
      ["Gross margin PY", period("previous_year")],
      ["Gross margin PQ", period("previous_quarter")],
    ]),
  },
  {
    // Each is the base with its two measures shifted by one filter. The zero
    // for a blank is its own, so that one says so.
    base: [{ dataset: FINANCE, measure: "Gross margin %" }],
    variants: [
      ...variantsOf(FINANCE, "Gross margin %", [
        ["Gross margin % PY", period("previous_year")],
        ["Gross margin % vs PY", against("difference", "previous_year")],
      ]),
      ...variantsOf(FINANCE, "Gross margin %", [
        ["Gross margin % PQ", period("previous_quarter")],
      ]).map((variant) => ({ ...variant, note: BLANK_AS_ZERO_NOTE })),
    ],
  },
  {
    // The base shows 0 for a blank as well, so this zero needs no note.
    base: [{ dataset: SALES, measure: "Units per order" }],
    variants: variantsOf(SALES, "Units per order", [
      ["Units per order PM", period("previous_month")],
    ]),
  },
  {
    base: [{ dataset: MARKETING, measure: "Sessions" }],
    variants: variantsOf(MARKETING, "Sessions", [
      ["Sessions yesterday", period("previous_day")],
    ]),
  },
  // Each of these computes something no other measure does, as the drafter
  // can prove; EXPECTED_NOT_GROUPED says which of them are close to another.
  alone(SALES, "Web net sales LY"),
  alone(SALES, "Web order lines LM"),
  alone(SALES, "Order lines held"),
  alone(SALES, "Order lines LQ"),
  alone(SALES, "Order lines LY zero"),
  alone(RETAIL, "Order lines"),
  alone(SALES, "Average order value"),
  alone(SALES, "Average order value LY"),
  alone(SALES, "Return rate"),
  alone(FINANCE, "Order count"),
  alone(FINANCE, "Revenue USD"),
  alone(FINANCE, "Revenue in selected currency"),
  alone(FINANCE, "Gross margin % on PY margin"),
  alone(FINANCE, "Gross margin points PY"),
  alone(MARKETING, "Ad spend"),
  alone(MARKETING, "Ad spend LY"),
  alone(MARKETING, "Return on ad spend"),
  alone(MARKETING, "Conversion rate"),
  alone(MARKETING, "Cost per click"),
  alone(RETAIL, "Average order value"),
  // Retail has its own tables; measures with the same normalized calculation
  // still share a draft across datasets.
  {
    base: [{ dataset: RETAIL, measure: "Net sales" }],
    variants: variantsOf(RETAIL, "Net sales", [
      ["Net sales LY", period("previous_year")],
      ["Net sales YTD", period("year_to_date")],
      ["Net sales MTD", period("month_to_date")],
    ]),
  },
  {
    base: [{ dataset: RETAIL, measure: "Orders" }],
    variants: variantsOf(RETAIL, "Orders", [
      ["Orders LY", period("previous_year")],
    ]),
  },
  alone(RETAIL, "Returned units"),
  alone(RETAIL, "Units on hand"),
  ...[
    "Gross sales",
    "Units",
    "Gross margin",
    "Gross margin %",
    "Refunds",
    "Return rate",
    "Stock value",
    "Weeks of cover",
    "Budget",
    "Net sales vs budget",
    "Customers",
    "New customers",
    "Selected currency",
    "Report title",
  ].map((measure) => alone(RETAIL, measure)),
];

/** Pairs that compute the same thing, or nearly, and must stay in separate drafts. `suggested_by_name`: `pbmb drafts next` offers the pair as a likely merge. */
export const EXPECTED_NOT_GROUPED: {
  measures: [SampleMeasure, SampleMeasure];
  why: string;
  suggested_by_name: boolean;
}[] = [
  {
    measures: [
      { dataset: SALES, measure: "Orders" },
      { dataset: FINANCE, measure: "Order count" },
    ],
    why: "The same result written another way: DISTINCTCOUNT against COUNTROWS(DISTINCT()). The drafter proves sameness from the text only.",
    suggested_by_name: false,
  },
  {
    measures: [
      { dataset: SALES, measure: "Web net sales LY" },
      { dataset: SALES, measure: "Net sales LY" },
    ],
    why: "A near miss of the previous-year pattern: the extra Channel filter makes it another calculation, not a variant of Net sales.",
    suggested_by_name: false,
  },
  {
    measures: [
      { dataset: FINANCE, measure: "Revenue USD" },
      { dataset: FINANCE, measure: "Revenue" },
    ],
    why: "A currency conversion through a rate table: the same metric, but no pattern proves it. The names differ by the currency word USD.",
    suggested_by_name: true,
  },
  {
    measures: [
      { dataset: MARKETING, measure: "Ad spend LY" },
      { dataset: MARKETING, measure: "Ad spend" },
    ],
    why: "A period shift the patterns do not know (DATEADD of -365 days, which is not a year in a leap year). The names differ by the period word LY.",
    suggested_by_name: true,
  },
  {
    measures: [
      { dataset: FINANCE, measure: "Revenue in selected currency" },
      { dataset: FINANCE, measure: "Revenue" },
    ],
    why: "Converts to whatever currency the slicer selects, so it is not one calculation with Revenue.",
    suggested_by_name: false,
  },
  {
    measures: [
      { dataset: SALES, measure: "Web order lines LM" },
      { dataset: SALES, measure: "Order lines LM" },
    ],
    why: "A near miss of the calendar shift: the extra Channel filter makes it another calculation.",
    suggested_by_name: false,
  },
  {
    measures: [
      { dataset: SALES, measure: "Order lines held" },
      { dataset: SALES, measure: "Order lines LY" },
    ],
    why: "A measure kept in a variable holds this period's value, so CALCULATE cannot shift it. Written out it would be a previous year, and another number.",
    suggested_by_name: false,
  },
  {
    measures: [
      { dataset: SALES, measure: "Order lines LY zero" },
      { dataset: SALES, measure: "Order lines LY" },
    ],
    why: "Both are the previous year of Order lines, and a metric holds one variant per shift in a dataset. The one that shows 0 for a blank gives way.",
    suggested_by_name: false,
  },
  {
    measures: [
      { dataset: SALES, measure: "Average order value LY" },
      { dataset: SALES, measure: "Average order value" },
    ],
    why: "Both its measures are a previous year, by SAMEPERIODLASTYEAR and by PARALLELPERIOD, which cover other dates on part of a month. So it is no one filter around the base. The names differ by the period word LY.",
    suggested_by_name: true,
  },
  {
    measures: [
      { dataset: FINANCE, measure: "Gross margin % on PY margin" },
      { dataset: FINANCE, measure: "Gross margin % PY" },
    ],
    why: "Last year's margin over this year's revenue: only one side is shifted, so it is no shift of Gross margin %.",
    suggested_by_name: false,
  },
  {
    measures: [
      { dataset: FINANCE, measure: "Gross margin points PY" },
      { dataset: FINANCE, measure: "Gross margin % PY" },
    ],
    why: "The same two shifted measures, times 100. No measure is the base of that, so no metric holds it as a shift.",
    suggested_by_name: false,
  },
  suggested(SALES, "Average order value LY", RETAIL, "Average order value"),
  suggested(SALES, "Orders PM", RETAIL, "Orders"),
  suggested(FINANCE, "Gross margin PY", RETAIL, "Gross margin"),
  suggested(FINANCE, "Gross margin PQ", RETAIL, "Gross margin"),
  suggested(FINANCE, "Gross margin % PY", RETAIL, "Gross margin %"),
  suggested(FINANCE, "Gross margin % PQ", RETAIL, "Gross margin %"),
  suggested(SALES, "Order lines LQ", SALES, "Order lines"),
  suggested(SALES, "Order lines LQ", MARKETING, "Order lines"),
  suggested(SALES, "Order lines LQ", RETAIL, "Order lines"),
  suggested(SALES, "Order lines LM", RETAIL, "Order lines"),
  suggested(SALES, "Order lines LW", RETAIL, "Order lines"),
  suggested(SALES, "Order lines LY", RETAIL, "Order lines"),
  suggested(FINANCE, "Gross margin MTD", RETAIL, "Gross margin"),
  suggested(FINANCE, "Gross margin QTD", RETAIL, "Gross margin"),
  suggested(SALES, "Net sales LY", RETAIL, "Net sales"),
  suggested(RETAIL, "Net sales LY", SALES, "Net sales"),
  suggested(RETAIL, "Net sales LY", MARKETING, "Net Sales"),
  suggested(SALES, "Net sales LY YTD", RETAIL, "Net sales YTD"),
  suggested(SALES, "Net sales LY YTD", RETAIL, "Net sales LY"),
  suggested(RETAIL, "Net sales MTD", SALES, "Net sales"),
  suggested(RETAIL, "Net sales MTD", MARKETING, "Net Sales"),
  suggested(SALES, "Net sales MTD", RETAIL, "Net sales"),
  suggested(SALES, "Net sales QTD", RETAIL, "Net sales"),
  suggested(SALES, "Net sales YTD", RETAIL, "Net sales"),
  suggested(RETAIL, "Net sales YTD", SALES, "Net sales"),
  suggested(RETAIL, "Net sales YTD", MARKETING, "Net Sales"),
  suggested(RETAIL, "Orders LY", MARKETING, "Orders"),
  suggested(RETAIL, "Orders LY", SALES, "Orders"),
  suggested(SALES, "Orders PY", RETAIL, "Orders"),
];

/** Names that more than one draft holds, on other tables or written another way: `pbmb drafts next` offers them as a likely merge and the drafter never folds them. */
export const EXPECTED_SAME_NAME: string[] = [
  "Average order value",
  "Gross margin",
  "Gross margin %",
  "Net sales",
  "Order lines",
  "Orders",
  "Return rate",
];

/** Measures that read the selection, with the columns they read as written. Only measures the drafter files; dismissed ones are left out. */
export const EXPECTED_READS_SELECTION: (SampleMeasure & {
  columns: string[];
})[] = [
  {
    dataset: FINANCE,
    measure: "Revenue in selected currency",
    columns: ["'Exchange rate'[Currency]"],
  },
  { dataset: SALES, measure: "Order lines LY", columns: ["Channel[Channel]"] },
];

const UNDERSCORE = "Helper measure (name starts with an underscore)";

/** Drafted as dismissed under the default conventions, with the reason they give. */
export const EXPECTED_DISMISSED: (SampleMeasure & { reason: string })[] = [
  { dataset: SALES, measure: "_Report title", reason: UNDERSCORE },
  { dataset: FINANCE, measure: "_Currency format", reason: UNDERSCORE },
];

/** Each measure references the next and the last references the first; any rotation is the same cycle. All three stay ungrouped. */
export const EXPECTED_CYCLE: { dataset: string; measures: string[] } = {
  dataset: FINANCE,
  measures: ["Target", "Stretch target", "Target gap"],
};

/**
 * Per person's email, the datasets they may describe under
 * `metadata_visibility: powerbi`, from Power BI's access lists and their
 * groups. The revoked person's lists are as for any other; while revoked
 * they cannot connect, so a test reaches them only after reconnecting.
 */
export const EXPECTED_VISIBILITY: Record<string, string[]> = {
  "admin@sample.example": [SALES, FINANCE, MARKETING, CAMPAIGN_ARCHIVE, RETAIL],
  "analyst@sample.example": [SALES, MARKETING, RETAIL],
  // The Sales app publishes both reports, so Retail has the same reach as Sales.
  "viewer@sample.example": [SALES, RETAIL],
  "leader@sample.example": [FINANCE],
  "outsider@sample.example": [],
  "revoked@sample.example": [SALES, RETAIL],
  "app-reader@sample.example": [SALES, RETAIL],
  "sales-viewer@sample.example": [SALES, RETAIL],
};

export type PathAccess = { org_path: boolean; groups_path: boolean };
// `org_path` is POST /v1.0/myorg/datasets/{id}/executeQueries, `groups_path`
// the same under /groups/{workspaceId}. A query needs Build; the groups path
// also needs workspace membership, so Power BI refuses it to someone who
// reaches the dataset only through an app audience or a direct share.
const BOTH: PathAccess = { org_path: true, groups_path: true };
const ORG_ONLY: PathAccess = { org_path: true, groups_path: false };
const NEITHER: PathAccess = { org_path: false, groups_path: false };
const perDataset = <T>(sales: T, finance: T, marketing: T, retail: T) => ({
  [SALES]: sales,
  [FINANCE]: finance,
  [MARKETING]: marketing,
  [RETAIL]: retail,
});

/**
 * Per principal and dataset, whether a query on each path succeeds. People
 * are keyed by email, the app's service principal by its app id. Campaign
 * archive has no schema to query, so it is left out.
 */
export const EXPECTED_QUERY_ACCESS: Record<
  string,
  Record<string, PathAccess>
> = {
  "admin@sample.example": perDataset(BOTH, BOTH, BOTH, BOTH),
  "analyst@sample.example": perDataset(BOTH, NEITHER, ORG_ONLY, BOTH),
  "viewer@sample.example": perDataset(ORG_ONLY, NEITHER, NEITHER, ORG_ONLY),
  "leader@sample.example": perDataset(NEITHER, ORG_ONLY, NEITHER, NEITHER),
  "outsider@sample.example": perDataset(NEITHER, NEITHER, NEITHER, NEITHER),
  "revoked@sample.example": perDataset(BOTH, NEITHER, NEITHER, BOTH),
  "app-reader@sample.example": perDataset(NEITHER, NEITHER, NEITHER, NEITHER),
  "sales-viewer@sample.example": perDataset(NEITHER, NEITHER, NEITHER, NEITHER),
  "c1000000-0000-4000-8000-000000000002": perDataset(
    NEITHER,
    NEITHER,
    BOTH,
    NEITHER,
  ),
};

/**
 * What `EVALUATE INFO.VIEW.MEASURES()` on the org path gives: `with_dax`
 * for a caller with write permission (an Admin, Member or Contributor
 * workspace role), `names_only` (null [Expression]) for one who may query
 * without it, `refused` when the query is refused or the dataset refuses
 * INFO views (Marketing, to everyone).
 */
export type MeasureDax = "with_dax" | "names_only" | "refused";
const DAX: MeasureDax = "with_dax";
const NAMES: MeasureDax = "names_only";
const NO: MeasureDax = "refused";

/** Per principal and dataset, keyed as EXPECTED_QUERY_ACCESS is. */
export const EXPECTED_MEASURE_DAX: Record<
  string,
  Record<string, MeasureDax>
> = {
  "admin@sample.example": perDataset(DAX, DAX, NO, DAX),
  "analyst@sample.example": perDataset(DAX, NO, NO, DAX),
  "viewer@sample.example": perDataset(NAMES, NO, NO, NAMES),
  "leader@sample.example": perDataset(NO, NAMES, NO, NO),
  "outsider@sample.example": perDataset(NO, NO, NO, NO),
  "revoked@sample.example": perDataset(DAX, NO, NO, DAX),
  "app-reader@sample.example": perDataset(NO, NO, NO, NO),
  "sales-viewer@sample.example": perDataset(NO, NO, NO, NO),
  "c1000000-0000-4000-8000-000000000002": perDataset(NO, NO, NO, NO),
};
