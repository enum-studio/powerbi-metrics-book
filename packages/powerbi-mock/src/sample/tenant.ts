/**
 * The sample tenant: the stack's test bed and its demo. Every person, group,
 * workspace, app, dataset, measure and number in it is invented sample data.
 * `README.md` beside this file lists who reaches what and why each odd
 * measure is here; `expected.ts` holds what tests assert against it.
 */
import {
  type AccessEntry,
  type Column,
  type Dataset,
  type Measure,
  type Person,
  type Relationship,
  type Table,
  type Tenant,
  type Workspace,
  defaultTenantSettings,
} from "../tenant.js";
import {
  brandRows,
  budgetRows,
  categoryRows,
  currencyRows,
  exchangeRateRows,
  monthRows,
  orderLineRows,
  regionRows,
  retailCustomerRows,
  retailDateRows,
  retailNetSales,
  retailProductRows,
  returnReasonRows,
  returnRows,
  stockRows,
  storeRows,
} from "./retail-rows.js";
import {
  CHANNELS,
  adSpendRows,
  customerRows,
  dateRows,
  netSalesByMonth,
  ordersByChannel,
  productRows,
  salesRows,
  webSessionRows,
} from "./rows.js";

export const SAMPLE_TENANT_ID = "11111111-1111-4111-8111-111111111111";

/** DAX the mock answers from recorded rows: the questions the end-to-end test and the evals ask. */
export const SAMPLE_QUERIES = {
  net_sales_by_month_2025: [
    "EVALUATE",
    "SUMMARIZECOLUMNS(",
    "    'Date'[Month],",
    "    TREATAS({2025}, 'Date'[Year]),",
    '    "Net sales", [Net sales]',
    ")",
    "ORDER BY 'Date'[Month]",
  ].join("\n"),
  orders_by_channel: [
    "EVALUATE",
    "SUMMARIZECOLUMNS('Channel'[Channel], \"Orders\", [Orders])",
    "ORDER BY 'Channel'[Channel]",
  ].join("\n"),
  retail_net_sales: 'EVALUATE ROW("Net sales", [Net sales])',
};

/** The api's own default address: where the app registration's callbacks point unless told otherwise. */
export const SAMPLE_PUBLIC_BASE_URL = "http://localhost:3000";

export const SAMPLE_IDS = {
  people: {
    admin: "a0000000-0000-4000-8000-000000000001",
    analyst: "a0000000-0000-4000-8000-000000000002",
    viewer: "a0000000-0000-4000-8000-000000000003",
    leader: "a0000000-0000-4000-8000-000000000004",
    outsider: "a0000000-0000-4000-8000-000000000005",
    revoked: "a0000000-0000-4000-8000-000000000006",
    app_reader: "a0000000-0000-4000-8000-000000000007",
    sales_viewer: "a0000000-0000-4000-8000-000000000008",
  },
  groups: {
    analysts: "b0000000-0000-4000-8000-000000000001",
    leadership: "b0000000-0000-4000-8000-000000000002",
    directors: "b0000000-0000-4000-8000-000000000003",
  },
  /** The scanner reads the admin APIs; the app signs people in and runs service-account queries. */
  scanner: {
    app_id: "c1000000-0000-4000-8000-000000000001",
    object_id: "c2000000-0000-4000-8000-000000000001",
  },
  app: {
    app_id: "c1000000-0000-4000-8000-000000000002",
    object_id: "c2000000-0000-4000-8000-000000000002",
  },
  workspaces: {
    sales: "d0000000-0000-4000-8000-000000000001",
    finance: "d0000000-0000-4000-8000-000000000002",
    marketing: "d0000000-0000-4000-8000-000000000003",
    personal: "d0000000-0000-4000-8000-000000000004",
  },
  datasets: {
    sales: "d1000000-0000-4000-8000-000000000001",
    finance: "d1000000-0000-4000-8000-000000000002",
    marketing: "d1000000-0000-4000-8000-000000000003",
    campaign_archive: "d1000000-0000-4000-8000-000000000004",
    retail: "d1000000-0000-4000-8000-000000000005",
  },
  apps: {
    sales: "e0000000-0000-4000-8000-000000000001",
    leadership: "e0000000-0000-4000-8000-000000000002",
  },
  reports: {
    sales: "e1000000-0000-4000-8000-000000000001",
    leadership: "e1000000-0000-4000-8000-000000000002",
    marketing: "e1000000-0000-4000-8000-000000000003",
    retail: "e1000000-0000-4000-8000-000000000004",
  },
} as const;

const ids = SAMPLE_IDS;
const ADMIN_EMAIL = "admin@sample.example";
const PUBLISHED = "2026-10-01T08:00:00Z";

function person(
  object_id: string,
  mailbox: string,
  role: string,
  group_ids: string[],
  revoked = false,
): Person {
  const email = `${mailbox}@sample.example`;
  return {
    object_id,
    email,
    user_principal_name: email,
    name: role,
    group_ids,
    revoked,
  };
}

const user = (id: string, mailbox: string, right: string): AccessEntry => ({
  principal_type: "User",
  object_id: id,
  email: `${mailbox}@sample.example`,
  access_right: right,
});
const group = (id: string, right: string): AccessEntry => ({
  principal_type: "Group",
  object_id: id,
  access_right: right,
});
const admin = user(ids.people.admin, "admin", "Admin");

