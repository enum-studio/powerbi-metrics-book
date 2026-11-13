import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADA,
  BEN,
  CLEO,
  DAN,
  DATASET_ID,
  EVE,
  FAY,
  GIL,
  MEMBER_APP_ID,
  RLS_DATASET_ID,
  SCANNER_APP_ID,
  WORKSPACE_ID,
  pastLimit,
  powerBiTenant,
  startPowerBi,
  table,
} from "./test-support.js";

type Mock = ReturnType<typeof startPowerBi>;
type Rows = Record<string, unknown>[];
type Answer = {
  results: { tables: { rows: Rows; error?: { message: string } }[] }[];
};

afterEach(() => {
  vi.useRealTimers();
});

function executeQueries(
  mock: Mock,
  token: string | null,
  query: string,
  options: { dataset?: string; group?: string; include_nulls?: boolean } = {},
) {
  const dataset = options.dataset ?? DATASET_ID;
  const path = options.group
    ? `groups/${options.group}/datasets/${dataset}/executeQueries`
    : `datasets/${dataset}/executeQueries`;
  return mock.call(path, token, {
    body: {
      queries: [{ query }],
      serializerSettings: { includeNulls: options.include_nulls ?? true },
    },
  });
}

async function rowsOf(response: Response): Promise<Rows> {
  expect(response.status).toBe(200);
  const answer = (await response.json()) as Answer;
  return answer.results[0]?.tables[0]?.rows ?? [];
}

describe("who may query", () => {
  it("lets the app-only person query on the org path and refuses the groups path", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(BEN);

    const org = await executeQueries(mock, token, "EVALUATE 'Orders'");
    expect(await rowsOf(org)).toHaveLength(2);

    const group = await executeQueries(mock, token, "EVALUATE 'Orders'", {
      group: WORKSPACE_ID,
    });
    expect(group.status).toBe(403);
  });

  it.each([
    ["a workspace Contributor through a group, org path", ADA, false, 200],
    ["a workspace Contributor through a group, groups path", ADA, true, 200],
    ["a direct share with Explore, org path", DAN, false, 200],
    ["a direct share with Explore, groups path", DAN, true, 403],
    ["a direct share with Read only, so no Build", EVE, false, 403],
    ["an app audience with Read only, so no Build", GIL, false, 403],
    ["a workspace Viewer, so no Build, org path", FAY, false, 403],
    ["a workspace Viewer, so no Build, groups path", FAY, true, 403],
    ["a person with no access", CLEO, false, 403],
    ["a person with no access, groups path", CLEO, true, 403],
  ])("%s", async (_name, person, by_group, status) => {
    const mock = startPowerBi();
    const response = await executeQueries(
      mock,
      await mock.personToken(person),
      "EVALUATE 'Orders'",
      by_group ? { group: WORKSPACE_ID } : {},
    );
    expect(response.status).toBe(status);
  });

  it("lets a service principal query only as a workspace member", async () => {
    const mock = startPowerBi();
    const member = await mock.principalToken(MEMBER_APP_ID);
    const stranger = await mock.principalToken(SCANNER_APP_ID);

    for (const options of [{}, { group: WORKSPACE_ID }]) {
      const answer = await executeQueries(
        mock,
        member,
        "EVALUATE 'Orders'",
        options,
      );
      expect(answer.status).toBe(200);
    }
    const refused = await executeQueries(mock, stranger, "EVALUATE 'Orders'");
    expect(refused.status).toBe(403);
  });

  it("refuses a service principal that is a workspace Viewer or listed by its application id", async () => {
    for (const entry of [
      { object_id: "77777777-0000-4000-8000-0000000000a2", role: "Viewer" },
      { object_id: MEMBER_APP_ID, role: "Member" },
    ]) {
      const tenant = powerBiTenant();
      const listed = tenant.workspaces[0]?.users.find(
        (user) => user.principal_type === "App",
      );
      if (!listed) throw new Error("no service principal in the workspace");
      listed.object_id = entry.object_id;
      listed.access_right = entry.role;
      const mock = startPowerBi(tenant);
      const response = await executeQueries(
        mock,
        await mock.principalToken(MEMBER_APP_ID),
        "EVALUATE 'Orders'",
      );
      expect(response.status).toBe(403);
    }
  });

  it("refuses a service principal on a row-level-security dataset and lets a person in", async () => {
    const mock = startPowerBi();
    const principal = await executeQueries(
      mock,
      await mock.principalToken(MEMBER_APP_ID),
      "EVALUATE 'Orders'",
      { dataset: RLS_DATASET_ID },
    );
    expect(principal.status).toBe(403);

    const person = await executeQueries(
      mock,
      await mock.personToken(ADA),
      "EVALUATE 'Orders'",
      { dataset: RLS_DATASET_ID },
    );
    expect(person.status).toBe(200);
  });

  it("reaches through an app only the datasets its reports use", async () => {
    const mock = startPowerBi();
    const response = await executeQueries(
      mock,
      await mock.personToken(BEN),
      "EVALUATE 'Orders'",
      { dataset: RLS_DATASET_ID },
    );
    expect(response.status).toBe(403);
  });

  it("answers 404 for a dataset that is not in the tenant or not in the named workspace", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const unknown = await executeQueries(mock, token, "EVALUATE 'Orders'", {
      dataset: "dddddddd-0000-4000-8000-0000000000ff",
    });
    const elsewhere = await executeQueries(mock, token, "EVALUATE 'Orders'", {
      group: "aaaaaaaa-0000-4000-8000-0000000000ff",
    });
    expect([unknown.status, elsewhere.status]).toEqual([404, 404]);
  });

  it("refuses everyone when the tenant setting is off, and again lets them in when it is on", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    await mock.patchSettings({ execute_queries: false });
    expect(
      (await executeQueries(mock, token, "EVALUATE 'Orders'")).status,
    ).toBe(403);
    await mock.patchSettings({ execute_queries: true });
    expect(
      (await executeQueries(mock, token, "EVALUATE 'Orders'")).status,
    ).toBe(200);
  });

  it("refuses a token without a dataset scope and a call without a token", async () => {
    const mock = startPowerBi();
    const wrong_scope = await mock.personToken(ADA, "User.Read");
    expect(
      (await executeQueries(mock, wrong_scope, "EVALUATE 'Orders'")).status,
    ).toBe(403);
    expect((await executeQueries(mock, null, "EVALUATE 'Orders'")).status).toBe(
      401,
    );
  });
});

