/** Editorial content for the invented tenant. References use model names, never generated draft keys. */
export type MeasureRef = readonly [dataset: string, measure: string];
type Related = {
  measure: MeasureRef;
  reason: string;
  movement: "same" | "opposite" | "depends";
};
type Entry = {
  category: string;
  tier: string;
  importance: string;
  importance_why: string;
  direction: string;
  use_for: string;
  dont_use_for: string;
  caveats: string;
  decisions: string;
  actions: string;
  primary_dimensions: string[];
  owner_team: string;
  building_block: boolean;
  related: Related[];
};
type Copy = {
  why: string;
  use: string;
  avoid: string;
  caveat: string;
  decision: string;
  action: string;
  related: Related[];
  tier?: string;
  importance?: string;
  direction?: string;
  dimensions?: string[];
  building_block?: boolean;
};
const related = (
  dataset: string,
  measure: string,
  reason: string,
  movement: Related["movement"] = "depends",
): Related => ({ measure: [dataset, measure], reason, movement });
const sales = (
  measure: string,
  reason: string,
  movement?: Related["movement"],
) => related("Sales", measure, reason, movement);
const retail = (
  measure: string,
  reason: string,
  movement?: Related["movement"],
) => related("Retail", measure, reason, movement);
const finance = (
  measure: string,
  reason: string,
  movement?: Related["movement"],
) => related("Finance", measure, reason, movement);
const marketing = (
  measure: string,
  reason: string,
  movement?: Related["movement"],
) => related("Marketing", measure, reason, movement);

export const READING_CONTENT = new Map<string, Entry>();
export const measureKey = ([dataset, measure]: MeasureRef) =>
  `${dataset}/${measure}`;
function add(dataset: string, measure: string, category: string, copy: Copy) {
  const area = category.split("/")[0];
  READING_CONTENT.set(measureKey([dataset, measure]), {
    category,
    tier: copy.tier ?? "diagnostic",
    importance: copy.importance ?? "medium",
    direction: copy.direction ?? "neither",
    importance_why: copy.why,
    use_for: copy.use,
    dont_use_for: copy.avoid,
    caveats: copy.caveat,
    decisions: copy.decision,
    actions: copy.action,
    owner_team:
      area === "finance"
        ? "Finance"
        : area === "retail"
          ? "Retail operations"
          : area === "marketing"
            ? "Marketing"
            : area === "web_analytics"
              ? "Digital"
              : "Sales",
    primary_dimensions:
      copy.dimensions ??
      (dataset === "Retail"
        ? ["Store", "Product", "Currency"]
        : dataset === "Sales"
          ? ["Channel", "Product", "Region"]
          : ["Calendar date"]),
    building_block: copy.building_block ?? false,
    related: copy.related,
  });
}

