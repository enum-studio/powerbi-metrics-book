import { NO_SUCH_DATASET } from "../errors.js";
import { sampleTenant, type Table } from "@powerbi-metrics-book/powerbi-mock";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  connect,
  find,
  samplePerson,
  startPowerBi,
  type PowerBiFixture,
} from "../../test/powerbi-support.js";
import type { GuardedFetcher } from "../context.js";
import { executeQuery } from "./execute.js";
import { appServicePrincipalToken } from "./identity.js";

const tenant = sampleTenant();

function plainTable(name: string, rows: Record<string, unknown>[]): Table {
  const columns = Object.keys(rows[0] ?? {}).map((column) => ({
    name: column,
    data_type: "Variant",
    description: null,
    hidden: false,
  }));
  return {
    name,
    description: null,
    hidden: false,
    columns,
    measures: [],
    rows,
  };
}

const typed = plainTable("Typed", [
  { N: 1, Text: "a", When: "2025-01-31T00:00:00", Flag: true, Blank: null },
  { N: 2.5, Text: "b", When: "2025-02-28T00:00:00", Flag: false, Blank: null },
]);
const big = plainTable(
  "Big",
  Array.from({ length: 100_001 }, (_, index) => ({ N: index })),
);
for (const dataset of tenant.datasets) dataset.tables.push(typed, big);

let power: PowerBiFixture;

beforeAll(async () => {
  power = await startPowerBi(tenant);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => power.mock.close());

async function tokenOf(mailbox: string): Promise<string> {
  return (await connect(power, samplePerson(tenant, mailbox))).access_token;
}

function query(token: string, dataset: string, dax: string) {
  const { id } = find(tenant.datasets, (d) => d.name === dataset);
  const input = { token, dataset_id: id, dax, timeout_ms: 30_000 };
  return executeQuery(power.deps, input);
}

/** Answers with a body the mock does not write: Power BI's documented shape for a case it has no fixture for. */
function answering(body: unknown): GuardedFetcher {
  return {
    fetchFixed: () => Promise.resolve(Response.json(body)),
    fetchUntrusted: () => Promise.reject(new Error("not a fixed host")),
  };
}

describe("executeQuery", () => {
  it("returns the rows Power BI had and its sentence when the answer stops at a limit", async () => {
    const answer = await query(
      await tokenOf("admin"),
      "Sales",
      "EVALUATE 'Big'",
    );

    expect(answer).toMatchObject({
      truncated: true,
      note: "More than 100000 rows in a query result",
      columns: [{ name: "Big[N]", type: "number" }],
    });
    expect(answer.rows).toHaveLength(100_000);
    expect(answer.rows[99_999]).toEqual([99_999]);
  });

  it("reads a limit error written on the result rather than the table", async () => {
    const note = "More than 15 MB of data in a query result";
    const body = {
      results: [
        {
          tables: [{ rows: [{ "Typed[N]": 1 }] }],
          error: { code: "DatasetExecuteQueriesError", message: note },
        },
      ],
    };
    const deps = { ...power.deps, fetcher: answering(body) };
    const input = { token: "token", dataset_id: "id", dax: "EVALUATE 'Typed'" };

    expect(
      await executeQuery(deps, { ...input, timeout_ms: 1_000 }),
    ).toMatchObject({ truncated: true, note, rows: [[1]] });
  });

  it("returns rows as arrays with each column's type read from its values", async () => {
    const answer = await query(
      await tokenOf("admin"),
      "Sales",
      "EVALUATE 'Typed'",
    );

    expect(answer).toEqual({
      truncated: false,
      columns: [
        { name: "Typed[N]", type: "number" },
        { name: "Typed[Text]", type: "string" },
        { name: "Typed[When]", type: "datetime" },
        { name: "Typed[Flag]", type: "boolean" },
        { name: "Typed[Blank]", type: "null" },
      ],
      rows: [
        [1, "a", "2025-01-31T00:00:00", true, null],
        [2.5, "b", "2025-02-28T00:00:00", false, null],
      ],
    });
  });

  it("lets a person who reaches the dataset only through an app query it", async () => {
    const answer = await query(
      await tokenOf("viewer"),
      "Sales",
      "EVALUATE 'Typed'",
    );
    expect(answer.rows).toHaveLength(2);
  });

  it("runs a service-account query with the app's service principal token", async () => {
    const token = await appServicePrincipalToken(power.deps);
    const answer = await query(token, "Marketing", "EVALUATE TOPN(1, 'Typed')");
    expect(answer.rows).toEqual([[1, "a", "2025-01-31T00:00:00", true, null]]);
  });

  it("answers a dataset Power BI refuses as a missing one", async () => {
    const token = await tokenOf("app-reader");
    await expect(
      query(token, "Sales", "EVALUATE 'Typed'"),
    ).rejects.toMatchObject({
      kind: "not_found",
      message: NO_SUCH_DATASET,
    });
  });

  it("answers a token Power BI no longer accepts with needs_connection, not a missing dataset", async () => {
    const token = await tokenOf("admin");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);

    await expect(
      query(token, "Sales", "EVALUATE 'Typed'"),
    ).rejects.toMatchObject({
      kind: "needs_connection",
      detail: { status: 401 },
    });
  });

  it("passes a DAX error on as Power BI's sentence", async () => {
    const token = await tokenOf("admin");
    await expect(
      query(token, "Sales", "EVALUATE 'Nope'"),
    ).rejects.toMatchObject({
      kind: "invalid",
      message:
        "Query (1, 10) Failed to resolve name 'Nope'. It is not a valid table, variable, or function name.",
    });
  });

  it("answers Power BI's 429 as rate_limited with the wait it asked for", async () => {
    const token = await tokenOf("admin");
    power.mock.failNext("/powerbi/v1.0/myorg/datasets/", 429, 7);
    await expect(
      query(token, "Sales", "EVALUATE 'Typed'"),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      message:
        "Power BI is refusing more queries for now. Try again in 7 seconds.",
      detail: { retry_after_seconds: 7 },
    });
  });
});
