import { randomBytes } from "node:crypto";
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { contextAs, devStackUrl, expect, PEOPLE, test } from "./fixtures.ts";

/*
 * The curator and viewer start from the sessions project, signed in through
 * the mock's Microsoft, so they reach what the sample's audiences give them:
 * the Analyst can read Sales and Marketing, and the Viewer can read Sales.
 * The mock keeps one acting user for everyone, so approval and other shared
 * changes run once, not in each viewport and theme.
 */

const CATEGORY = "review_e2e";
const SALES = "Sales";
const MARKETING = "Marketing";
const SAMPLE_METRIC = "orders";
/** The draft check:ui screenshots (scripts/check-ui.ts), which no test takes. */
const LEFT_ALONE = "net_sales";

type Send = (method: string, path: string, body?: object) => Promise<unknown>;

/** The api as this context's person calls it. */
function apiOf(context: BrowserContext): Send {
  return async (method, path, body) => {
    const answer = await context.request.fetch(`/api/v1${path}`, {
      method,
      headers: { origin: devStackUrl() },
      ...(body === undefined ? {} : { data: body }),
    });
    if (!answer.ok())
      throw new Error(
        `${method} ${path} answered ${String(answer.status())}: ${await answer.text()}`,
      );
    return (await answer.json()) as unknown;
  };
}

async function describe(
  context: BrowserContext,
  name: string,
  suffix: string,
  definition: string,
) {
  // The first test to need the category makes it; the others find it there.
  const category = await context.request.post(
    `/api/v1/categories/${CATEGORY}`,
    {
      headers: { origin: devStackUrl() },
      data: { name: "Review checks" },
    },
  );
  if (category.status() !== 201 && category.status() !== 409)
    throw new Error(
      `Making the category answered ${String(category.status())}`,
    );
  await apiOf(context)("PATCH", `/metrics/${name}`, {
    label: `Number of review checks ${suffix}`,
    definition,
    when_to_use: "To count the checks a review ran.",
    not_the_same_as: "No other metric counts review checks.",
    grain_and_filters: "One check. Skipped checks left out.",
    unit: "count",
    aliases: [],
    category: CATEGORY,
  });
}

type Draft = { name: string; datasets: { name: string }[] };

/** Claims an existing draft without moving variants from a seeded metric. */
async function claimDraft(
  request: APIRequestContext,
  send: Send,
  name: string,
  datasets: string[],
): Promise<void> {
  const drafts = (await send(
    "GET",
    `/drafts/next?limit=50&dataset=${encodeURIComponent(SALES)}`,
  )) as Draft[];
  const wanted = drafts.filter(
    (draft) =>
      draft.name !== LEFT_ALONE &&
      datasets.every((dataset) =>
        draft.datasets.some((held) => held.name === dataset),
      ),
  );
  for (const draft of wanted) {
    const renamed = await request.patch(`/api/v1/metrics/${draft.name}`, {
      headers: { origin: devStackUrl() },
      data: { name },
    });
    if (renamed.ok()) return;
  }
  throw new Error(`No draft in ${datasets.join(" and ")} is left to take.`);
}

/** A curator's metric from its own draft, verified: the checks pass. */
async function verifiedMetric(
  context: BrowserContext,
  datasets = [SALES],
): Promise<string> {
  const suffix = randomBytes(4).toString("hex");
  const name = `number_of_review_checks_${suffix}`;
  const send = apiOf(context);
  await claimDraft(context.request, send, name, datasets);
  await describe(context, name, suffix, "How many checks a review ran.");
  await send("POST", `/metrics/${name}/verify`);
  return name;
}