add("Sales", "Net sales", "sales", {
  tier: "north_star",
  importance: "critical",
  direction: "higher_is_better",
  why: "This is the trading result: it separates growth in order volume from growth in basket value.",
  use: "Track sales targets and compare order demand by channel, product and customer region in EUR.",
  avoid:
    "Do not use it as profit or cash collected. Gross margin subtracts goods cost; this measure does not deduct returns.",
  caveat:
    "Returned lines still count. Orders times Average order value reconciles only with the same Sales dataset, date range and filters.",
  decision:
    "Sales decides whether a trading shortfall needs more orders, a different product mix or less discounting.",
  action:
    "Split a movement into Orders and Average order value, then inspect the affected channels and products before changing promotions.",
  related: [
    sales(
      "Orders",
      "More orders raise Net sales when Average order value is held constant.",
      "same",
    ),
    sales(
      "Average order value",
      "A larger average basket raises Net sales at the same order count.",
      "same",
    ),
  ],
});
add("Sales", "Orders", "sales/orders", {
  tier: "driver",
  importance: "high",
  direction: "higher_is_better",
  why: "Distinct orders measure purchase demand and the number of baskets fulfilment must handle.",
  use: "Plan order-processing capacity and compare purchase frequency across channels.",
  avoid:
    "Do not use it for units to pick or revenue. Use Units sold for physical volume and Net sales for money.",
  caveat:
    "Product filtering counts orders containing that product; adding those counts can count one basket more than once.",
  decision:
    "Operations chooses staffing for order processing; Sales decides where purchase demand needs attention.",
  action:
    "Check channel demand first, then Units per order to distinguish more baskets from larger baskets.",
  related: [
    sales(
      "Net sales",
      "Order growth raises sales only if basket value does not fall enough to offset it.",
    ),
    sales(
      "Units per order",
      "Together with Orders, Units per order explains physical picking volume.",
    ),
  ],
});
add("Sales", "Average order value", "sales/orders", {
  tier: "driver",
  importance: "high",
  direction: "higher_is_better",
  why: "Basket value explains sales movements that order count alone cannot explain.",
  use: "Compare basket value under one currency and assess product mix or discount changes.",
  avoid:
    "Do not use it as average item price or margin. A basket may contain several units with different costs.",
  caveat:
    "Recalculate Net sales divided by Orders for a combined period; do not average daily averages. Returns remain in the numerator.",
  decision:
    "Merchandising evaluates bundles and discount offers alongside their margin effect.",
  action:
    "Compare Units per order, product mix and discounts before concluding that customers are spending more per item.",
  related: [
    sales(
      "Net sales",
      "Higher basket value raises Net sales at the same number of orders.",
      "same",
    ),
    sales(
      "Units per order",
      "More units per basket can raise basket value without any item-price increase.",
    ),
  ],
});
add("Sales", "Order lines", "sales/orders", {
  why: "A line count distinguishes basket complexity from the number of orders and physical units.",
  use: "Estimate the number of product lines to process and explain why order handling effort changes.",
  avoid:
    "Do not call lines orders or units: use Orders for baskets and Units sold for quantities.",
  caveat:
    "One line can contain several units; a returned line remains a line in this count.",
  decision:
    "Operations adjusts picking workflows when baskets contain more separate product lines.",
  action:
    "Compare lines per order and Units sold before adding capacity for a rise in line count.",
  related: [
    sales(
      "Orders",
      "More lines with flat Orders means more distinct lines per basket.",
    ),
    sales(
      "Units sold",
      "Units can rise faster than lines when each line carries a larger quantity.",
    ),
  ],
});
add("Sales", "Units sold", "sales/orders", {
  tier: "driver",
  direction: "higher_is_better",
  why: "Physical quantity drives stock demand even when price and order count stay flat.",
  use: "Plan picking and replenishment by product and channel.",
  avoid:
    "Do not use it for units retained after returns or for order count; returned lines remain included.",
  caveat:
    "Products have different prices and costs, so unit growth does not imply equal sales or margin growth.",
  decision:
    "Supply planning allocates inventory to products with sustained unit demand.",
  action:
    "Inspect product mix and Return rate before interpreting higher units as durable demand.",
  related: [
    sales(
      "Orders",
      "Orders times Units per order explains Units sold under identical filters.",
    ),
    sales(
      "Units per order",
      "Higher Units per order raises unit volume at a fixed order count.",
      "same",
    ),
  ],
});
add("Sales", "Units per order", "sales/orders", {
  why: "It separates basket size in physical units from basket value in money.",
  use: "Assess bundle uptake and the picking effort per order.",
  avoid:
    "Do not use it as Average order value: more low-price units can increase this ratio while basket value falls.",
  caveat:
    "The model shows zero when there are no orders. That is not evidence of real empty baskets.",
  decision:
    "Merchandising evaluates multi-buy offers and Operations adjusts expected picks per basket.",
  action:
    "Check Orders and product mix; if the ratio is zero, verify that the period contains orders.",
  related: [
    sales("Units sold", "Units sold is the numerator of Units per order."),
    sales(
      "Average order value",
      "Basket value also depends on prices and discounts, so unit and value averages can diverge.",
    ),
  ],
});
add("Sales", "Return rate", "sales/returns", {
  tier: "guardrail",
  importance: "high",
  direction: "lower_is_better",
  why: "Sales before returns can look healthy while a growing share of order lines comes back.",
  use: "Find products and channels with a high share of returned lines, grouped by order date.",
  avoid:
    "Do not interpret it as a refund-value rate or a returned-unit rate. It counts flags on lines.",
  caveat:
    "Recent orders have had less time to be returned; compare cohorts with similar return windows.",
  decision:
    "Customer operations prioritizes quality, fit and fulfilment investigations by product.",
  action:
    "Check the age of the orders and affected products before changing descriptions, packaging or supplier checks.",
  related: [
    sales(
      "Net sales",
      "Net sales does not deduct returns, so a rising return rate can hide behind growing sales.",
    ),
    sales(
      "Order lines",
      "The same returned-line count produces a lower return rate when total order lines increase.",
      "opposite",
    ),
  ],
});
add("Marketing", "Sessions", "web_analytics", {
  tier: "driver",
  importance: "high",
  direction: "higher_is_better",
  dimensions: ["Calendar date", "Device"],
  why: "Visits measure the traffic available to the web shop before any order is placed.",
  use: "Compare web traffic by day and device after the analytics refresh.",
  avoid:
    "Do not count sessions as people or buyers; one person can visit several times.",
  caveat:
    "Sessions arrive a day behind. The model's Conversion rate divides all-channel orders by web sessions, so it is not a clean web conversion probability.",
  decision:
    "Digital decides whether a sales change starts with traffic or with what visitors do next.",
  action:
    "Compare device traffic on fully refreshed days, then inspect Orders with a matching web-channel filter.",
  related: [
    marketing(
      "Conversion rate",
      "Sessions is the denominator, so more traffic lowers the model ratio if orders stay flat.",
      "opposite",
    ),
    sales(
      "Orders",
      "Traffic and orders describe different stages; align their dates and channels before comparing them.",
    ),
  ],
});
add("Marketing", "Conversion rate", "web_analytics", {
  tier: "diagnostic",
  importance: "high",
  dimensions: ["Calendar date"],
  why: "The ratio can expose order-versus-traffic divergence, but its numerator and denominator are not naturally the same population.",
  use: "Diagnose changes in the model's Orders divided by Sessions ratio with the populations stated explicitly.",
  avoid:
    "Do not report it as the share of web sessions that bought: Orders includes every channel unless filtered.",
  caveat:
    "Device filters reach web sessions but not the order numerator. Sales-channel filters do not narrow sessions.",
  decision:
    "Digital decides whether the model needs a web-only numerator before using conversion as a target.",
  action:
    "Inspect the numerator and denominator separately and resolve filter mismatches before changing the checkout.",
  related: [
    marketing(
      "Sessions",
      "The ratio falls as sessions increase if the order numerator stays fixed.",
      "opposite",
    ),
    sales(
      "Orders",
      "The ratio rises as orders increase if the session denominator stays fixed.",
      "same",
    ),
  ],
});
add("Marketing", "Ad spend", "marketing/paid_media", {
  tier: "driver",
  importance: "high",
  dimensions: ["Channel", "Calendar date"],
  why: "Advertising is a controllable cost; spending more only helps when the resulting demand justifies it.",
  use: "Track paid-media budgets and compare spend across complete weeks and channels.",
  avoid:
    "Do not use spend as customer acquisition cost; the model has no attributed new-customer denominator.",
  caveat:
    "Spend is weekly while sales and sessions are daily. A partial week can misalign the comparison.",
  decision:
    "Marketing allocates budget after considering cost per click and the limits of the sales-to-spend ratio.",
  action:
    "Separate changes in click volume from click price, then compare aligned weeks before reallocating budget.",
  related: [
    marketing(
      "Cost per click",
      "Spend increases with Cost per click when click volume is held constant.",
      "same",
    ),
    marketing(
      "Return on ad spend",
      "More spend lowers Return on ad spend if sales stay fixed.",
      "opposite",
    ),
  ],
});
add("Marketing", "Cost per click", "marketing/paid_media", {
  tier: "guardrail",
  direction: "lower_is_better",
  dimensions: ["Channel", "Calendar date"],
  why: "Click price explains a budget increase that traffic volume alone cannot explain.",
  use: "Compare the cost of buying clicks by channel over complete weeks.",
  avoid:
    "Do not use it as cost per order or a measure of visitor quality. Cheap clicks need not create purchases.",
  caveat:
    "Recompute total spend divided by total clicks when combining channels; do not average their ratios.",
  decision:
    "Marketing reviews bids and channel mix when clicks become more expensive.",
  action:
    "Check the spend and click totals, then investigate the channel responsible before reducing bids.",
  related: [
    marketing(
      "Ad spend",
      "Higher click price raises spend at a fixed click volume.",
      "same",
    ),
    marketing(
      "Return on ad spend",
      "Higher click prices can reduce sales per euro spent, but conversion and basket value also matter.",
    ),
  ],
});
add("Marketing", "Return on ad spend", "marketing/paid_media", {
  importance: "high",
  dimensions: ["Channel", "Calendar date"],
  why: "It compares sales with media cost, but attribution limits prevent treating the ratio as incremental return.",
  use: "Monitor the model's sales-to-ad-spend ratio over aligned periods as a diagnostic.",
  avoid:
    "Do not claim the ads caused all numerator sales or that the ratio is profit. Net Sales includes every filtered order.",
  caveat:
    "Organic and repeat purchases remain in sales, and neither goods cost nor returns is deducted.",
  decision:
    "Marketing uses the ratio to select campaigns for further attribution analysis, not to approve spend on its own.",
  action:
    "Separate a movement into sales and spend, then check channel attribution before scaling a campaign.",
  related: [
    sales(
      "Net sales",
      "More numerator sales raise the ratio at fixed ad spend.",
      "same",
    ),
    marketing(
      "Ad spend",
      "More denominator spend lowers the ratio at fixed sales.",
      "opposite",
    ),
  ],
});
add("Finance", "Revenue in selected currency", "finance", {
  tier: "north_star",
  importance: "critical",
  dimensions: ["Calendar date", "Currency"],
  why: "Finance needs a stated reporting currency before comparing revenue across reports.",
  use: "Present revenue in the one currency selected on the report and label the currency beside the number.",
  avoid:
    "Do not use a currency-driven movement as evidence of changed demand. Use Net sales in EUR for that comparison.",
  caveat:
    "With several currencies selected the model uses EUR if available and otherwise returns blank. Returned sales remain included.",
  decision:
    "Finance agrees the presentation currency and checks comparability before signing off a revenue comparison.",
  action:
    "Check the currency selection and fixed exchange rate, then compare the underlying EUR Net sales.",
  related: [
    sales(
      "Net sales",
      "This is the same sales amount translated by the selected currency; exchange rates can change the displayed number.",
    ),
    finance(
      "Revenue USD",
      "The two should agree when USD alone is selected under identical sales filters.",
    ),
  ],
});
add("Finance", "Revenue USD", "finance", {
  dimensions: ["Calendar date", "Currency"],
  why: "A fixed USD view helps reconcile a selected-currency report without changing its trading basis.",
  use: "Reconcile revenue displayed in USD with the EUR sales amount and the model's fixed USD rate.",
  avoid:
    "Do not use it for historical foreign-exchange effects; the model holds a fixed rate, not daily rates.",
  caveat:
    "The lookup returns blank if the currency selection excludes USD. The fixed multiplier is 1.08.",
  decision:
    "Finance decides whether a mismatch comes from currency selection rather than sales data.",
  action:
    "Clear a conflicting currency filter, select USD, and compare with Revenue in selected currency.",
  related: [
    finance(
      "Revenue in selected currency",
      "With USD selected the two measures should reconcile.",
    ),
    sales(
      "Net sales",
      "With USD available, USD revenue is EUR Net sales multiplied by the fixed 1.08 rate.",
      "same",
    ),
  ],
});
add("Finance", "Order count", "finance", {
  why: "Finance has a separately written distinct-order count that can reconcile the order population behind revenue.",
  use: "Reconcile the Finance order population with Sales Orders under equivalent filters.",
  avoid:
    "Do not count order lines or infer a different business definition just because the DAX spelling differs.",
  caveat:
    "COUNTROWS(DISTINCT()) and DISTINCTCOUNT express the same count here, but the drafter leaves the definitions separate for review.",
  decision:
    "Finance and Sales decide whether the two entries can be curated into one metric after reconciliation.",
  action:
    "Compare counts for the same dates before investigating dataset filters or proposing a merge.",
  related: [
    sales(
      "Orders",
      "Both count distinct order ids and should agree under equivalent filters.",
      "same",
    ),
    finance(
      "Revenue in selected currency",
      "The count helps distinguish order-volume changes from revenue currency changes.",
    ),
  ],
});
add("Finance", "Gross margin", "finance/margin", {
  tier: "north_star",
  importance: "critical",
  direction: "higher_is_better",
  why: "Margin in money captures what remains after goods cost, which sales growth alone does not show.",
  use: "Assess the contribution left after goods cost and compare it with the sales amount in EUR.",
  avoid:
    "Do not call it net profit: operating expenses, tax and return deductions are outside this calculation.",
  caveat:
    "Goods cost is based on gross amount; discounts reduce margin without reducing that cost. This measure stays in EUR.",
  decision:
    "Finance reviews whether promotions generate enough goods margin to support the operating plan.",
  action:
    "Compare sales and Gross margin % to separate volume from discount or cost pressure.",
  related: [
    sales(
      "Net sales",
      "More sales can raise margin, but discounts and goods cost determine how much is retained.",
    ),
    finance(
      "Gross margin %",
      "Gross margin % explains the share of revenue retained as Gross margin.",
    ),
  ],
});
add("Finance", "Gross margin %", "finance/margin", {
  tier: "guardrail",
  importance: "high",
  direction: "higher_is_better",
  why: "The retained share of revenue exposes margin dilution even when the total margin amount grows.",
  use: "Compare the goods-margin share across periods alongside the EUR margin amount.",
  avoid:
    "Do not read a change from 40% to 45% as 5% growth: it is five percentage points.",
  caveat:
    "Recalculate total margin divided by total revenue for combined periods. Both underlying measures are EUR and include returned sales.",
  decision:
    "Finance decides whether discount levels leave enough margin per euro of sales.",
  action:
    "Check discount and cost movements, then inspect the margin amount before changing price targets.",
  related: [
    finance(
      "Gross margin",
      "The percentage and the amount can diverge when sales volume changes.",
    ),
    sales(
      "Net sales",
      "Revenue is the denominator; a higher sales total need not improve the retained share.",
    ),
  ],
});