function workspace(
  id: string,
  name: string,
  users: AccessEntry[],
  dataset_ids: string[],
  report_ids: string[],
  type = "Workspace",
): Workspace {
  return { id, name, type, state: "Active", users, dataset_ids, report_ids };
}

/**
 * Fresh on every call and the same for the same options, so a test may patch
 * its own copy. `public_base_url` is the api's PUBLIC_BASE_URL: the mock
 * accepts only the redirect URIs registered here, exactly.
 */
export function sampleTenant(
  options: { public_base_url?: string } = {},
): Tenant {
  const { public_base_url = SAMPLE_PUBLIC_BASE_URL } = options;
  const { people, groups, workspaces, datasets, apps, reports } = ids;
  return {
    tenant_id: SAMPLE_TENANT_ID,
    people: [
      person(people.admin, "admin", "Admin", []),
      person(people.analyst, "analyst", "Analyst", [groups.analysts]),
      person(people.viewer, "viewer", "Viewer", []),
      // Directors is a member of Leadership; Graph's transitive list names both.
      person(people.leader, "leader", "Leader", [
        groups.directors,
        groups.leadership,
      ]),
      person(people.outsider, "outsider", "Outsider", []),
      person(
        people.revoked,
        "revoked",
        "Revoked analyst",
        [groups.analysts],
        true,
      ),
      person(people.app_reader, "app-reader", "App reader", []),
      person(people.sales_viewer, "sales-viewer", "Sales viewer", []),
    ],
    groups: [
      { object_id: groups.analysts, name: "Analysts" },
      { object_id: groups.leadership, name: "Leadership" },
      { object_id: groups.directors, name: "Directors" },
    ],
    service_principals: [
      {
        ...ids.scanner,
        secret: "sample-scanner-secret",
        may_call_admin_apis: true,
      },
      { ...ids.app, secret: "sample-app-secret", may_call_admin_apis: false },
    ],
    apps_registrations: [
      {
        client_id: ids.app.app_id,
        secret: "sample-app-secret",
        // The spec's app registration: sign-in, then the Power BI connection.
        redirect_uris: [
          `${public_base_url}/api/auth/callback/microsoft`,
          `${public_base_url}/api/v1/powerbi/callback`,
        ],
        kind: "confidential_web",
      },
    ],
    settings: defaultTenantSettings(),
    workspaces: [
      workspace(
        workspaces.sales,
        "Sales",
        [
          admin,
          group(groups.analysts, "Member"),
          // A Viewer holds no Build: sees the dataset, may not query it.
          user(people.sales_viewer, "sales-viewer", "Viewer"),
        ],
        [datasets.sales, datasets.retail],
        [reports.sales, reports.retail],
      ),
      workspace(
        workspaces.finance,
        "Finance",
        [admin],
        [datasets.finance],
        [reports.leadership],
      ),
      workspace(
        workspaces.marketing,
        "Marketing",
        [
          admin,
          {
            principal_type: "App",
            object_id: ids.app.object_id,
            access_right: "Member",
          },
        ],
        [datasets.marketing, datasets.campaign_archive],
        [reports.marketing],
      ),
      {
        ...workspace(
          workspaces.personal,
          "My workspace (Analyst)",
          [user(people.analyst, "analyst", "Admin")],
          [],
          [],
          "PersonalGroup",
        ),
        // The scanner answers some workspaces, personal ones among them, with users: null.
        users_unlisted: true,
      },
    ],
    apps: [
      {
        id: apps.sales,
        name: "Sales app",
        description:
          "The sales overview, for people outside the Sales workspace.",
        workspace_id: workspaces.sales,
        published_by: ADMIN_EMAIL,
        last_update: PUBLISHED,
        // Explore is the publisher's "allow building content": Build on the
        // app's datasets. Read alone shows the reports and refuses queries.
        users: [
          user(people.viewer, "viewer", "ReadExplore"),
          user(people.app_reader, "app-reader", "Read"),
        ],
        report_ids: [reports.sales, reports.retail],
      },
      {
        id: apps.leadership,
        name: "Leadership app",
        description: "Revenue, margin and targets for the leadership group.",
        workspace_id: workspaces.finance,
        published_by: ADMIN_EMAIL,
        last_update: PUBLISHED,
        users: [group(groups.leadership, "ReadExplore")],
        report_ids: [reports.leadership],
      },
    ],
    reports: [
      {
        id: reports.sales,
        name: "Sales overview",
        dataset_id: datasets.sales,
        app_id: apps.sales,
      },
      {
        id: reports.leadership,
        name: "Leadership overview",
        dataset_id: datasets.finance,
        app_id: apps.leadership,
      },
      {
        id: reports.marketing,
        name: "Marketing overview",
        dataset_id: datasets.marketing,
        app_id: null,
      },
      {
        id: reports.retail,
        name: "Retail overview",
        dataset_id: datasets.retail,
        app_id: apps.sales,
      },
    ],
    datasets: [
      dataset(datasets.sales, workspaces.sales, "Sales", {
        description: "Invented orders, products and customers.",
        ...salesModel(),
      }),
      dataset(datasets.finance, workspaces.finance, "Finance", {
        description: "Invented revenue, margin and targets.",
        has_row_level_security: true,
        ...financeModel(),
      }),
      dataset(datasets.marketing, workspaces.marketing, "Marketing", {
        description: "Invented ad spend and web sessions.",
        refuses_info_views: true,
        // The direct-share path: Build without workspace membership.
        users: [user(people.analyst, "analyst", "ReadExplore")],
        ...marketingModel(),
      }),
      dataset(
        datasets.campaign_archive,
        workspaces.marketing,
        "Campaign archive",
        {
          description: "Invented campaigns of earlier years.",
          storage_mode: "DirectQuery",
          schema_retrieval_error:
            "The model has never been refreshed, so its schema could not be read.",
        },
      ),
      dataset(datasets.retail, workspaces.sales, "Retail", {
        description: "Invented order lines, returns, stock and budget.",
        has_row_level_security: true,
        ...retailModel(),
      }),
    ],
  };
}