test.describe("as the curator", () => {
  test.use({ signedInAs: "curator" });

  test("opening the old address for net_sales lands on the catalog metric @once", async ({
    page,
  }) => {
    await page.goto("/review/metrics/net_sales");

    await expect(page).toHaveURL(/\/catalog\/metrics\/net_sales$/);
  });

  test("the sample curator approves a metric whose checks pass and the page shows human_verified with their name @once", async ({
    page,
  }) => {
    const name = await verifiedMetric(page.context());
    await page.goto(`/catalog/metrics/${name}`);
    const main = page.getByRole("main");
    await expect(
      main.getByText("agent_verified", { exact: true }),
    ).toBeVisible();
    await expect(
      main.getByText("Agents will treat this metric as checked by a person."),
    ).toBeVisible();
    await expect(main.getByRole("article").first()).toBeVisible();
    const metric = (await apiOf(page.context())("GET", `/metrics/${name}`)) as {
      base_variants: {
        measure_reference: string;
        dataset: { name: string };
      }[];
    };
    for (const { dataset, measure_reference } of metric.base_variants) {
      const variant = main.getByRole("article", {
        name: `Variant ${measure_reference} in ${dataset.name}`,
        exact: true,
      });
      await expect(variant).toHaveCount(1);
      await expect(
        variant.getByRole("link", { name: dataset.name, exact: true }),
      ).toBeVisible();
    }
    // A variant's DAX shows without a click; the Analyst may read Sales measures' DAX.
    await expect(
      main.getByRole("button", { name: "Copy DAX" }).first(),
    ).toBeVisible();

    await main.getByRole("button", { name: "Approve" }).click();

    await expect(
      main.getByText("human_verified", { exact: true }),
    ).toBeVisible();
    // Their name as Microsoft gave it, or their email when it gave none.
    const me = (await (await page.request.get("/api/v1/me")).json()) as {
      name: string | null;
      email: string;
    };
    expect(me.email).toBe(PEOPLE.curator);
    await expect(
      main.locator("header").getByText(me.name ?? me.email),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: "Approve" })).toHaveCount(0);
  });

  test("the same measure in Sales and Marketing keeps its dataset label @once", async ({
    page,
  }) => {
    await page.goto(`/catalog/metrics/${SAMPLE_METRIC}`);
    const metric = (await apiOf(page.context())(
      "GET",
      `/metrics/${SAMPLE_METRIC}`,
    )) as {
      base_variants: {
        measure_reference: string;
        dataset: { name: string };
      }[];
    };
    const variants = metric.base_variants.filter(({ dataset }) =>
      [SALES, MARKETING].includes(dataset.name),
    );
    expect(variants.map(({ dataset }) => dataset.name)).toContain(SALES);
    expect(variants.map(({ dataset }) => dataset.name)).toContain(MARKETING);
    expect(
      new Set(variants.map(({ measure_reference }) => measure_reference)).size,
    ).toBe(1);
    const main = page.getByRole("main");
    for (const { dataset, measure_reference } of variants) {
      const variant = main.getByRole("article", {
        name: `Variant ${measure_reference} in ${dataset.name}`,
        exact: true,
      });
      await expect(variant).toHaveCount(1);
      await expect(
        variant.getByRole("link", { name: dataset.name, exact: true }),
      ).toBeVisible();
    }
  });

  test("a metric with a failing check shows the check's sentence and a disabled Approve @once", async ({
    page,
  }) => {
    const send = apiOf(page.context());
    const suffix = randomBytes(4).toString("hex");
    const name = `number_of_review_checks_${suffix}`;
    // Made by hand, with no measure filed under it and no definition.
    await send("POST", "/metrics", { name: `draft_${suffix}`, label: "Draft" });
    await send("PATCH", `/metrics/draft_${suffix}`, { name });
    await describe(page.context(), name, suffix, "");
    await page.goto(`/catalog/metrics/${name}`);

    await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
    const checks = page.getByRole("region", { name: "Checks" });
    await expect(checks.getByText(/Fill in definition\./)).toBeVisible();
    await expect(checks.getByText(/no live base variant/)).toBeVisible();
  });

  test("a long list of metrics that share a word stays short until asked for @once", async ({
    page,
  }) => {
    const send = apiOf(page.context());
    const word = `zorblax${randomBytes(4).toString("hex")}`;
    for (const at of [1, 7, 3, 6, 2, 5, 4])
      await send("POST", "/metrics", {
        name: `${word}_${String(at)}`,
        label: `${word} ${String(at)}`,
      });
    await page.goto(`/catalog/metrics/${word}_1`);

    const approve = page.getByRole("region", { name: "Approve this metric" });
    const labels = approve.getByRole("listitem").getByRole("listitem");
    await expect(approve.getByText(/^6 other metrics share/)).toBeVisible();
    await expect(labels).toHaveText(
      [2, 3, 4, 5, 6].map((at) => `${word} ${String(at)}`),
    );
    await approve.getByRole("button", { name: "Show all 6" }).click();
    await expect(labels).toHaveText(
      [2, 3, 4, 5, 6, 7].map((at) => `${word} ${String(at)}`),
    );
  });
});