// Intentionally awkward model measures are documented as diagnostics, not promoted to business targets.
function diagnostic(
  dataset: string,
  measure: string,
  category: string,
  issue: string,
  use: string,
  replacement: MeasureRef,
  second: MeasureRef,
) {
  add(dataset, measure, category, {
    importance: "low",
    building_block: true,
    why: `This entry keeps a model-specific calculation visible during reconciliation: ${issue}`,
    use,
    avoid: `Do not use it as ${replacement[1]}; read the documented date and filter differences first.`,
    caveat: issue,
    decision:
      "The model owner decides whether to correct or rename this calculation before it appears in a business target.",
    action: `Reconcile with ${replacement[1]} over a small, explicit selection; inspect the DAX if the values differ.`,
    related: [
      related(...replacement, issue),
      related(
        ...second,
        `Read ${second[1]} beside this calculation to keep the affected numerator, denominator or filter visible.`,
      ),
    ],
  });
}
diagnostic(
  "Sales",
  "Web net sales LY",
  "sales",
  "It adds a Web filter to the previous-year sales calculation.",
  "Compare last year's Web sales with an explicitly Web-filtered sales view.",
  ["Sales", "Net sales"],
  ["Sales", "Web order lines LM"],
);
diagnostic(
  "Sales",
  "Web order lines LM",
  "sales/orders",
  "It counts only Web lines and moves dates back 28 days, not one calendar month.",
  "Reconcile Web line demand against a four-week comparator.",
  ["Sales", "Order lines"],
  ["Sales", "Web net sales LY"],
);
diagnostic(
  "Sales",
  "Order lines held",
  "sales/orders",
  "The stored DAX variable is evaluated before the year shift, so this still counts current-period lines.",
  "Identify a frozen-variable time-shift error in a model review.",
  ["Sales", "Order lines"],
  ["Sales", "Orders"],
);
diagnostic(
  "Sales",
  "Order lines LQ",
  "sales/orders",
  "Despite its name, it moves dates back 28 days rather than one quarter.",
  "Reconcile the existing four-week calculation while arranging a corrected name.",
  ["Sales", "Order lines"],
  ["Sales", "Orders"],
);
diagnostic(
  "Sales",
  "Order lines LY zero",
  "sales/orders",
  "It replaces a missing prior-year result with zero; the absence of data is then indistinguishable from no lines.",
  "Check how zero-filled prior-year values affect a report.",
  ["Sales", "Order lines"],
  ["Sales", "Order lines held"],
);
diagnostic(
  "Sales",
  "Average order value LY",
  "sales/orders",
  "Its sales numerator uses the same days last year, but its order denominator takes whole prior-year months.",
  "Diagnose unexpectedly low prior-year basket values for partial months.",
  ["Sales", "Average order value"],
  ["Sales", "Orders"],
);
diagnostic(
  "Finance",
  "Gross margin % on PY margin",
  "finance/margin",
  "It divides last year's margin by current-period revenue, mixing two periods.",
  "Explain why a legacy margin ratio differs from a true prior-year margin percentage.",
  ["Finance", "Gross margin %"],
  ["Finance", "Gross margin"],
);
diagnostic(
  "Finance",
  "Gross margin points PY",
  "finance/margin",
  "The value is multiplied by 100 and then formatted as a percentage, making the displayed percentage 100 times too large.",
  "Find a scaling and formatting error in a prior-year margin report.",
  ["Finance", "Gross margin %"],
  ["Finance", "Gross margin % on PY margin"],
);
diagnostic(
  "Marketing",
  "Ad spend LY",
  "marketing/paid_media",
  "The offset is 365 days, which differs from calendar-year alignment around a leap day.",
  "Reconcile the existing fixed-day comparator with an explicitly aligned spend period.",
  ["Marketing", "Ad spend"],
  ["Marketing", "Return on ad spend"],
);