function dataset(
  id: string,
  workspace_id: string,
  name: string,
  rest: Partial<Dataset>,
): Dataset {
  return {
    id,
    workspace_id,
    name,
    description: null,
    configured_by: ADMIN_EMAIL,
    storage_mode: "Import",
    has_row_level_security: false,
    schema_retrieval_error: null,
    tables: [],
    relationships: [],
    users: [],
    recorded_queries: [],
    ...rest,
  };
}

function column(
  name: string,
  data_type: string,
  options: {
    hidden?: boolean;
    description?: string;
    expression?: string;
    folder?: string;
  } = {},
): Column {
  const { hidden = false, description = null, expression } = options;
  // Only a calculated column carries the key, as only it has DAX.
  const calculated = expression === undefined ? {} : { expression };
  return {
    name,
    data_type,
    description,
    hidden,
    display_folder: options.folder ?? null,
    ...calculated,
  };
}

type MeasureOptions = {
  format?: string;
  folder?: string;
  description?: string;
  hidden?: boolean;
};

function measure(
  name: string,
  expression: string,
  options: MeasureOptions = {},
): Measure {
  return {
    name,
    expression,
    description: options.description ?? null,
    format_string: options.format ?? null,
    hidden: options.hidden ?? false,
    display_folder: options.folder ?? null,
  };
}

/** Measures sharing a format string and a display folder, as models tend to keep them. */
function measures(
  options: MeasureOptions,
  list: [name: string, dax: string][],
): Measure[] {
  return list.map(([name, dax]) => measure(name, dax, options));
}

function table(
  name: string,
  description: string | null,
  columns: Column[],
  tableMeasures: Measure[],
  rows: Record<string, unknown>[],
): Table {
  return {
    name,
    description,
    hidden: false,
    columns,
    measures: tableMeasures,
    rows,
  };
}

/** Many to one, filtering one way, active, unless the options say otherwise. */
function relationship(
  [from_table, from_column]: [table: string, column: string],
  [to_table, to_column]: [table: string, column: string],
  options: Partial<Relationship> = {},
): Relationship {
  return {
    from_table,
    from_column,
    to_table,
    to_column,
    from_cardinality: "Many",
    to_cardinality: "One",
    cross_filtering_behavior: "OneDirection",
    is_active: true,
    ...options,
  };
}

// The same import in every dataset that holds it; each dataset adds its own measures.
function salesTable(salesMeasures: Measure[]): Table {
  return table(
    "Sales",
    "One row per order line.",
    [
      column("Order id", "Int64"),
      column("Order line", "Int64"),
      column("Date", "DateTime", {
        description: "The day the order was placed.",
      }),
      column("Ship date", "DateTime"),
      column("Product key", "Int64", { hidden: true }),
      column("Customer key", "Int64", { hidden: true }),
      column("Channel key", "Int64", { hidden: true }),
      column("Quantity", "Int64"),
      column("Gross amount", "Decimal"),
      column("Discount amount", "Decimal"),
      column("Net amount", "Decimal", {
        description: "Gross amount less discounts, before returns, in EUR.",
      }),
      column("Cost amount", "Decimal"),
      column("Is returned", "Boolean"),
    ],
    salesMeasures,
    salesRows(),
  );
}

function dateTable(): Table {
  const columns = [
    column("Date", "DateTime"),
    column("Year", "Int64", { folder: "Dates\\Fiscal" }),
    column("Quarter", "String", { folder: "Dates\\Fiscal" }),
    column("Month", "String", { folder: "Dates" }),
    column("Month name", "String"),
    column("Is weekend", "Boolean"),
    // The same day a period back, in weeks, as a retail calendar holds it.
    column("Date last year", "DateTime"),
    column("Date last month", "DateTime"),
    column("Date last week", "DateTime"),
  ];
  // A calculated table, as most models build their calendar.
  const source_expression = [
    "ADDCOLUMNS(",
    "    CALENDAR(DATE(2024, 1, 1), DATE(2026, 12, 31)),",
    '    "Year", YEAR([Date]),',
    '    "Quarter", YEAR([Date]) & " Q" & QUARTER([Date]),',
    '    "Month", FORMAT([Date], "yyyy-mm"),',
    '    "Month name", FORMAT([Date], "mmmm"),',
    '    "Is weekend", WEEKDAY([Date], 2) > 5,',
    '    "Date last year", [Date] - 364,',
    '    "Date last month", [Date] - 28,',
    '    "Date last week", [Date] - 7',
    ")",
  ].join("\n");
  const rows = dateRows();
  return {
    ...table("Date", "One row per day, 2024 to 2026.", columns, [], rows),
    source_expression,
  };
}