test.describe("as the viewer", () => {
  test.use({ signedInAs: "viewer" });

  test("the sample viewer sees the page without Approve @once", async ({
    page,
  }) => {
    const name = SAMPLE_METRIC;
    await page.goto(`/catalog/metrics/${name}`);

    await expect(
      page.getByRole("heading", { level: 1, name: "Orders" }),
    ).toBeVisible();
    await expect(
      page.getByText("The number of distinct orders placed in the period."),
    ).toBeVisible();
    await expect(page.getByRole("article").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  });

  test("a variant opens its Sales table in the diagram @once", async ({
    page,
  }) => {
    const name = SAMPLE_METRIC;
    const variants = (await apiOf(page.context())(
      "GET",
      `/metrics/${name}/variants?dataset=${encodeURIComponent(SALES)}`,
    )) as {
      items: { dataset: { id: string } }[];
    };
    const datasetId = variants.items[0]?.dataset.id;
    if (datasetId === undefined)
      throw new Error("The Sales Orders metric has no visible variant.");
    await page.goto(`/catalog/metrics/${name}`);
    await page
      .getByRole("link", { name: "Show Sales in the diagram" })
      .first()
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/catalog/datasets/${datasetId}\\?.*table=Sales`),
    );
  });

  test("the category breadcrumb opens its category page @once", async ({
    page,
  }) => {
    const name = SAMPLE_METRIC;
    await page.goto(`/catalog/metrics/${name}`);
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    const category = breadcrumb.getByRole("link", { name: "Orders" });
    await expect(category).toHaveAttribute(
      "href",
      "/catalog/categories/sales/orders",
    );
    await category.click();
    await expect(page).toHaveURL(/\/catalog\/categories\/sales\/orders$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Orders" }),
    ).toBeVisible();
  });

  test("a metric that does not exist and one the viewer cannot see show the same not-found page @once", async ({
    page,
    browser,
  }) => {
    const admin = await contextAs(browser, "admin");
    const names = await (async () => {
      const listed = (await apiOf(admin)("GET", "/metrics?limit=200")) as {
        items: { name: string }[];
      };
      await admin.close();
      return listed.items.map((item) => item.name);
    })();
    let hidden: string | undefined;
    for (const name of names) {
      const seen = await page.request.get(`/api/v1/metrics/${name}`);
      if (seen.status() === 404) {
        hidden = name;
        break;
      }
    }
    if (hidden === undefined)
      throw new Error(
        "The viewer sees every metric the admin does. This test needs a draft in Finance or Marketing, which the sample's Viewer does not reach.",
      );

    const missing = `no_such_metric_${randomBytes(4).toString("hex")}`;
    const shown = async (name: string) => {
      await page.goto(`/catalog/metrics/${name}`);
      const main = page.getByRole("main");
      await expect(
        main.getByRole("heading", { name: "No such metric" }),
      ).toBeVisible();
      // The tree beside the page loads on its own, and the comparison reads it too.
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("navigation", { name: "Breadcrumb" }),
      ).toHaveCount(0);
      return (await main.innerText()).replaceAll(name, "<metric>");
    };
    expect(await shown(hidden)).toBe(await shown(missing));
  });
});

test("someone signed out goes through sign-in and the address comes back as next", async ({
  page,
}) => {
  await page.goto("/review/metrics/number_of_orders");
  await expect(page).toHaveURL(
    /\/sign-in\?next=%2Fcatalog%2Fmetrics%2Fnumber_of_orders$/,
  );
});