const MIXED =
  "Retail adds EUR, USD and SEK amounts without conversion. Filter to one Currency before interpreting money; prior-year variants are blank because the sample covers only Q1 2026.";
add("Retail", "Net sales", "retail", {
  tier: "north_star",
  importance: "critical",
  dimensions: ["Store", "Product", "Currency"],
  why: "Store trading needs a sales result that can be reconciled to orders, discounts and the budget.",
  use: "Review store sales in one currency at a time and compare products within that selection.",
  avoid:
    "Do not present the unfiltered total as EUR or net of returns. Use Net amount EUR for a converted total.",
  caveat: MIXED,
  decision:
    "Retail operations identifies stores and products that need trading attention after currency filters are fixed.",
  action:
    "Check currency first, then split sales into Orders and Average order value; inspect Refunds separately.",
  related: [
    retail(
      "Orders",
      "Order volume contributes to store sales under matching currency and date filters.",
    ),
    retail(
      "Average order value",
      "Orders times Average order value reconciles to Retail Net sales under identical filters.",
      "same",
    ),
  ],
});
add("Retail", "Gross sales", "retail", {
  why: "Sales before discount exposes how much discounting separates list-price sales from the trading result.",
  use: "Compare gross and net sales within one store, currency and period.",
  avoid:
    "Do not report it as collected revenue; discounts, returns and tax treatment differ.",
  caveat: MIXED,
  decision:
    "Retail operations reviews whether promotions are increasing volume at the cost of realized selling value.",
  action:
    "Compare the gross-to-net difference with the promotion and product mix.",
  related: [
    retail(
      "Net sales",
      "Gross sales less discounts is Net sales before returns under matching filters.",
    ),
    retail(
      "Gross margin",
      "Discounts reduce margin without reducing the original goods cost.",
    ),
  ],
});
add("Retail", "Orders", "retail", {
  tier: "driver",
  importance: "high",
  direction: "higher_is_better",
  why: "Store order volume distinguishes more baskets from higher value per basket.",
  use: "Plan store order handling and compare purchase counts by store.",
  avoid:
    "Do not use order count for individual units, distinct customers or sales value.",
  caveat:
    "The same order may appear in several product groups; do not add distinct counts across those groups.",
  decision:
    "Store managers plan order-handling capacity and investigate changes in purchase frequency.",
  action:
    "Compare store order counts with Customers and Average order value before changing staffing or offers.",
  related: [
    retail(
      "Net sales",
      "More orders can raise sales even when each basket is worth less.",
    ),
    retail(
      "Customers",
      "Orders can grow faster than distinct Customers when customers buy repeatedly.",
    ),
  ],
});
add("Retail", "Average order value", "retail", {
  tier: "driver",
  importance: "high",
  why: "The value per basket explains store sales changes beyond order volume.",
  use: "Compare basket values within a single currency and consistent store selection.",
  avoid:
    "Do not average basket values across currencies or use them as item prices.",
  caveat: MIXED,
  decision:
    "Store merchandising evaluates changes in basket mix and promotional discounting.",
  action:
    "Compare Units, Orders and gross-to-net discounts to explain a basket-value change.",
  related: [
    retail("Net sales", "Net sales is the numerator of Average order value."),
    retail(
      "Orders",
      "Orders is the denominator; more orders with fixed sales lowers average basket value.",
      "opposite",
    ),
  ],
});
add("Retail", "Order lines", "retail", {
  why: "Separate lines represent basket complexity, which differs from both order count and total units.",
  use: "Compare the number of product lines handled by each store.",
  avoid: "Do not treat a line as a basket or assume it contains one unit.",
  caveat: "A returned purchase still contributes its original order line.",
  decision:
    "Retail operations chooses picking and checkout workflows for the mix of baskets.",
  action:
    "Check whether lines per order or units per line changed before changing capacity.",
  related: [
    retail(
      "Orders",
      "Lines per order describes the complexity of each basket.",
    ),
    retail(
      "Units",
      "More units on each line can increase physical workload without increasing line count.",
    ),
  ],
});
add("Retail", "Units", "retail", {
  tier: "driver",
  direction: "higher_is_better",
  why: "Physical sales volume connects store demand to stock needs.",
  use: "Assess product demand and plan replenishment by store.",
  avoid:
    "Do not use it as net units retained by customers; returns are a separate measure.",
  caveat:
    "The sales measure counts the original quantities, including purchases later returned.",
  decision:
    "Retail supply planning sets replenishment quantities by product and store.",
  action:
    "Compare Returned units and a single stock snapshot before changing replenishment.",
  related: [
    retail(
      "Returned units",
      "Returned units offsets the physical units customers keep, but the two dates may describe different cohorts.",
    ),
    retail(
      "Units on hand",
      "Sales draw down stock, while replenishment can reverse that relationship.",
    ),
  ],
});
add("Retail", "Gross margin", "retail", {
  tier: "guardrail",
  importance: "high",
  why: "The money left after goods cost shows whether store sales growth retains contribution.",
  use: "Compare goods margin within a single currency alongside sales and discounting.",
  avoid:
    "Do not call it operating profit or use the unfiltered mixed-currency sum as a monetary total.",
  caveat: MIXED,
  decision:
    "Retail operations reviews promotions that increase sales but dilute the margin amount.",
  action:
    "Compare Gross sales, Net sales and cost before changing discount limits.",
  related: [
    retail(
      "Net sales",
      "Sales contribute to margin after goods cost is deducted.",
    ),
    retail(
      "Gross margin %",
      "The percentage explains the retained share behind the margin amount.",
    ),
  ],
});
add("Retail", "Gross margin %", "retail", {
  tier: "guardrail",
  importance: "high",
  why: "The margin share shows dilution that can be hidden by higher store revenue.",
  use: "Compare margin shares within one currency and explain changes alongside the margin amount.",
  avoid:
    "Do not assume a ratio makes mixed-currency inputs comparable; filter one currency first.",
  caveat: MIXED,
  decision:
    "Retail operations reviews whether the product and promotion mix retains enough goods margin.",
  action:
    "Inspect discounts and product mix before judging store performance from the percentage alone.",
  related: [
    retail(
      "Gross margin",
      "The amount can grow while its share of revenue falls.",
    ),
    retail("Net sales", "Net sales is the denominator of the margin ratio."),
  ],
});
add("Retail", "Returned units", "retail", {
  tier: "guardrail",
  direction: "lower_is_better",
  why: "Returned quantities signal reverse-logistics workload and product issues.",
  use: "Plan returns handling by product and store using the return date.",
  avoid:
    "Do not subtract period returns from period sales as a cohort return rate: some returns belong to earlier purchases.",
  caveat:
    "The Returns table records return dates; Order lines records purchase dates.",
  decision:
    "Customer operations prioritizes return handling and quality investigations.",
  action:
    "Inspect the affected products and purchase cohorts before changing replenishment or quality controls.",
  related: [
    retail(
      "Units",
      "Sales and returns use different event dates, so a period ratio needs care.",
    ),
    retail(
      "Refunds",
      "More returned units can raise refunds, but product prices change the amount per unit.",
    ),
  ],
});
add("Retail", "Refunds", "retail", {
  tier: "guardrail",
  direction: "lower_is_better",
  why: "Refund value captures the monetary side of returns that unit counts miss.",
  use: "Compare refund amounts in a single currency and identify costly returned products.",
  avoid:
    "Do not infer a cohort refund rate by dividing return-date refunds by purchase-date sales.",
  caveat:
    "Match currency and date meaning before comparing refunds with sales; returns may be for an earlier period's purchases.",
  decision:
    "Customer operations prioritizes return causes with a high refund cost.",
  action:
    "Compare Returned units and the product mix to separate more returns from more expensive returned items.",
  related: [
    retail(
      "Returned units",
      "Refunds can rise with flat returned units when more expensive goods are returned.",
    ),
    retail(
      "Net sales",
      "Sales are recorded before returns; refunds explain a deduction that Net sales omits.",
    ),
  ],
});
add("Retail", "Return rate", "retail", {
  tier: "guardrail",
  importance: "high",
  direction: "lower_is_better",
  why: "The model's returned-unit ratio can flag pressure on store returns handling.",
  use: "Screen products for further returns investigation with both date populations stated.",
  avoid:
    "Do not interpret it as the share of this period's purchases eventually returned; return and sale dates differ.",
  caveat:
    "A period can contain returns of older purchases, and the denominator is units rather than lines.",
  decision:
    "Customer operations chooses products whose return cohorts need investigation.",
  action:
    "Inspect Returned units and Units separately, then align purchase cohorts before setting a target.",
  related: [
    retail(
      "Returned units",
      "Returned units is the numerator, so more returns raise the ratio at fixed sales units.",
      "same",
    ),
    retail(
      "Units",
      "Units is the denominator, so more sold units lower the ratio at fixed returns.",
      "opposite",
    ),
  ],
});
add("Retail", "Units on hand", "retail/stock", {
  tier: "guardrail",
  importance: "high",
  dimensions: ["Store", "Product", "Stock snapshot"],
  why: "A stock level helps balance product availability against overstock.",
  use: "Review available units for one stock snapshot by store and product.",
  avoid:
    "Do not add snapshots together or treat the result as units available today.",
  caveat:
    "The measure sums every snapshot selected; January and February together count the same stock positions twice.",
  decision:
    "Supply planning decides which store-product positions need replenishment or stock reduction.",
  action:
    "Select one snapshot, then compare unit demand and Stock value before transferring or buying stock.",
  related: [
    retail(
      "Units",
      "Recent unit demand gives context to a stock level; stock alone says nothing about sales speed.",
    ),
    retail(
      "Stock value",
      "Stock value also depends on product cost, so its movement can differ from physical stock.",
    ),
  ],
});
add("Retail", "Stock value", "retail/stock", {
  tier: "guardrail",
  dimensions: ["Store", "Product", "Stock snapshot"],
  why: "Stock at cost identifies capital tied up in inventory beyond the physical unit count.",
  use: "Compare inventory cost by store and product at one stock snapshot.",
  avoid:
    "Do not treat it as retail selling value or sum it across snapshot dates.",
  caveat:
    "It adds all selected snapshot rows; multiple counts overstate stock at a single moment.",
  decision:
    "Retail operations prioritizes slow stock with a high carrying value for transfer or clearance.",
  action:
    "Confirm the snapshot and compare Units on hand with recent unit demand before acting.",
  related: [
    retail(
      "Units on hand",
      "Value equals units weighted by product cost, so costly products can dominate it.",
    ),
    retail(
      "Units",
      "Sales demand helps distinguish useful inventory from stock tying up capital.",
    ),
  ],
});
diagnostic(
  "Retail",
  "Weeks of cover",
  "retail/stock",
  "The DAX reads an unaggregated stock column and errors; adding SUM would still yield 13 because it uses no sales demand.",
  "Document and reproduce the broken cover calculation before the model owner replaces it.",
  ["Retail", "Units on hand"],
  ["Retail", "Units"],
);
add("Retail", "Budget", "retail", {
  importance: "high",
  dimensions: ["Store", "Calendar month"],
  why: "The agreed store-month plan gives the sales result a target to compare against.",
  use: "Compare planned store sales by Month or Quarter from the Month table.",
  avoid:
    "Do not use a Date-only filter for budget; it does not reach this table.",
  caveat:
    "Budget is monthly while sales are daily; align month and currency before comparing them.",
  decision:
    "Retail operations reviews store plans and explains gaps to the agreed monthly budget.",
  action:
    "Check that Month filters reach both sides, then investigate the stores contributing to the gap.",
  related: [
    retail(
      "Net sales",
      "Actual sales need the same month and currency basis as the plan.",
    ),
    retail(
      "Net sales vs budget",
      "Increasing Budget lowers the variance when actual sales stay fixed.",
      "opposite",
    ),
  ],
});
add("Retail", "Net sales vs budget", "retail", {
  importance: "high",
  dimensions: ["Store", "Calendar month", "Currency"],
  why: "A reconciled actual-minus-plan amount shows where store trading is missing its target.",
  use: "Compare actual and budget for matching stores and Month selections, after resolving currency units.",
  avoid:
    "Do not act on a daily-filtered or mixed-currency variance; it can compare incompatible totals.",
  caveat:
    "Budget is filtered by Month, not Date, and Net sales adds native currencies.",
  decision:
    "Retail operations chooses stores requiring a trading plan review after the variance is reconciled.",
  action:
    "Inspect actual and budget separately and fix month or currency mismatch before explaining performance.",
  related: [
    retail(
      "Net sales",
      "More actual sales raises the variance at a fixed budget.",
      "same",
    ),
    retail(
      "Budget",
      "A larger budget lowers the variance at fixed sales.",
      "opposite",
    ),
  ],
});
add("Retail", "Customers", "retail", {
  tier: "driver",
  dimensions: ["Store", "Product"],
  why: "Distinct buying customers separate customer reach from repeat-order frequency.",
  use: "Compare the number of customers who purchased in each store and period.",
  avoid:
    "Do not treat summed customer counts across stores as a distinct company total.",
  caveat:
    "A customer can purchase in several stores or periods; distinct counts are not additive.",
  decision:
    "Retail operations decides whether an order change calls for acquisition or repeat-purchase work.",
  action:
    "Compare Orders per customer and New customers before choosing a campaign.",
  related: [
    retail(
      "Orders",
      "Orders can grow without customer growth when existing buyers purchase more frequently.",
    ),
    retail(
      "New customers",
      "New customers explains one part of the customer population; returning buyers explain the rest.",
    ),
  ],
});
add("Retail", "New customers", "retail", {
  tier: "driver",
  dimensions: ["Store", "Product"],
  why: "First-purchase customers indicate acquisition alongside the existing customer base.",
  use: "Count customers whose first-order flag falls in the selected purchase period.",
  avoid:
    "Do not attribute new customers to advertising without an attribution model.",
  caveat:
    "The flag belongs to a customer's first order; the measure does not identify the source that acquired them.",
  decision:
    "Retail operations evaluates whether customer growth comes from new buyers or repeat activity.",
  action:
    "Compare all Customers and Orders, then inspect first-order cohorts before allocating acquisition spend.",
  related: [
    retail(
      "Customers",
      "New customers is a subset of the buying-customer population under matching filters.",
    ),
    retail(
      "Orders",
      "First orders contribute to order volume, while later orders do not increase this count.",
    ),
  ],
});
for (const [measure, issue, use] of [
  [
    "Selected currency",
    "This text helper returns a currency name for one selection but the code EUR for none or several; it does not convert any money.",
    "Check the currency caption shown on the report.",
  ],
  [
    "Report title",
    "This is report-label text describing the selected months, not a numerical performance measure.",
    "Check that a report's title matches the months actually selected.",
  ],
]) {
  if (!measure || !issue || !use)
    throw new Error("Incomplete sample helper documentation");
  diagnostic(
    "Retail",
    measure,
    "retail",
    issue,
    use,
    ["Retail", "Net sales"],
    ["Retail", "Budget"],
  );
}