describe("the engine", () => {
  it("keys a table's rows as Table[Column], without the RowNumber column or an error", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const response = await executeQueries(mock, token, "EVALUATE 'Orders'");
    expect(response.status).toBe(200);
    const answer = (await response.json()) as Answer;
    const [result] = answer.results[0]?.tables ?? [];
    expect(result?.rows[0]).toEqual({
      "Orders[OrderId]": 1,
      "Orders[Amount]": 10.5,
    });
    expect(result).not.toHaveProperty("error");
  });

  it("answers the EVALUATE that follows a DEFINE block", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const define = "DEFINE\n  MEASURE Orders[Two] = 2\n";
    expect(
      await rowsOf(
        await executeQueries(mock, token, `${define}EVALUATE TOPN(1, Orders)`),
      ),
    ).toHaveLength(1);
    expect((await executeQueries(mock, token, define)).status).toBe(400);
  });

  it("limits TOPN, reads an unquoted name in any case, and skips comments", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const dax = "// the first order\nevaluate TOPN(1, orders)";
    expect(await rowsOf(await executeQueries(mock, token, dax))).toHaveLength(
      1,
    );
  });

  it("answers the relationships view in Power BI's column names", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const rows = await rowsOf(
      await executeQueries(mock, token, "EVALUATE INFO.VIEW.RELATIONSHIPS()"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      "[FromTable]": "Orders",
      "[FromColumn]": "OrderId",
      "[ToTable]": "Customers",
      "[FromCardinality]": "Many",
      "[IsActive]": true,
      "[CrossFilteringBehavior]": "OneDirection",
    });
  });

  it("projects only the catalog's relationship and measure fields", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const relationships = await rowsOf(
      await executeQueries(
        mock,
        token,
        'EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(), "FromTable", [FromTable], "FromColumn", [FromColumn], "FromCardinality", [FromCardinality], "ToTable", [ToTable], "ToColumn", [ToColumn], "ToCardinality", [ToCardinality], "CrossFilteringBehavior", [CrossFilteringBehavior], "IsActive", [IsActive])',
      ),
    );
    expect(Object.keys(relationships[0] ?? {}).sort()).toEqual(
      "[CrossFilteringBehavior],[FromCardinality],[FromColumn],[FromTable],[IsActive],[ToCardinality],[ToColumn],[ToTable]".split(
        ",",
      ),
    );
    expect(relationships[0]?.["[FromTable]"]).toBe("Orders");
    const measures = await rowsOf(
      await executeQueries(
        mock,
        token,
        'EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "Name", [Name], "DisplayFolder", [DisplayFolder])',
      ),
    );
    expect(measures[0]).toEqual({
      "[Name]": "Total sales",
      "[DisplayFolder]": "Revenue",
    });
    expect(
      (
        await executeQueries(
          mock,
          token,
          'EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "[Name]", [Name], "DisplayFolder", [DisplayFolder])',
        )
      ).status,
    ).toBe(400);
  });

  it("answers the measures view with each measure's table and display folder", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const rows = await rowsOf(
      await executeQueries(mock, token, "EVALUATE INFO.VIEW.MEASURES()"),
    );
    expect(rows[0]).toMatchObject({
      "[Name]": "Total sales",
      "[Table]": "Orders",
      "[Expression]": "SUM(Orders[Amount])",
      "[DisplayFolder]": "Revenue",
    });
  });

  it("answers the columns view with each column's table and display folder", async () => {
    const tenant = powerBiTenant();
    const column = tenant.datasets[0]?.tables[0]?.columns[0];
    if (!column) throw new Error("no column");
    column.display_folder = "Keys";
    const mock = startPowerBi(tenant);
    const token = await mock.personToken(ADA);
    const rows = await rowsOf(
      await executeQueries(
        mock,
        token,
        'EVALUATE SELECTCOLUMNS(INFO.VIEW.COLUMNS(), "Table", [Table], "Name", [Name], "DisplayFolder", [DisplayFolder])',
      ),
    );
    expect(rows[0]).toEqual({
      "[Table]": "Orders",
      "[Name]": column.name,
      "[DisplayFolder]": "Keys",
    });
  });

  it("blanks the measures' DAX for a caller without write permission, here one reaching the dataset through an app", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(BEN);
    const rows = await rowsOf(
      await executeQueries(mock, token, "EVALUATE INFO.VIEW.MEASURES()"),
    );
    expect(rows[0]).toMatchObject({
      "[Name]": "Total sales",
      "[DisplayFolder]": "Revenue",
      "[Expression]": null,
      "[DetailRowsDefinition]": null,
      "[FormatStringDefinition]": null,
    });
  });

  it("refuses the INFO views on a dataset that refuses them, and still answers its tables", async () => {
    const tenant = powerBiTenant();
    const [sales] = tenant.datasets;
    if (!sales) throw new Error("no sales dataset");
    sales.refuses_info_views = true;
    const mock = startPowerBi(tenant);
    const token = await mock.personToken(ADA);
    for (const view of ["RELATIONSHIPS", "MEASURES"]) {
      const response = await executeQueries(
        mock,
        token,
        `EVALUATE INFO.VIEW.${view}()`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("DatasetExecuteQueriesError");
    }
    expect(
      await rowsOf(await executeQueries(mock, token, "EVALUATE Orders")),
    ).toHaveLength(2);
  });

  it("matches a recorded query whatever its whitespace, and writes nulls only when asked", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const dax =
      'EVALUATE\n  SUMMARIZECOLUMNS(Orders[OrderId],   "Sales", [Total sales])';

    const with_nulls = await rowsOf(await executeQueries(mock, token, dax));
    expect(with_nulls).toEqual([
      { "Orders[OrderId]": 1, "[Sales]": 10.5, "[Margin]": null },
    ]);
    const without = await rowsOf(
      await executeQueries(mock, token, dax, { include_nulls: false }),
    );
    expect(without).toEqual([{ "Orders[OrderId]": 1, "[Sales]": 10.5 }]);
  });

  it("answers 400 in Power BI's DAX error shape for a table that is not there", async () => {
    const mock = startPowerBi();
    const response = await executeQueries(
      mock,
      await mock.personToken(ADA),
      "EVALUATE 'Nope'",
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: {
        code: string;
        "pbi.error": { details: { code: string; detail: { value: string } }[] };
      };
    };
    expect(body.error.code).toBe("DatasetExecuteQueriesError");
    expect(body.error["pbi.error"].details[0]).toMatchObject({
      code: "DetailsMessage",
      detail: {
        value:
          "Query (1, 10) Failed to resolve name 'Nope'. It is not a valid table, variable, or function name.",
      },
    });
  });

  it("answers 400 for DAX it cannot evaluate and for a request that is not one query", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    const unsupported = await executeQueries(
      mock,
      token,
      "EVALUATE SUMMARIZE(Orders, Orders[OrderId])",
    );
    expect(unsupported.status).toBe(400);

    const two = await mock.call(
      `datasets/${DATASET_ID}/executeQueries`,
      token,
      {
        body: {
          queries: [{ query: "EVALUATE Orders" }, { query: "EVALUATE Orders" }],
        },
      },
    );
    expect(two.status).toBe(400);
  });
});