function channelTable(): Table {
  const columns = [
    column("Channel key", "Int64", { hidden: true }),
    column("Channel", "String"),
  ];
  return table(
    "Channel",
    null,
    columns,
    [],
    CHANNELS.map((row) => ({ ...row })),
  );
}

const TIME = "Time intelligence";
const COMPARE = "Comparisons";
const HELPERS = "Helpers";
const MONEY = "#,0.00";
const WHOLE = "#,0";
const PERCENT = "0.0%";
const DATE = "'Date'[Date]";
/** A filter to the dates a calendar column holds, as `DATESBETWEEN` reads it. */
const datesIn = (column: string) =>
  `DATESBETWEEN(${DATE}, MIN('Date'[${column}]), MAX('Date'[${column}]))`;
const RATE = "'Exchange rate'";

function salesModel(): Pick<
  Dataset,
  "tables" | "relationships" | "recorded_queries"
> {
  const sales = salesRows();
  const productColumns = [
    column("Product key", "Int64", { hidden: true }),
    column("Product", "String"),
    column("Category", "String", { folder: "Attributes" }),
    column("List price", "Decimal", { folder: "Attributes" }),
    column("Weight (kg)", "Double"),
    column("Image", "Binary", { hidden: true }),
  ];
  const customerColumns = [
    column("Customer key", "Int64", { hidden: true }),
    column("Customer", "String"),
    column("Region", "String", { folder: "Geography" }),
    column("Segment", "String"),
  ];
  return {
    tables: [
      salesTable(salesMeasures()),
      table("Product", null, productColumns, [], productRows()),
      table("Customer", null, customerColumns, [], customerRows()),
      dateTable(),
      channelTable(),
    ],
    relationships: [
      relationship(["Sales", "Date"], ["Date", "Date"]),
      // Ship date is read through USERELATIONSHIP, as models with two dates do.
      relationship(["Sales", "Ship date"], ["Date", "Date"], {
        is_active: false,
      }),
      relationship(["Sales", "Product key"], ["Product", "Product key"]),
      relationship(["Sales", "Customer key"], ["Customer", "Customer key"]),
      relationship(["Sales", "Channel key"], ["Channel", "Channel key"]),
    ],
    recorded_queries: [
      {
        dax: SAMPLE_QUERIES.net_sales_by_month_2025,
        rows: netSalesByMonth(sales, 2025),
      },
      { dax: SAMPLE_QUERIES.orders_by_channel, rows: ordersByChannel(sales) },
    ],
  };
}

/**
 * One calculation written the long way, as big models tend to: variables,
 * brackets, calendar columns, zero for a blank and a slicer. Most of them are
 * a variant all the same; the near misses at the end are not.
 */
function orderLinesMeasures(): Measure[] {
  return [
    measure("Order lines", "VAR Result = COUNTROWS(Sales) RETURN Result", {
      format: WHOLE,
    }),
    ...measures({ format: WHOLE, folder: TIME }, [
      [
        "Order lines LM",
        `VAR Low = MIN('Date'[Date last month])
VAR High = MAX('Date'[Date last month])
VAR Shifted = CALCULATE([Order lines], REMOVEFILTERS('Date'), DATESBETWEEN(${DATE}, Low, High))
RETURN Shifted`,
      ],
      [
        "Order lines LW",
        `COALESCE(CALCULATE([Order lines], DATEADD(${DATE}, -7, DAY), ${datesIn("Date last week")}), 0)`,
      ],
      [
        "Order lines LY",
        `IF(SELECTEDVALUE(Channel[Channel], "Web") = "Web", CALCULATE([Order lines], SAMEPERIODLASTYEAR(${DATE})), CALCULATE([Order lines], DATEADD(${DATE}, -1, YEAR)))`,
      ],
      // A second previous year, which the one above holds the place of.
      [
        "Order lines LY zero",
        `COALESCE(CALCULATE([Order lines], SAMEPERIODLASTYEAR(${DATE})), 0)`,
      ],
      // The calendar column says a month back and the name says a quarter.
      [
        "Order lines LQ",
        `CALCULATE([Order lines], REMOVEFILTERS('Date'), ${datesIn("Date last month")})`,
      ],
      // A near miss: the calendar shift with one more filter.
      [
        "Web order lines LM",
        `CALCULATE([Order lines], REMOVEFILTERS('Date'), ${datesIn("Date last month")}, Channel[Channel] = "Web")`,
      ],
      // Looks like a shift and is not: the variable holds this period's value before the filter applies.
      [
        "Order lines held",
        `VAR Lines = [Order lines] RETURN CALCULATE(Lines, SAMEPERIODLASTYEAR(${DATE}))`,
      ],
    ]),
    ...measures({ format: PERCENT, folder: COMPARE }, [
      [
        "Order lines MoM",
        `VAR Now = [Order lines]
VAR Before = [Order lines LM]
VAR Change = Now - Before
VAR Growth = DIVIDE(Change, Before)
RETURN Growth`,
      ],
      [
        "Order lines WoW",
        "COALESCE(DIVIDE([Order lines] - [Order lines LW], [Order lines LW]), 0)",
      ],
      [
        "Order lines YoY",
        "DIVIDE( ( [Order lines] - [Order lines LY] ), [Order lines LY] )",
      ],
    ]),
  ];
}

