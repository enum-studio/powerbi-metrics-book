/**
 * The sample book's documentation, as the sample company's curators would
 * write it: every dataset, table, column and measure of the invented sample
 * tenant (packages/powerbi-mock/src/sample/tenant.ts), keyed by name and read
 * from the model's DAX and rows. `seedSampleDocs` in book.ts writes each field
 * while it is still empty. A table in several datasets has the same text in
 * each, unless the dataset changes what is true of it.
 */

type Unit = "money" | "count" | "quantity" | "rate" | "ratio" | "duration";
export type ColumnDocs = {
  description: string;
  unit?: Unit;
  blank_means?: string;
  /** Why a numeric column has no unit: the seed files it as an exception to column_fields.unit. */
  no_unit?: string;
};

const IDENTIFIER = "An identifier, not an amount: no unit fits.";
const DATE_PART = "A part of the date, not an amount: no unit fits.";
export type TableDocs = {
  description: string;
  grain_and_filters: string;
  caveats?: string;
  columns: Record<string, ColumnDocs>;
  measures?: Record<string, string>;
};
export type DatasetDocs = {
  description: string;
  when_to_use: string;
  owner: string;
  freshness: string;
  caveats?: string;
  tables: Record<string, TableDocs>;
};

/** Sales lines, the same import in Sales, Finance and Marketing: `joined` names the tables its keys reach in `dataset`. */
function salesLines(
  dataset: string,
  joined: ("Product" | "Customer" | "Channel")[],
  caveats: string,
  measures: Record<string, string>,
): TableDocs {
  const key = (table: "Product" | "Customer" | "Channel", thing: string) => ({
    description: joined.includes(table)
      ? `Hidden key of the ${thing}. It joins ${table}[${table} key].`
      : `Hidden key of the ${thing}. It joins nothing in ${dataset}, which has no ${table} table.`,
  });
  return {
    description:
      "The order lines of every order, from all four channels: Web, Store, Marketplace and Phone.",
    grain_and_filters:
      "One row per order line: 2,938 lines of 1,515 orders, placed from 1 January 2024 to 30 September 2026. Every channel and every line is here, returned or not.",
    caveats,
    columns: {
      "Order id": {
        description:
          "The order's number, 100001 to 101515. All lines of one order share it, so count orders with DISTINCTCOUNT.",
        no_unit: IDENTIFIER,
      },
      "Order line": {
        description: "The line's number within its order: 1, 2 or 3.",
        no_unit: IDENTIFIER,
      },
      Date: {
        description:
          "The day the order was placed. It joins Date[Date], so every date filter reads it.",
      },
      "Ship date": {
        description:
          dataset === "Sales"
            ? "The day the order shipped, one to four days after it was placed. Its relationship to Date is inactive: count by ship date with USERELATIONSHIP('Sales lines'[Ship date], 'Date'[Date])."
            : `The day the order shipped, one to four days after it was placed. It joins nothing in ${dataset}, so a date filter never reads it.`,
      },
      "Product key": key("Product", "product sold"),
      "Customer key": key("Customer", "customer who ordered"),
      "Channel key": key("Channel", "channel the order came through"),
      Quantity: {
        description: "Units of the product on the line, 1 to 4.",
        unit: "quantity",
      },
      "Gross amount": {
        description:
          "The product's list price times the quantity, before discount, in EUR.",
        unit: "money",
      },
      "Discount amount": {
        description:
          "The discount on the line, in EUR. About three lines in ten get 10% off the gross amount; the rest show 0.",
        unit: "money",
      },
      "Net amount": {
        description:
          "Gross amount less discount, in EUR. Returned lines still count: returns are not deducted.",
        unit: "money",
      },
      "Cost amount": {
        description:
          "What the goods on the line cost, in EUR: 55% of the gross amount, so a discount lowers the margin and not the cost.",
        unit: "money",
      },
      "Is returned": {
        description:
          "True when the customer sent the line back. About one line in twenty.",
      },
    },
    measures,
  };
}

/** The calendar table, the same DAX in Sales, Finance and Marketing; `joined` says which dates join it there. */
const date = (joined: string): TableDocs => ({
  description:
    "The calendar: one row per day from 1 January 2024 to 31 December 2026, built in DAX with CALENDAR.",
  grain_and_filters:
    "One row per day: 1,096 days. Every day is here, with or without orders.",
  caveats:
    "The calendar runs to 31 December 2026, but orders stop on 30 September 2026, so later months show no sales. Date last year, Date last month and Date last week go back in whole weeks, not calendar months or years.",
  columns: {
    Date: { description: `The day, one row each. ${joined}` },
    Year: {
      description:
        "The calendar year, 2024 to 2026. It sits in the Fiscal display folder, but the model has no fiscal year: this is the calendar's.",
      no_unit: DATE_PART,
    },
    Quarter: {
      description:
        "The calendar quarter as text, such as 2025 Q3. Like Year, it sits in the Fiscal folder and follows the calendar.",
    },
    Month: {
      description:
        "The month as text, such as 2025-03. It sorts in date order.",
    },
    "Month name": {
      description:
        "The month's name, such as March. It holds no year, so March of every year falls together.",
    },
    "Is weekend": { description: "True on Saturdays and Sundays." },
    "Date last year": {
      description:
        "The same weekday 52 weeks earlier: the date less 364 days. In 2024 it falls in 2023, before the calendar starts.",
    },
    "Date last month": {
      description:
        "The same weekday four weeks earlier: the date less 28 days, not the same day of the month before.",
    },
    "Date last week": { description: "The date less 7 days." },
  },
});

