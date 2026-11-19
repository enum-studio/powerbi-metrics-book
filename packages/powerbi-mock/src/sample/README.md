# The sample tenant

Every name, measure, table and number here is invented. None of it comes
from a real company, tenant or person. The tenant is what is labelled sample
data (the web app's band, `pbmb whoami` and the MCP instructions say so),
so the names are plain: Sales, Finance, Analysts. No workspace, dataset
and table share a name, so a breadcrumb such as Commercial / Sales / Sales
lines reads plainly. `sampleTenant()` in `tenant.ts` builds it, the same
on every call; tenant id `11111111-1111-4111-8111-111111111111`. `pnpm dev:up`, the end-to-end test
and the evals run on it, and `src/bin.ts` serves it. What tests assert
against it is in `expected.ts`, written by hand.

## People and what they reach

Each cell says how the person reaches the dataset, then what Power BI lets
them do: **DAX** (they may query on both paths and `INFO.VIEW.MEASURES()`
shows each measure's expression), **names** (they may query on the
`/datasets/{id}` path only, and the view shows measure names with a null
`[Expression]`), **metadata** (they see the dataset; every query answers
403). Marketing refuses `INFO` views to everyone, so there **query** means
the query runs and the view answers 400. `expected.ts` states the same per
dataset, and `access.test.ts` runs it against the mock.

| Person | Email | Groups | Sales | Retail | Finance | Marketing |
|---|---|---|---|---|---|---|
| Admin | admin@sample.example | none | workspace Admin: DAX | workspace Admin: DAX | workspace Admin: DAX | workspace Admin: query, both paths |
| Analyst | analyst@sample.example | Analysts | Member through Analysts: DAX | Member through Analysts: DAX | nothing | direct share, `ReadExplore`: query, `/datasets/{id}` path only |
| Viewer | viewer@sample.example | none | Sales app, `ReadExplore`: names | Sales app, `ReadExplore`: names | nothing | nothing |
| Leader | leader@sample.example | Directors, Leadership | nothing | nothing | Leadership app through Leadership, `ReadExplore`: names | nothing |
| App reader | app-reader@sample.example | none | Sales app, `Read`: metadata | Sales app, `Read`: metadata | nothing | nothing |
| Sales viewer | sales-viewer@sample.example | none | workspace Viewer: metadata | workspace Viewer: metadata | nothing | nothing |
| Outsider | outsider@sample.example | none | nothing | nothing | nothing | nothing |
| Revoked analyst | revoked@sample.example | Analysts | Member through Analysts: DAX | Member through Analysts: DAX | nothing | nothing |

- A query needs Build: an Admin, Member or Contributor workspace role, or
  an app audience or direct share whose right carries `Explore` (the app
  publisher's "allow building content"). A workspace Viewer and a `Read`
  audience or share see the dataset and are refused every query. Measure
  DAX needs write permission, which only the Admin, Member and Contributor
  roles give.
- "Analysts" is a Member of the Commercial workspace.
- "Directors" is a member of "Leadership", the
  audience of the Leadership app; the Leader's Graph list names both.
- The Viewer, the Leader and the Analyst on Marketing are not members of
  the dataset's workspace, so Power BI refuses them the `/groups/{id}` query path.
- Row-level security roles are not modelled. Finance's
  `has_row_level_security` only refuses service principals; the mock
  returns every row to anyone allowed to query. The Leader stands for a
  person in Finance's role. The product relies on Power BI applying
  row-level security through each person's own token.
- The Revoked analyst has withdrawn consent: authorize answers
  `consent_required` and refresh tokens `invalid_grant` (the reconnect path).
- The Analyst owns "My workspace (Analyst)", a personal
  workspace with nothing in it, which the sync leaves out. A scan answers
  it with `users: null`, as the real scanner does for some workspaces; a
  group or an app in an access list has `emailAddress: null` and
  `userType: null`.
- Service principals: the scanner (`c1000000-...0001`) may call the admin
  APIs and is in no workspace. The app (`c1000000-...0002`) signs people in
  and is a Member of the Growth workspace only, for service-account
  queries.
- The app registration's redirect URIs are the api's two callbacks,
  `<base>/api/auth/callback/microsoft` and `<base>/api/v1/powerbi/callback`,
  and the mock accepts only those, exactly. `<base>` is
  `sampleTenant({ public_base_url })`, `http://localhost:3000` by default.
  `src/bin.ts` reads it from `SAMPLE_PUBLIC_BASE_URL`, which the dev stack
  sets to the api's `PUBLIC_BASE_URL`.

## Workspaces, apps and datasets

| Dataset | Workspace | App | Odd on purpose |
|---|---|---|---|
| Sales | Commercial | Sales app | none: the plain one, with the recorded queries |
| Retail | Commercial | Sales app | 16 invented tables and 20 relationships; row-level security |
| Finance | Management | Leadership app | row-level security |
| Marketing | Growth | none | refuses `INFO` views |
| Campaign archive | Growth | none | `schema_retrieval_error`, no tables |

The models hold Sales lines (about 3,000 order lines, 2024 to September
2026), Product, Customer, Date, Channel, Exchange rate, Ad spend and Web
sessions, as fits each. Date is a calculated table in each dataset; Web
sessions[Bounce rate] is a calculated column. Columns cover String, Int64,
Double, Decimal, DateTime, Boolean and Binary (Product[Image]); keys are
hidden. Sales lines[Ship date] to Date is inactive, Ad spend to Channel
filters both ways, and Exchange rate is disconnected.

## Measures and why each odd one is here

| Measure (dataset) | Why it is here | The drafter, default conventions |
|---|---|---|
| Net sales (Sales), Revenue (Finance), Net Sales (Marketing) | one calculation under two names in three datasets; Marketing's has other spacing and a comment | Net sales and Net Sales are one draft; Revenue is its own, because a reader of Finance alone must not learn a name from Sales, and `pbmb drafts next` offers the merge |
| Orders (Sales, Marketing) and Order count (Finance) | the same result written another way: `DISTINCTCOUNT` against `COUNTROWS(DISTINCT())` | Orders is one draft, Order count another |
| Net sales LY, YTD, QTD, MTD, LY YTD, vs LY, growth; Orders PY, YoY %, index vs PY; Units sold LY, PM; Revenue PY, PQ, YTD, PY YTD; Gross margin QTD, MTD; Sessions yesterday | each period and comparison pattern of the DAX module once | variants of their base, shifts in `EXPECTED_DRAFTS` |
| Web net sales LY (Sales) | a near miss: the previous-year pattern with an extra Channel filter | its own draft, not a variant |
| Revenue USD (Finance) | converted through the Exchange rate table | its own draft; `pbmb drafts next` suggests it with Revenue |
| Ad spend LY (Marketing) | a previous year as `DATEADD` of -365 days, a form the patterns do not know | its own draft; suggested with Ad spend |
| Revenue in selected currency (Finance) | reads `SELECTEDVALUE` of the currency slicer | its own draft, reads the selection |
| _Report title (Sales), _Currency format (Finance, hidden) | a title string and a format-string helper | dismissed: the name starts with `_` |
| Target, Stretch target, Target gap (Finance) | a three-measure reference cycle | ungrouped, cycle recorded |
| Order lines (Sales, Marketing) | one calculation, in Sales inside a `VAR Result = ... RETURN Result` | one draft |
| Order lines LM, LW, LY, MoM, WoW, YoY (Sales) | shifts written the long way: variables, brackets, calendar columns of the Date table, zero for a blank, a slicer | variants of Order lines; LW and WoW carry a note that a blank shows as 0 |
| Order lines (Retail) | the same name on another table | its own draft; `pbmb drafts next` suggests it, by name |
| Web order lines LM (Sales) | a near miss: the calendar shift with an extra Channel filter | its own draft, not a variant |
| Order lines held (Sales) | a measure kept in a variable, which `CALCULATE` cannot shift, so it is this period's value | its own draft, not a variant |
| Order lines LQ (Sales) | named a quarter back, while its calendar column holds a month back | its own draft; suggested with Order lines |
| Order lines LY zero (Sales) | a second previous year, zero for a blank | its own draft: Order lines LY holds that shift |
| Gross margin % PY, vs PY (Finance) | a shift composed of two measures shifted by one filter, and a comparison against it | variants of Gross margin % |
| Gross margin % PQ (Finance) | the same, with its own zero for a blank | variant of Gross margin %, carrying the note |
| Units per order PM (Sales) | the same, on a base that shows 0 for a blank as well | variant of Units per order, with no note |
| Average order value LY (Sales) | a near miss: both its measures are a previous year, by filters that cover other dates | its own draft; suggested with Average order value |
| Gross margin % on PY margin (Finance) | a near miss: only one side is shifted | its own draft, not a variant |
| Gross margin points PY (Finance) | a near miss: times 100, and no measure is the base of that | its own draft, not a variant |

Every other measure (Average order value, Return rate, Ad spend, Cost per
click, Return on ad spend, Conversion rate) is a draft of
its own, and a name two drafts share (`EXPECTED_SAME_NAME`) stays two drafts. The Retail measures Returned units and Units on hand share a draft
because the drafter fingerprints their plain `SUM` expressions alike.

## What "by meaning" matches

The mock's embeddings (`src/embeddings/concepts.ts`) treat these words as
one: revenue, sales, turnover, income, earnings; orders, purchases,
bookings, transactions; customers, clients, buyers, shoppers; visits,
visitors, sessions, traffic; margin, profit; returns, refunds; cost, spend,
spending, expense; ad, ads, advertising; target, goal, quota; units,
quantity; discount, rebate; average, mean; rate, ratio, percent; previous,
last, prior, LY, PY. Plurals match their singular. Total, sum, number,
count and amount are ignored, so "Order count" and "Orders" are alike. Any
other word matches only itself, so a test that wants a match by meaning
must use a word from these groups.

## Recorded queries

`SAMPLE_QUERIES` in `tenant.ts` holds the DAX; the answers are computed
from the generated rows.

| Question | Dataset |
|---|---|
| Net sales by month in 2025 (`net_sales_by_month_2025`) | Sales |
| Orders by channel (`orders_by_channel`) | Sales, and Marketing for the app's service principal |