function salesMeasures(): Measure[] {
  return [
    ...orderLinesMeasures(),
    measure("Net sales", "SUM(Sales[Net amount])", {
      format: MONEY,
      description: "Net amount of the order lines, before returns.",
    }),
    measure("Orders", "DISTINCTCOUNT(Sales[Order id])", { format: WHOLE }),
    measure("Units sold", "SUM(Sales[Quantity])", { format: WHOLE }),
    measure("Average order value", "DIVIDE([Net sales], [Orders])", {
      format: MONEY,
    }),
    // A near miss: both a previous year, by filters that cover other dates.
    measure("Average order value LY", "DIVIDE([Net sales LY], [Orders PY])", {
      format: MONEY,
      folder: TIME,
    }),
    measure("Units per order", "DIVIDE([Units sold], [Orders], 0)", {
      format: "0.00",
    }),
    measure("Units per order PM", "DIVIDE([Units sold PM], [Orders PM], 0)", {
      format: "0.00",
      folder: TIME,
    }),
    measure(
      "Return rate",
      "DIVIDE(CALCULATE(COUNTROWS(Sales), Sales[Is returned] = TRUE()), COUNTROWS(Sales))",
      { format: PERCENT },
    ),
    ...measures({ format: MONEY, folder: TIME }, [
      ["Net sales LY", `CALCULATE([Net sales], SAMEPERIODLASTYEAR(${DATE}))`],
      ["Net sales YTD", `TOTALYTD([Net sales], ${DATE})`],
      ["Net sales QTD", `TOTALQTD([Net sales], ${DATE})`],
      ["Net sales MTD", `TOTALMTD([Net sales], ${DATE})`],
      [
        "Net sales LY YTD",
        `CALCULATE([Net sales YTD], SAMEPERIODLASTYEAR(${DATE}))`,
      ],
      // A near miss: the previous-year pattern with one more filter.
      [
        "Web net sales LY",
        `CALCULATE([Net sales], SAMEPERIODLASTYEAR(${DATE}), 'Channel'[Channel] = "Web")`,
      ],
    ]),
    ...measures({ format: WHOLE, folder: TIME }, [
      ["Orders PY", `CALCULATE([Orders], PARALLELPERIOD(${DATE}, -12, MONTH))`],
      ["Orders PM", `CALCULATE([Orders], DATEADD(${DATE}, -1, MONTH))`],
      [
        "Units sold LY",
        `CALCULATE([Units sold], PARALLELPERIOD(${DATE}, -1, YEAR))`,
      ],
      ["Units sold PM", `CALCULATE([Units sold], DATEADD(${DATE}, -1, MONTH))`],
    ]),
    measure("Net sales vs LY", "[Net sales] - [Net sales LY]", {
      format: MONEY,
      folder: COMPARE,
    }),
    ...measures({ format: PERCENT, folder: COMPARE }, [
      [
        "Net sales growth",
        "DIVIDE([Net sales] - [Net sales LY], [Net sales LY])",
      ],
      ["Orders YoY %", "DIVIDE([Orders], [Orders PY]) - 1"],
    ]),
    measure("Orders index vs PY", "DIVIDE([Orders], [Orders PY])", {
      format: "0.00",
      folder: COMPARE,
    }),
    measure(
      "_Report title",
      `"Net sales, " & FORMAT(MIN(${DATE}), "mmm yyyy") & " to " & FORMAT(MAX(${DATE}), "mmm yyyy")`,
      { folder: HELPERS },
    ),
  ];
}