function channel(joined: string, caveats?: string): TableDocs {
  return {
    description: "The channels an order comes through, one row each.",
    grain_and_filters:
      "One row per channel: Web, Store, Marketplace and Phone.",
    ...(caveats === undefined ? {} : { caveats }),
    columns: {
      "Channel key": {
        description: `Hidden key of the channel. ${joined} join here.`,
      },
      Channel: {
        description: "The channel's name: Web, Store, Marketplace or Phone.",
      },
    },
  };
}

const CIRCLE =
  "Target, Stretch target and Target gap refer to one another in a circle, so Power BI cannot evaluate any of them.";

export const DOCS: Record<string, DatasetDocs> = {
  Sales: {
    description:
      "Every order from the web shop, the stores, the marketplace and the phone line, from January 2024 to September 2026. One row per order line, with products, customers and a calendar.",
    when_to_use:
      "Use it for what was sold: net sales, orders, units and return rates by day, product, customer region and channel. For revenue and margin as Finance reports them, use Finance. For ad spend and web visits, use Marketing. For stores, stock and budget, use Retail.",
    owner: "Commercial analytics",
    freshness:
      "Refreshed every day at 06:00, with orders up to the end of the day before.",
    caveats:
      "Sales lines[Ship date] to Date is inactive, so shipped views need USERELATIONSHIP. Some measures do not shift as their names say: Order lines LQ goes back 28 days, Order lines held does not go back at all, and Units sold LY takes the whole previous year.",
    tables: {
      "Sales lines": salesLines(
        "Sales",
        ["Product", "Customer", "Channel"],
        "Ship date's relationship to Date is inactive, so a date filter reads the order date unless a measure says otherwise.",
        {
          "Order lines": "The number of order lines.",
          "Order lines LM":
            "Order lines in the period moved back 28 days, through Date last month. A month back here is four weeks, not a calendar month.",
          "Order lines LW":
            "Order lines in the period moved back 7 days. It shows 0, not blank, when there were none.",
          "Order lines LY":
            "Order lines in the same period one year earlier. Its DAX checks the selected channel, but both branches go back one calendar year, so the check changes nothing.",
          "Order lines LY zero":
            "Order lines in the same period one year earlier, showing 0, not blank, when there were none.",
          "Order lines LQ":
            "Order lines in the period moved back 28 days, not a quarter: its DAX goes back through Date last month, as Order lines LM does.",
          "Web order lines LM":
            "Order lines of the Web channel, in the period moved back 28 days.",
          "Order lines held":
            "The order lines of the period in view, not of a year earlier. The DAX stores Order lines in a variable before the year shift, and a stored value does not change, so the shift does nothing.",
          "Order lines MoM":
            "The change in Order lines against Order lines LM, four weeks earlier, as a share of Order lines LM.",
          "Order lines WoW":
            "The change in Order lines against Order lines LW, a week earlier, as a share of Order lines LW. It shows 0 when there is nothing to compare.",
          "Order lines YoY":
            "The change in Order lines against Order lines LY, as a share of Order lines LY. Blank when there were no order lines a year earlier.",
          "Net sales":
            "The net amount of the order lines, in EUR: gross amount less discount, before returns.",
          Orders: "The number of distinct orders.",
          "Units sold": "The sum of Quantity, returned lines included.",
          "Average order value":
            "Net sales divided by Orders: what one order is worth on average, in EUR.",
          "Average order value LY":
            "Net sales LY divided by Orders PY. The two cover different dates: net sales the same days a year back, orders the whole months a year back, so for part of a month it comes out too low.",
          "Units per order":
            "Units sold divided by Orders. It shows 0, not blank, when there are no orders.",
          "Units per order PM":
            "Units per order one month earlier: Units sold PM divided by Orders PM, 0 when there were no orders.",
          "Return rate":
            "The share of order lines marked Is returned, by the day they were ordered. It counts lines, not units or money.",
          "Net sales LY": "Net sales in the same period one year earlier.",
          "Net sales YTD": "Net sales from 1 January to the last day in view.",
          "Net sales QTD":
            "Net sales from the first day of the quarter to the last day in view.",
          "Net sales MTD":
            "Net sales from the first of the month to the last day in view.",
          "Net sales LY YTD":
            "Net sales YTD one year earlier: from 1 January last year to the same day last year.",
          "Web net sales LY":
            "Net sales of the Web channel in the same period one year earlier.",
          "Orders PY":
            "Orders in the same months one year earlier. PARALLELPERIOD takes whole months, so for part of a month it counts the full month a year back.",
          "Orders PM": "Orders in the period moved back one month.",
          "Units sold LY":
            "Units sold in the whole previous calendar year. PARALLELPERIOD by a year takes every day of that year, whatever month is in view.",
          "Units sold PM": "Units sold in the period moved back one month.",
          "Net sales vs LY": "Net sales less Net sales LY, in EUR.",
          "Net sales growth":
            "The change in Net sales against Net sales LY, as a share of Net sales LY.",
          "Orders YoY %":
            "Orders divided by Orders PY, less 1: the change as a share. It shows -100%, not blank, when there were no orders a year earlier.",
          "Orders index vs PY":
            "Orders divided by Orders PY: 1.10 means 10% more orders than a year earlier.",
          "_Report title":
            "A title for report pages that names the months in view, such as Net sales, Jan 2025 to Dec 2025. Text, not a number.",
        },
      ),
      Product: {
        description:
          "The products sold, one row each, with category, list price and weight.",
        grain_and_filters:
          "One row per product: 12 products, Product 01 to Product 12.",
        columns: {
          "Product key": {
            description:
              "Hidden key of the product. Sales lines[Product key] joins here.",
          },
          Product: {
            description: "The product's name, Product 01 to Product 12.",
          },
          Category: {
            description:
              "The product's category: Outerwear, Footwear, Accessories or Home.",
          },
          "List price": {
            description:
              "The price of one unit before discount, in EUR, from 23.45 to 116.95. Gross amount is this price times the quantity.",
            unit: "money",
          },
          "Weight (kg)": {
            description: "The weight of one unit in kilograms, 0.2 to 4.05.",
            unit: "quantity",
          },
          Image: {
            description:
              "Hidden. Meant for a product photo, but no product has one.",
            blank_means:
              "No image has been loaded. It is blank for every product.",
          },
        },
      },
      Customer: {
        description:
          "The customers who placed orders, one row each, with region and segment.",
        grain_and_filters:
          "One row per customer: 200 customers, Customer 001 to Customer 200.",
        columns: {
          "Customer key": {
            description:
              "Hidden key of the customer. Sales lines[Customer key] joins here.",
          },
          Customer: {
            description: "The customer's name, Customer 001 to Customer 200.",
          },
          Region: {
            description:
              "The customer's sales region: North, South, East or West.",
          },
          Segment: {
            description:
              "Consumer or Business. About four customers in five are Consumer.",
          },
        },
      },
      Date: date(
        "Sales lines[Date] joins here, and Sales lines[Ship date] by an inactive relationship.",
      ),
      Channel: channel("Sales lines[Channel key] joins"),
    },
  },
  Finance: {
    description:
      "Revenue, gross margin and targets for the leadership group, from the same order lines as Sales, with a picker for the currency.",
    when_to_use:
      "Use it for revenue and margin as Finance reports them to leadership, and for revenue in US dollars or another currency. For orders, units, products and channels, use Sales. For stores and budget, use Retail.",
    owner: "Financial planning and analysis",
    freshness:
      "Refreshed every day at 07:00, an hour after Sales, from the same order lines.",
    caveats: `Row-level security is on: each person sees only the rows their role allows, so two people can get different totals, and Power BI refuses queries from a service principal. Exchange rate is disconnected: it feeds the currency picker and joins no table. ${CIRCLE}`,
    tables: {
      "Sales lines": salesLines(
        "Finance",
        [],
        "Only Date is related here. Product key, Customer key and Channel key join nothing, and Ship date has no relationship.",
        {
          Revenue:
            "The net amount of the order lines, in EUR: gross amount less discount, before returns. The same calculation as Net sales in Sales.",
          "Order count":
            "The number of distinct orders: the same result as Orders in Sales.",
          "Gross margin":
            "Net amount less cost amount, in EUR. Returned lines count as sold.",
          "Gross margin %": "Gross margin as a share of Revenue.",
          "Revenue PY": "Revenue in the same period one year earlier.",
          "Revenue PQ": "Revenue in the period moved back one quarter.",
          "Revenue YTD": "Revenue from 1 January to the last day in view.",
          "Revenue PY YTD":
            "Revenue YTD one year earlier: from 1 January last year to the same day last year.",
          "Gross margin QTD":
            "Gross margin from the first day of the quarter to the last day in view.",
          "Gross margin MTD":
            "Gross margin from the first of the month to the last day in view.",
          "Gross margin PY":
            "Gross margin in the same period one year earlier.",
          "Gross margin PQ":
            "Gross margin in the period moved back one quarter.",
          "Gross margin % PY":
            "Gross margin % in the same period one year earlier: Gross margin PY divided by Revenue PY.",
          "Gross margin % PQ":
            "Gross margin % one quarter earlier: Gross margin PQ divided by Revenue PQ. It shows 0, not blank, when that quarter had no revenue.",
          "Gross margin % on PY margin":
            "Last year's Gross margin divided by this period's Revenue. It mixes two periods, so it is not last year's Gross margin %: that is Gross margin % PY.",
          "Gross margin points PY":
            "Gross margin % PY times 100, such as 45 for 45%. Its format adds a percent sign as well, so it shows 100 times too large, as 4500.0%.",
          "Gross margin % vs PY":
            "Gross margin % less Gross margin % PY: the change in percentage points.",
          Target: `Meant as 90% of Stretch target. ${CIRCLE}`,
          "Stretch target": `Meant as Target gap plus Revenue. ${CIRCLE}`,
          "Target gap": `Meant as Target less Revenue. ${CIRCLE}`,
        },
      ),
      Date: date("Sales lines[Date] joins here."),
      "Exchange rate": {
        description:
          "What one euro buys in each currency, one row per currency. It is also the currency picker on Finance's pages.",
        grain_and_filters:
          "One row per currency: EUR, USD, GBP and SEK. One fixed rate each, with no date, so past rates are not kept.",
        caveats:
          "Disconnected: no relationship joins it. Picking a currency changes only the measures that read the picker, such as Revenue in selected currency.",
        columns: {
          Currency: {
            description:
              "The currency's code: EUR, USD, GBP or SEK. Picking one sets the currency of Revenue in selected currency.",
          },
          Rate: {
            description:
              "Units of the currency for one euro: 1 for EUR, 1.08 for USD, 0.86 for GBP and 11.2 for SEK.",
            unit: "ratio",
          },
        },
        measures: {
          "Revenue USD":
            "Revenue in US dollars: each line's net amount times the USD rate, 1.08. It ignores the currency picker.",
          "Revenue in selected currency":
            "Revenue in the currency picked in Exchange rate[Currency]. With none or several picked, it stays in euros.",
          "_Currency format":
            "Hidden helper: the format string for the picked currency, such as #,0.00 USD. A dynamic format string reads it; it is not a number to report.",
        },
      },
    },
  },
  Marketing: {
    description:
      "Ad spend by week and paid channel, web shop visits by day and device, and the order lines they are judged against, from January 2024 to September 2026.",
    when_to_use:
      "Use it for marketing questions: ad spend, cost per click, return on ad spend, sessions and conversion. For sales by product or customer, use Sales: Marketing has neither table. For campaigns before 2024, see Campaign archive.",
    owner: "Growth marketing",
    freshness:
      "Refreshed every day at 08:00. Web sessions arrive a day behind, and ad spend once a week, dated on the week's Monday.",
    caveats:
      "Ad spend to Channel filters both ways, so a filter on Ad spend, such as a campaign, also narrows Sales lines through Channel. The model refuses Power BI's INFO views, so the book cannot read its relationships: Sales lines, Ad spend and Web sessions join Date on their dates, and Sales lines and Ad spend join Channel. Conversion rate counts orders from every channel against web visits alone.",
    tables: {
      "Sales lines": salesLines(
        "Marketing",
        ["Channel"],
        "Only Date and Channel are related here. Product key and Customer key join nothing, and Ship date has no relationship.",
        {
          "Net Sales":
            "The net amount of the order lines, in EUR, before returns: the same calculation as Net sales in Sales. It shows whole euros.",
          Orders: "The number of distinct orders, from every channel.",
          "Order lines": "The number of order lines.",
          "Conversion rate":
            "Orders divided by Sessions. Orders count every channel, stores and phone included, while Sessions count web shop visits only. Filter Channel to Web for the web shop's own rate.",
        },
      ),
      "Ad spend": {
        description:
          "What was spent on paid ads, per week, paid channel and campaign.",
        grain_and_filters:
          "One row per week and paid channel: Web and Marketplace, from the week of 1 January 2024 to the week of 28 September 2026. Store and Phone have no ad spend.",
        caveats:
          "Spend is dated on the week's Monday, so a date filter counts a week only when its Monday is inside. Its relationship to Channel filters both ways: a filter here, such as Campaign, also narrows Channel and, through it, Sales lines.",
        columns: {
          "Week start": {
            description: "The Monday the week starts on. It joins Date[Date].",
          },
          "Channel key": {
            description:
              "Hidden key of the paid channel. It joins Channel[Channel key] in both directions. Only Web (1) and Marketplace (3) appear.",
          },
          Campaign: {
            description:
              "The campaign that ran that week: Campaign A, B or C, in turn, one week each.",
          },
          Spend: {
            description:
              "What the week's ads on the channel cost, in EUR, 400 to 1,000.",
            unit: "money",
          },
          Clicks: {
            description: "Clicks on the ads that week on that channel.",
            unit: "count",
          },
          Impressions: {
            description:
              "Times the ads were shown that week on that channel: 40 to 60 for each click.",
            unit: "count",
          },
        },
        measures: {
          "Ad spend": "What was spent on ads, in EUR.",
          "Ad spend LY":
            "Ad spend in the period moved back 365 days. From 1 March 2024 to 28 February 2025 that lands a day after the same date a year earlier, because of 29 February 2024.",
          "Cost per click":
            "Ad spend divided by clicks: what one click cost, in EUR.",
          "Return on ad spend":
            "Net Sales divided by Ad spend: euros of net sales for each euro spent on ads. Net Sales counts every order in the filter, not only orders an ad brought.",
        },
      },
      "Web sessions": {
        description:
          "Visits to the web shop per day and device, from the analytics tool.",
        grain_and_filters:
          "One row per day and device, Desktop or Mobile, from 1 January 2024 to 30 September 2026.",
        caveats:
          "Bounce rate is a ratio for one row. Adding or averaging it over days gives a wrong rate: divide Bounced sessions by Session count instead.",
        columns: {
          Date: {
            description: "The day of the visits. It joins Date[Date].",
          },
          Device: { description: "The device type: Desktop or Mobile." },
          "Session count": {
            description: "Visits that day on that device, 200 to 500.",
            unit: "count",
          },
          "Bounced sessions": {
            description:
              "Visits that left after the first page, 30% to 50% of the row's visits.",
            unit: "count",
          },
          "Bounce rate": {
            description:
              "Bounced sessions divided by Session count, for the row's day and device. A calculated column.",
            unit: "rate",
          },
        },
        measures: {
          Sessions: "Visits to the web shop: the sum of Session count.",
          "Sessions yesterday":
            "Sessions in the period moved back one day. For one day that is the day before; for a longer period, the same number of days ending a day earlier.",
        },
      },
      Date: date(
        "Sales lines[Date], Ad spend[Week start] and Web sessions[Date] join here.",
      ),
      Channel: channel(
        "Sales lines[Channel key] and Ad spend[Channel key]",
        "Ad spend filters this table both ways, so a filter on Ad spend narrows the channels and, through them, Sales lines.",
      ),
    },
  },
  "Campaign archive": {
    description:
      "Paid campaigns from the years before Marketing's ad spend begins in January 2024.",
    when_to_use:
      "To look back at campaigns before 2024, once the model has been refreshed. For ad spend from 2024 on, use Marketing.",
    owner: "Growth marketing",
    freshness:
      "Never refreshed since it was published, as a DirectQuery model.",
    caveats:
      "Power BI cannot read its schema because the model has never been refreshed, so the book lists no tables, columns or measures for it, and an agent has nothing to write DAX against.",
    tables: {},
  },
  Retail: {
    description:
      "Orders, returns, stock and budget of four stores from January to March 2026, with products, brands, customers and regions.",
    when_to_use:
      "Use it for store questions: sales against budget, stock, returns by reason, brands and new customers. For order trends from 2024 and sales by channel, use Sales. For revenue and margin as Finance reports them, use Finance.",
    owner: "Retail analytics",
    freshness:
      "Refreshed every day at 06:30. Stock is counted on the first of each month, and the budget is set per month.",
    caveats:
      "Row-level security is on: each person sees only the rows their role allows, so two people can get different totals, and Power BI refuses queries from a service principal. Order amounts are in the order's own currency, and Net sales, Gross sales and Gross margin add them as they are; Net amount EUR is the converted column. Budget joins Month, not Date. Ship date to Date and Customer to Region are inactive, and Exchange rate to Currency filters both ways.",
    tables: {
      "Order lines": {
        description:
          "The order lines of the four stores, in the currency each order was paid in.",
        grain_and_filters:
          "One row per order line: 29 lines of 14 orders, placed from 7 January to 26 March 2026. Every line is here, returned or not.",
        caveats:
          "Amounts are in the order's currency, EUR, USD or SEK; only Net amount EUR is converted. Ship date's relationship to Date is inactive.",
        columns: {
          "Order id": {
            description:
              "The order's number, 5001 to 5014. All lines of one order share it.",
            no_unit: IDENTIFIER,
          },
          Line: {
            description: "The line's number within its order, 1 to 3.",
            no_unit: IDENTIFIER,
          },
          "Order date": {
            description:
              "The day the order was placed. It joins Date[Date], so every date filter reads it.",
          },
          "Ship date": {
            description:
              "The day the order shipped, two days after it was placed. Its relationship to Date is inactive: count by ship date with USERELATIONSHIP('Order lines'[Ship date], 'Date'[Date]).",
          },
          "Product key": {
            description:
              "Hidden key of the product sold. It joins Product[Product key].",
          },
          "Customer key": {
            description:
              "Hidden key of the customer who ordered. It joins Customer[Customer key].",
          },
          "Store key": {
            description:
              "Hidden key of the store the order belongs to. It joins Store[Store key].",
          },
          "Currency code": {
            description:
              "Hidden key of the currency the order was paid in: EUR, USD or SEK. It joins Currency[Currency code].",
          },
          Quantity: {
            description: "Units of the product on the line, 1 to 3.",
            unit: "quantity",
          },
          "Gross amount": {
            description:
              "The list price times the quantity, before discount, in the order's currency.",
            unit: "money",
          },
          Discount: {
            description:
              "The discount on the line, in the order's currency: 10% of the gross amount when the order has a voucher, otherwise 0.",
            unit: "money",
          },
          "Net amount": {
            description:
              "Gross amount less discount, before tax, in the order's currency.",
            unit: "money",
          },
          "Net amount EUR": {
            description:
              "Net amount converted to euros at the order's exchange rate. Add this one up across currencies.",
            unit: "money",
          },
          Cost: {
            description:
              "What the goods on the line cost, in the order's currency: 55% of the gross amount.",
            unit: "money",
          },
          Tax: {
            description:
              "Sales tax on the line, in the order's currency: 20% of the net amount.",
            unit: "money",
          },
          "Is first order": {
            description:
              "True on every line of a customer's first order. Orders 5001 to 5008 are first orders.",
          },
          "Voucher code": {
            description:
              "The voucher used on the order. SAMPLE10 is the only one, on every fourth order.",
            blank_means: "No voucher was used on the order.",
          },
          Device: {
            description:
              "The device the order was placed from: Phone, Desktop or Tablet.",
          },
        },
        measures: {
          "Net sales":
            "The sum of Net amount, before tax and returns. It adds euros, dollars and kronor as they are; for a total in euros, sum Net amount EUR instead.",
          "Gross sales":
            "The sum of Gross amount, before discount, adding the orders' currencies as they are.",
          Orders: "The number of distinct orders.",
          Units: "The sum of Quantity: units sold, returned or not.",
          "Order lines": "The number of order lines.",
          "Average order value":
            "Net sales divided by the number of orders, in the orders' mixed currencies.",
          "Gross margin":
            "Net amount less Cost, adding the orders' currencies as they are.",
          "Gross margin %": "Gross margin as a share of Net sales.",
          "Net sales LY":
            "Net sales in the same period one year earlier. Always blank here: the Date table and the orders cover only January to March 2026.",
          "Net sales YTD": "Net sales from 1 January to the last day in view.",
          "Net sales MTD":
            "Net sales from the first of the month to the last day in view.",
          "Orders LY":
            "Orders in the same period one year earlier. Always blank here, as Net sales LY is.",
        },
      },
      Returns: {
        description:
          "Goods customers sent back, with the reason and the refund.",
        grain_and_filters:
          "One row per return: 4 returns, from 29 January to 24 March 2026.",
        caveats:
          "A return has no order id, customer or store, so it cannot be matched to its order line, and a Store or Customer filter does not reach it. Its date is the day it came back, not the order date.",
        columns: {
          "Return id": {
            description: "The return's number, 900 to 903.",
            no_unit: IDENTIFIER,
          },
          "Return date": {
            description: "The day the goods came back. It joins Date[Date].",
          },
          "Product key": {
            description:
              "Hidden key of the product sent back. It joins Product[Product key].",
          },
          "Reason key": {
            description:
              "Hidden key of the reason given. It joins Return reason[Reason key].",
          },
          Units: {
            description: "Units sent back. Every return so far is one unit.",
            unit: "quantity",
          },
          "Refund amount": {
            description:
              "The money paid back: the list price of the unit returned.",
            unit: "money",
          },
        },
        measures: {
          "Returned units": "Units sent back, by the day they came back.",
          Refunds: "The money paid back for returns: the sum of Refund amount.",
          "Return rate":
            "Returned units divided by Units. Returns count by the day they came back and sales by the order date, so a period's rate can include returns of earlier orders. Sales' Return rate is another calculation: it counts lines marked returned.",
        },
      },
      Stock: {
        description:
          "Units in stock per product and store, counted on the first of each month.",
        grain_and_filters:
          "One row per product per stock count: 6 products, counted on 1 January and 1 February 2026, each in one store.",
        caveats:
          "Stock is a level at one moment, but Units on hand and Stock value add up every count in the filter. Over January and February together they count the stock twice, so filter to one Snapshot date.",
        columns: {
          "Snapshot date": {
            description:
              "The day the stock was counted: the first of the month. It joins Date[Date].",
          },
          "Product key": {
            description:
              "Hidden key of the product counted. It joins Product[Product key].",
          },
          "Store key": {
            description:
              "Hidden key of the store that holds it. It joins Store[Store key].",
          },
          "Units in stock": {
            description: "Units on hand when the stock was counted.",
            unit: "quantity",
          },
          Value: {
            description:
              "The stock at cost: the units times 55% of the list price.",
            unit: "money",
          },
        },
        measures: {
          "Units on hand":
            "Units in stock, added up over the filter. With more than one count in view, it adds them together.",
          "Stock value":
            "Stock at cost, added up over the filter. With more than one count in view, it adds them together.",
          "Weeks of cover":
            "Not a working cover figure. Its DAX divides Units on hand by the bare Units in stock column, which a measure cannot read without an aggregation, and multiplies by 13. It reads no sales, so even with SUM added it would always show 13.",
        },
      },
      Budget: {
        description: "The sales budget per store and month.",
        grain_and_filters:
          "One row per store and month: 4 stores, January to March 2026.",
        caveats:
          "Budget joins Month, not Date, so filter on Month[Month] or Month[Quarter]. A filter on the Date table does not reach it.",
        columns: {
          Month: {
            description:
              "The budget's month as text, such as 2026-01. It joins Month[Month].",
          },
          "Store key": {
            description:
              "Hidden key of the store the budget is for. It joins Store[Store key].",
          },
          Amount: {
            description:
              "The store's sales budget for the month, 1,500 to 2,450.",
            unit: "money",
          },
        },
        measures: {
          Budget: "The sales budget: the sum of Amount.",
          "Net sales vs budget":
            "Net sales less Budget. Budget is reached only through the Month table, so compare by month or quarter, and Net sales mixes the orders' currencies.",
        },
      },
      Date: {
        description:
          "Retail's calendar: one row per day from 1 January to 31 March 2026.",
        grain_and_filters: "One row per day: 90 days.",
        caveats:
          "It covers only the first quarter of 2026, so Net sales LY and Orders LY are always blank. Its Month column joins the Month table, as Budget does.",
        columns: {
          Date: {
            description:
              "The day, one row each. Order lines, Returns and Stock join here on their dates.",
          },
          Month: {
            description:
              "The month as text, such as 2026-02. It joins Month[Month].",
          },
          Year: {
            description: "The calendar year: 2026 on every row.",
            no_unit: DATE_PART,
          },
          Week: {
            description:
              "The week of the year in blocks of 7 days from 1 January, 1 to 13. It is not the ISO week: week 1 is 1 to 7 January.",
            no_unit: DATE_PART,
          },
          Weekday: { description: "The day's name, such as Monday." },
          "Is holiday": {
            description:
              "True on 1 January, the only day the calendar marks as a holiday.",
          },
        },
      },
      Month: {
        description:
          "The months of Retail's calendar, one row each, with name, quarter and year.",
        grain_and_filters: "One row per month: January to March 2026.",
        columns: {
          Month: {
            description:
              "The month as text, such as 2026-01. Budget and Date join here.",
          },
          "Month name": {
            description: "The month's name: January, February or March.",
          },
          Quarter: { description: "The quarter as text: 2026 Q1." },
          Year: { description: "The year: 2026.", no_unit: DATE_PART },
        },
      },
      Product: {
        description:
          "The products the stores sell, one row each, with brand, category, colour and size.",
        grain_and_filters:
          "One row per product: 6 products, SKU SMP-1001 to SMP-1006.",
        columns: {
          "Product key": {
            description:
              "Hidden key of the product. Order lines, Returns and Stock join here.",
          },
          "Brand key": {
            description:
              "Hidden key of the product's brand. It joins Brand[Brand key].",
          },
          "Category key": {
            description:
              "Hidden key of the product's category. It joins Category[Category key].",
          },
          SKU: {
            description:
              "The stock keeping unit code, SMP-1001 to SMP-1006: one per product.",
          },
          Product: {
            description:
              "The product's name, Retail product 01 to Retail product 06.",
          },
          Colour: {
            description: "The product's colour: Black, Sand or Green.",
          },
          Size: { description: "The product's size: S, M or L." },
          "List price": {
            description:
              "The price of one unit before discount, 31.90 to 91.90. Gross amount is this price times the quantity.",
            unit: "money",
          },
        },
      },
      Brand: {
        description: "The brands the stores sell, one row each.",
        grain_and_filters:
          "One row per brand: Northfield, Harbour and Pinewood.",
        columns: {
          "Brand key": {
            description:
              "Hidden key of the brand. Product[Brand key] joins here.",
          },
          Brand: { description: "The brand's name." },
          "Is own brand": {
            description:
              "True for the company's own label, Northfield. False for Harbour and Pinewood.",
          },
        },
      },
      Category: {
        description:
          "The product categories, each with the department it belongs to.",
        grain_and_filters:
          "One row per category: Jackets, in Outerwear, and Boots, in Footwear.",
        columns: {
          "Category key": {
            description:
              "Hidden key of the category. Product[Category key] joins here.",
          },
          Category: { description: "The category's name: Jackets or Boots." },
          Department: {
            description:
              "The department the category belongs to: Outerwear or Footwear.",
          },
        },
      },
      Customer: {
        description:
          "The customers who ordered, one row each, with contact details, segment and first order date.",
        grain_and_filters:
          "One row per customer: 8 customers, Retail customer 01 to Retail customer 08.",
        caveats:
          "Holds personal data: Email, Phone, Street address and Date of birth. Order lines do not filter it, so Customers and New customers count every customer whatever the date. Its relationship to Region is inactive.",
        columns: {
          "Customer key": {
            description:
              "Hidden key of the customer. Order lines[Customer key] joins here.",
          },
          "Region key": {
            description:
              "Hidden key of the customer's home region. It joins Region[Region key] by an inactive relationship, so a Region filter reaches customers only through USERELATIONSHIP.",
          },
          Customer: {
            description:
              "The customer's name, Retail customer 01 to Retail customer 08.",
          },
          Email: {
            description: "The customer's email address. Personal data.",
          },
          Phone: { description: "The customer's phone number. Personal data." },
          "Street address": {
            description: "The customer's street address. Personal data.",
          },
          "Date of birth": {
            description: "The customer's date of birth. Personal data.",
          },
          Segment: {
            description:
              "Consumer or Business. Two of the eight customers are Business.",
          },
          "First order date": {
            description: "The day of the customer's first order.",
          },
        },
        measures: {
          Customers:
            "The number of customers in Customer. A date or store filter does not reach this table, so it counts every customer, not only those who ordered in the period.",
          "New customers":
            "Meant as the customers whose first order is in view, but the first-order filter sits on Order lines and does not reach Customer. It returns the same number as Customers.",
        },
      },
      Store: {
        description:
          "The stores, one row each, with region, manager, format and opening date.",
        grain_and_filters:
          "One row per store: Sample store 1 to Sample store 4.",
        caveats: "Manager email is personal data.",
        columns: {
          "Store key": {
            description:
              "Hidden key of the store. Order lines, Stock and Budget join here.",
          },
          "Region key": {
            description:
              "Hidden key of the store's region. It joins Region[Region key].",
          },
          Store: { description: "The store's name." },
          "Manager email": {
            description:
              "The email address of the store's manager. Personal data.",
          },
          Format: { description: "The kind of store: High street or Outlet." },
          Opened: {
            description:
              "The day the store opened: 1 March of a year from 2015 to 2018.",
          },
        },
      },
      Region: {
        description:
          "The regions stores and customers belong to, each in one country.",
        grain_and_filters:
          "One row per region: North in Sweden, Central in Germany and South in Spain.",
        columns: {
          "Region key": {
            description:
              "Hidden key of the region. Store[Region key] joins here, and Customer[Region key] by an inactive relationship.",
          },
          Region: {
            description: "The region's name: North, Central or South.",
          },
          Country: {
            description:
              "The country the region is in: Sweden, Germany or Spain.",
          },
        },
      },
      "Return reason": {
        description: "The reasons customers give for sending goods back.",
        grain_and_filters:
          "One row per reason: Wrong size, Damaged and Changed mind.",
        columns: {
          "Reason key": {
            description:
              "Hidden key of the reason. Returns[Reason key] joins here.",
          },
          Reason: { description: "The reason given for the return." },
        },
      },
      Currency: {
        description: "The currencies orders are paid in.",
        grain_and_filters: "One row per currency: EUR, USD and SEK.",
        columns: {
          "Currency code": {
            description:
              "The currency's ISO code. Order lines and Exchange rate join here on it.",
          },
          Currency: {
            description:
              "The currency's name: Euro, US dollar or Swedish krona.",
          },
        },
      },
      "Exchange rate": {
        description:
          "What one euro buys in each currency orders are paid in, one row per currency.",
        grain_and_filters:
          "One row per currency: EUR, USD and SEK. One fixed rate each, with no date, so past rates are not kept.",
        caveats:
          "Its relationship to Currency filters both ways, so a filter here narrows Currency and, through it, Order lines. No measure reads the rate.",
        columns: {
          "Currency code": {
            description:
              "The currency's code. It joins Currency[Currency code] in both directions.",
          },
          Rate: {
            description:
              "Units of the currency for one euro: 1 for EUR, 1.08 for USD and 11.2 for SEK.",
            unit: "ratio",
          },
        },
      },
      Measures: {
        description:
          "A home for measures that belong to no one table. It holds no data.",
        grain_and_filters: "No rows and no columns: only two helper measures.",
        columns: {},
        measures: {
          "Selected currency":
            "The currency picked on the page, by its name in Currency[Currency], such as US dollar. With none or several picked, it returns EUR, a code rather than a name.",
          "Report title":
            "A title for report pages that names the months in view, such as Retail net sales, Jan 2026 to Mar 2026. Text, not a number.",
        },
      },
    },
  },
};