/** These base measures share a metric after the sample's intentional merge. */
const SHARED: Record<string, MeasureRef> = {
  "Finance/Revenue": ["Sales", "Net sales"],
  "Marketing/Net Sales": ["Sales", "Net sales"],
  "Marketing/Orders": ["Sales", "Orders"],
  "Marketing/Order lines": ["Sales", "Order lines"],
};
export function readingContent(reference: MeasureRef): Entry {
  const key = measureKey(reference);
  const content = READING_CONTENT.get(measureKey(SHARED[key] ?? reference));
  if (!content)
    throw new Error(
      `Write reading-page documentation for sample measure ${key}.`,
    );
  return content;
}

export const READING_TERMS = [
  {
    name: "Calendar date",
    definition:
      "The day used by a measure's active date relationship. Sales uses order date; returns and stock may use other event dates.",
    group: "Dimensions",
  },
  {
    name: "Calendar month",
    definition:
      "A month selected from Retail's Month table. Its filters reach both the monthly budget and daily sales; a Date-only filter does not reach the budget.",
    group: "Dimensions",
  },
  {
    name: "Product",
    definition:
      "The item sold or held in stock. Product names and keys belong to their dataset, so join or compare them only with a verified mapping.",
    group: "Dimensions",
  },
  {
    name: "Store",
    definition:
      "The Retail store assigned to an order, return, budget row or stock snapshot.",
    group: "Dimensions",
  },
  {
    name: "Currency",
    definition:
      "The monetary unit. Finance's selected currency translates revenue; Retail's currency selection filters native amounts and does not convert them.",
    group: "Dimensions",
  },
  {
    name: "Device",
    definition:
      "The device recorded for Marketing web sessions. It filters sessions without filtering the sales-order numerator.",
    group: "Dimensions",
  },
  {
    name: "Stock snapshot",
    definition:
      "The date on which Retail stock was counted. Select one snapshot when reading stock levels or value.",
    group: "Dimensions",
  },
];