function financeModel(): Pick<Dataset, "tables" | "relationships"> {
  const rates = [
    { Currency: "EUR", Rate: 1 },
    { Currency: "USD", Rate: 1.08 },
    { Currency: "GBP", Rate: 0.86 },
    { Currency: "SEK", Rate: 11.2 },
  ];
  const selectedCurrency = [
    `VAR selected_currency = SELECTEDVALUE(${RATE}[Currency], "EUR")`,
    `VAR rate = LOOKUPVALUE(${RATE}[Rate], ${RATE}[Currency], selected_currency)`,
    "RETURN [Revenue] * rate",
  ].join("\n");
  const rateMeasures = [
    measure(
      "Revenue USD",
      `SUMX(Sales, Sales[Net amount] * LOOKUPVALUE(${RATE}[Rate], ${RATE}[Currency], "USD"))`,
      { format: WHOLE, folder: "Currency" },
    ),
    measure("Revenue in selected currency", selectedCurrency, {
      format: WHOLE,
      folder: "Currency",
      description:
        "Revenue in the currency picked on the page; euros when none is.",
    }),
    measure(
      "_Currency format",
      `"#,0.00 " & SELECTEDVALUE(${RATE}[Currency], "EUR")`,
      {
        folder: HELPERS,
        hidden: true,
      },
    ),
  ];
  return {
    tables: [
      salesTable([
        ...measures({ format: WHOLE }, [
          ["Revenue", "SUM('Sales'[Net amount])"],
          ["Order count", "COUNTROWS(DISTINCT(Sales[Order id]))"],
          ["Gross margin", "SUM(Sales[Net amount]) - SUM(Sales[Cost amount])"],
        ]),
        measure("Gross margin %", "DIVIDE([Gross margin], [Revenue])", {
          format: PERCENT,
        }),
        ...measures({ format: WHOLE, folder: TIME }, [
          ["Revenue PY", `CALCULATE([Revenue], DATEADD(${DATE}, -1, YEAR))`],
          ["Revenue PQ", `CALCULATE([Revenue], DATEADD(${DATE}, -1, QUARTER))`],
          ["Revenue YTD", `CALCULATE([Revenue], DATESYTD(${DATE}))`],
          [
            "Revenue PY YTD",
            `CALCULATE([Revenue], DATESYTD(SAMEPERIODLASTYEAR(${DATE})))`,
          ],
          ["Gross margin QTD", `CALCULATE([Gross margin], DATESQTD(${DATE}))`],
          ["Gross margin MTD", `CALCULATE([Gross margin], DATESMTD(${DATE}))`],
          [
            "Gross margin PY",
            `CALCULATE([Gross margin], DATEADD(${DATE}, -1, YEAR))`,
          ],
          [
            "Gross margin PQ",
            `CALCULATE([Gross margin], DATEADD(${DATE}, -1, QUARTER))`,
          ],
        ]),
        ...measures({ format: PERCENT, folder: TIME }, [
          // Shifts composed of two measures shifted by one filter.
          ["Gross margin % PY", "DIVIDE([Gross margin PY], [Revenue PY])"],
          ["Gross margin % PQ", "DIVIDE([Gross margin PQ], [Revenue PQ], 0)"],
          // Near misses: only one side shifted, and an operator the base does not have.
          [
            "Gross margin % on PY margin",
            "DIVIDE([Gross margin PY], [Revenue])",
          ],
          [
            "Gross margin points PY",
            "DIVIDE([Gross margin PY], [Revenue PY]) * 100",
          ],
        ]),
        measure(
          "Gross margin % vs PY",
          "[Gross margin %] - [Gross margin % PY]",
          { format: PERCENT, folder: COMPARE },
        ),
        // A reference cycle: Power BI itself refuses to evaluate these.
        ...measures({ format: WHOLE, folder: "Targets" }, [
          ["Target", "[Stretch target] * 0.9"],
          ["Stretch target", "[Target gap] + [Revenue]"],
          ["Target gap", "[Target] - [Revenue]"],
        ]),
      ]),
      dateTable(),
      table(
        "Exchange rate",
        "Units of each currency for one euro. Also the currency slicer.",
        [column("Currency", "String"), column("Rate", "Double")],
        rateMeasures,
        rates,
      ),
    ],
    // The rate table stays disconnected: LOOKUPVALUE and the slicer read it.
    relationships: [relationship(["Sales", "Date"], ["Date", "Date"])],
  };
}

function marketingModel(): Pick<
  Dataset,
  "tables" | "relationships" | "recorded_queries"
> {
  const adSpendColumns = [
    column("Week start", "DateTime"),
    column("Channel key", "Int64", { hidden: true }),
    column("Campaign", "String"),
    column("Spend", "Decimal"),
    column("Clicks", "Int64"),
    column("Impressions", "Int64"),
  ];
  const sessionColumns = [
    column("Date", "DateTime"),
    column("Device", "String"),
    column("Session count", "Int64"),
    column("Bounced sessions", "Int64"),
    column("Bounce rate", "Double", {
      expression:
        "DIVIDE('Web sessions'[Bounced sessions], 'Web sessions'[Session count])",
    }),
  ];
  return {
    tables: [
      salesTable([
        // The same calculation as Sales' Net sales, spelled another way.
        measure(
          "Net Sales",
          "-- Net of discounts, before returns\nSUM ( 'Sales'[Net Amount] )",
          {
            format: WHOLE,
          },
        ),
        measure("Orders", "DISTINCTCOUNT('Sales'[Order ID])", {
          format: WHOLE,
        }),
        measure("Order lines", "COUNTROWS(Sales)", { format: WHOLE }),
        measure("Conversion rate", "DIVIDE([Orders], [Sessions])", {
          format: "0.00%",
        }),
      ]),
      table(
        "Ad spend",
        "Weekly spend per paid channel.",
        adSpendColumns,
        [
          measure("Ad spend", "SUM('Ad spend'[Spend])", { format: WHOLE }),
          measure(
            "Ad spend LY",
            `CALCULATE([Ad spend], DATEADD(${DATE}, -365, DAY))`,
            {
              format: WHOLE,
              folder: TIME,
            },
          ),
          measure(
            "Cost per click",
            "DIVIDE([Ad spend], SUM('Ad spend'[Clicks]))",
            { format: MONEY },
          ),
          measure("Return on ad spend", "DIVIDE([Net Sales], [Ad spend])", {
            format: "0.00",
          }),
        ],
        adSpendRows(),
      ),
      table(
        "Web sessions",
        "Daily sessions per device.",
        sessionColumns,
        [
          measure("Sessions", "SUM('Web sessions'[Session count])", {
            format: WHOLE,
          }),
          measure(
            "Sessions yesterday",
            `CALCULATE([Sessions], DATEADD(${DATE}, -1, DAY))`,
            {
              format: WHOLE,
              folder: TIME,
            },
          ),
        ],
        webSessionRows(),
      ),
      dateTable(),
      channelTable(),
    ],
    relationships: [
      relationship(["Sales", "Date"], ["Date", "Date"]),
      relationship(["Sales", "Channel key"], ["Channel", "Channel key"]),
      relationship(["Ad spend", "Week start"], ["Date", "Date"]),
      relationship(["Ad spend", "Channel key"], ["Channel", "Channel key"], {
        cross_filtering_behavior: "BothDirections",
      }),
      relationship(["Web sessions", "Date"], ["Date", "Date"]),
    ],
    // The app's service principal reaches this dataset only, so its question is recorded here too.
    recorded_queries: [
      {
        dax: SAMPLE_QUERIES.orders_by_channel,
        rows: ordersByChannel(salesRows()),
      },
    ],
  };
}