function bigTenant(
  columns: number,
  rows: number,
  cell: (row: number) => unknown,
) {
  const tenant = powerBiTenant();
  const names = Array.from(
    { length: columns },
    (_, index) => `C${String(index)}`,
  );
  tenant.datasets[0]?.tables.push(table("Big", names, rows, cell));
  return tenant;
}

describe("the result limits", () => {
  it("answers 200 with the first 100,000 rows and an error beside them", async () => {
    const mock = startPowerBi(bigTenant(1, 100_001, (row) => row));
    const response = await executeQueries(
      mock,
      await mock.personToken(ADA),
      "EVALUATE Big",
    );
    expect(response.status).toBe(200);
    const table = ((await response.json()) as Answer).results[0]?.tables[0];
    expect(table?.rows).toHaveLength(100_000);
    expect(table?.error?.message).toBe(
      "More than 100000 rows in a query result",
    );
  });

  it("stops at 1,000,000 values when the rows are wide", async () => {
    const mock = startPowerBi(bigTenant(11, 95_000, (row) => row));
    const response = await executeQueries(
      mock,
      await mock.personToken(ADA),
      "EVALUATE Big",
    );
    const table = ((await response.json()) as Answer).results[0]?.tables[0];
    expect(table?.rows).toHaveLength(90_909);
    expect(table?.error?.message).toBe(
      "More than 90909 rows in a query result",
    );
  });

  it("finishes the row that crosses 15 MB and writes no more", async () => {
    const megabyte = "x".repeat(1024 * 1024);
    const mock = startPowerBi(bigTenant(1, 20, () => megabyte));
    const response = await executeQueries(
      mock,
      await mock.personToken(ADA),
      "EVALUATE Big",
    );
    const table = ((await response.json()) as Answer).results[0]?.tables[0];
    expect(table?.rows).toHaveLength(15);
    expect(table?.error?.message).toBe(
      "More than 15 MB of data in a query result",
    );
  });
});

describe("the request limit", () => {
  it("answers 429 with Retry-After on the 121st request in a minute, per identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mock = startPowerBi();
    const ada = await mock.personToken(ADA);
    const dan = await mock.personToken(DAN);
    const ask = (token: string) =>
      executeQueries(mock, token, "EVALUATE TOPN(0, Orders)");

    const { statuses, refused } = await pastLimit(120, () => ask(ada));
    expect(statuses).toEqual([200]);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await ask(dan)).status).toBe(200);

    vi.setSystemTime(Date.now() + 61_000);
    expect((await ask(ada)).status).toBe(200);
  });

  it("answers an injected failure once, with its Retry-After", async () => {
    const mock = startPowerBi();
    const token = await mock.personToken(ADA);
    mock.state.failures.push({
      route_prefix: "/powerbi/v1.0/myorg/datasets",
      status: 429,
      retry_after_seconds: 7,
    });
    const failed = await executeQueries(mock, token, "EVALUATE Orders");
    expect(failed.status).toBe(429);
    expect(failed.headers.get("retry-after")).toBe("7");
    expect((await executeQueries(mock, token, "EVALUATE Orders")).status).toBe(
      200,
    );
  });
});