function retailModel(): Pick<
  Dataset,
  "tables" | "relationships" | "recorded_queries"
> {
  const lines = orderLineRows();
  const keyed = (name: string) => column(name, "Int64", { hidden: true });
  const text = (...names: string[]) => names.map((n) => column(n, "String"));
  const orderLineMeasures = [
    ...measures({ format: MONEY }, [
      ["Net sales", "SUM('Order lines'[Net amount])"],
      ["Gross sales", "SUM('Order lines'[Gross amount])"],
    ]),
    measure("Orders", "DISTINCTCOUNT('Order lines'[Order id])", {
      format: WHOLE,
    }),
    measure("Units", "SUM('Order lines'[Quantity])", { format: WHOLE }),
    measure("Order lines", "COUNTROWS('Order lines')", { format: WHOLE }),
    measure(
      "Average order value",
      "DIVIDE([Net sales], DISTINCTCOUNT('Order lines'[Order id]))",
      { format: MONEY },
    ),
    measure(
      "Gross margin",
      "SUM('Order lines'[Net amount]) - SUM('Order lines'[Cost])",
      { format: MONEY },
    ),
    measure("Gross margin %", "DIVIDE([Gross margin], [Net sales])", {
      format: PERCENT,
    }),
    ...measures({ format: MONEY, folder: TIME }, [
      ["Net sales LY", `CALCULATE([Net sales], SAMEPERIODLASTYEAR(${DATE}))`],
      ["Net sales YTD", `TOTALYTD([Net sales], ${DATE})`],
      ["Net sales MTD", `TOTALMTD([Net sales], ${DATE})`],
    ]),
    measure("Orders LY", `CALCULATE([Orders], SAMEPERIODLASTYEAR(${DATE}))`, {
      format: WHOLE,
      folder: TIME,
    }),
  ];
  return {
    tables: [
      table(
        "Order lines",
        "One row per order line.",
        [
          column("Order id", "Int64"),
          column("Line", "Int64"),
          column("Order date", "DateTime"),
          column("Ship date", "DateTime"),
          keyed("Product key"),
          keyed("Customer key"),
          keyed("Store key"),
          column("Currency code", "String", { hidden: true }),
          column("Quantity", "Int64"),
          column("Gross amount", "Decimal"),
          column("Discount", "Decimal"),
          column("Net amount", "Decimal"),
          column("Net amount EUR", "Decimal"),
          column("Cost", "Decimal"),
          column("Tax", "Decimal"),
          column("Is first order", "Boolean"),
          ...text("Voucher code", "Device"),
        ],
        orderLineMeasures,
        lines,
      ),
      table(
        "Returns",
        null,
        [
          column("Return id", "Int64"),
          column("Return date", "DateTime"),
          keyed("Product key"),
          keyed("Reason key"),
          column("Units", "Int64"),
          column("Refund amount", "Decimal"),
        ],
        [
          measure("Returned units", "SUM(Returns[Units])", { format: WHOLE }),
          measure("Refunds", "SUM(Returns[Refund amount])", { format: MONEY }),
          measure("Return rate", "DIVIDE([Returned units], [Units])", {
            format: PERCENT,
          }),
        ],
        returnRows(),
      ),
      table(
        "Stock",
        null,
        [
          column("Snapshot date", "DateTime"),
          keyed("Product key"),
          keyed("Store key"),
          column("Units in stock", "Int64"),
          column("Value", "Decimal"),
        ],
        [
          measure("Units on hand", "SUM(Stock[Units in stock])", {
            format: WHOLE,
          }),
          measure("Stock value", "SUM(Stock[Value])", { format: MONEY }),
          measure(
            "Weeks of cover",
            "DIVIDE([Units on hand], [Units in stock]) * 13",
            { format: "0.0" },
          ),
        ],
        stockRows(),
      ),
      table(
        "Budget",
        null,
        [
          column("Month", "String"),
          keyed("Store key"),
          column("Amount", "Decimal"),
        ],
        measures({ format: MONEY, folder: "Targets" }, [
          ["Budget", "SUM(Budget[Amount])"],
          ["Net sales vs budget", "[Net sales] - [Budget]"],
        ]),
        budgetRows(),
      ),
      table(
        "Date",
        "One row per day of the first quarter of 2026.",
        [
          column("Date", "DateTime"),
          column("Month", "String"),
          column("Year", "Int64"),
          column("Week", "Int64"),
          column("Weekday", "String"),
          column("Is holiday", "Boolean"),
        ],
        [],
        retailDateRows(),
      ),
      table(
        "Month",
        null,
        [...text("Month", "Month name", "Quarter"), column("Year", "Int64")],
        [],
        monthRows(),
      ),
      table(
        "Product",
        null,
        [
          keyed("Product key"),
          keyed("Brand key"),
          keyed("Category key"),
          ...text("SKU", "Product", "Colour", "Size"),
          column("List price", "Decimal"),
        ],
        [],
        retailProductRows(),
      ),
      table(
        "Brand",
        null,
        [
          keyed("Brand key"),
          ...text("Brand"),
          column("Is own brand", "Boolean"),
        ],
        [],
        brandRows(),
      ),
      table(
        "Category",
        null,
        [keyed("Category key"), ...text("Category", "Department")],
        [],
        categoryRows(),
      ),
      table(
        "Customer",
        null,
        [
          keyed("Customer key"),
          keyed("Region key"),
          ...text("Customer", "Email", "Phone", "Street address"),
          column("Date of birth", "DateTime"),
          ...text("Segment"),
          column("First order date", "DateTime"),
        ],
        [
          measure("Customers", "DISTINCTCOUNT(Customer[Customer key])", {
            format: WHOLE,
          }),
          measure(
            "New customers",
            "CALCULATE([Customers], 'Order lines'[Is first order] = TRUE())",
            { format: WHOLE },
          ),
        ],
        retailCustomerRows(),
      ),
      table(
        "Store",
        null,
        [
          keyed("Store key"),
          keyed("Region key"),
          ...text("Store", "Manager email", "Format"),
          column("Opened", "DateTime"),
        ],
        [],
        storeRows(),
      ),
      table(
        "Region",
        null,
        [keyed("Region key"), ...text("Region", "Country")],
        [],
        regionRows(),
      ),
      table(
        "Return reason",
        null,
        [keyed("Reason key"), ...text("Reason")],
        [],
        returnReasonRows(),
      ),
      table(
        "Currency",
        null,
        text("Currency code", "Currency"),
        [],
        currencyRows(),
      ),
      table(
        "Exchange rate",
        null,
        [column("Currency code", "String"), column("Rate", "Double")],
        [],
        exchangeRateRows(),
      ),
      table(
        "Measures",
        "Holds measures only.",
        [],
        [
          measure(
            "Selected currency",
            'SELECTEDVALUE(Currency[Currency], "EUR")',
            { folder: HELPERS },
          ),
          measure(
            "Report title",
            `"Retail net sales, " & FORMAT(MIN(${DATE}), "mmm yyyy") & " to " & FORMAT(MAX(${DATE}), "mmm yyyy")`,
            { folder: HELPERS },
          ),
        ],
        [],
      ),
    ],
    relationships: [
      relationship(["Order lines", "Order date"], ["Date", "Date"]),
      relationship(["Order lines", "Ship date"], ["Date", "Date"], {
        is_active: false,
      }),
      relationship(["Order lines", "Product key"], ["Product", "Product key"]),
      relationship(
        ["Order lines", "Customer key"],
        ["Customer", "Customer key"],
      ),
      relationship(["Order lines", "Store key"], ["Store", "Store key"]),
      relationship(
        ["Order lines", "Currency code"],
        ["Currency", "Currency code"],
      ),
      relationship(["Returns", "Return date"], ["Date", "Date"]),
      relationship(["Returns", "Product key"], ["Product", "Product key"]),
      relationship(["Returns", "Reason key"], ["Return reason", "Reason key"]),
      relationship(["Stock", "Snapshot date"], ["Date", "Date"]),
      relationship(["Stock", "Product key"], ["Product", "Product key"]),
      relationship(["Stock", "Store key"], ["Store", "Store key"]),
      relationship(["Budget", "Month"], ["Month", "Month"]),
      relationship(["Budget", "Store key"], ["Store", "Store key"]),
      relationship(["Date", "Month"], ["Month", "Month"]),
      relationship(["Product", "Brand key"], ["Brand", "Brand key"]),
      relationship(["Product", "Category key"], ["Category", "Category key"]),
      relationship(["Store", "Region key"], ["Region", "Region key"]),
      relationship(["Customer", "Region key"], ["Region", "Region key"], {
        is_active: false,
      }),
      relationship(
        ["Exchange rate", "Currency code"],
        ["Currency", "Currency code"],
        { cross_filtering_behavior: "BothDirections" },
      ),
    ],
    recorded_queries: [
      { dax: SAMPLE_QUERIES.retail_net_sales, rows: retailNetSales(lines) },
    ],
  };
}
