/**
 * The sample's generated rows: invented orders, products, customers, ad
 * spend and web sessions. A seeded generator, so every call gives the same
 * rows and a recorded answer computed from them stays true.
 */

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
const FIRST_DAY = Date.UTC(2024, 0, 1);
// Sales run to the end of September 2026; the Date table covers the whole of 2026.
const SALES_DAYS = (Date.UTC(2026, 8, 30) - FIRST_DAY) / DAY_MS + 1;
const CALENDAR_DAYS = (Date.UTC(2026, 11, 31) - FIRST_DAY) / DAY_MS + 1;
const PRODUCT_COUNT = 12;
const CUSTOMER_COUNT = 200;

export const CHANNELS: readonly Row[] = [
  { "Channel key": 1, Channel: "Web" },
  { "Channel key": 2, Channel: "Store" },
  { "Channel key": 3, Channel: "Marketplace" },
  { "Channel key": 4, Channel: "Phone" },
];
const PAID_CHANNEL_KEYS = [1, 3];

// mulberry32: small, fast and the same on every platform.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const between = (random: () => number, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));
const cents = (amount: number): number => Math.round(amount * 100) / 100;
// Power BI answers a DateTime as local time without an offset.
const dateTime = (day: number): string =>
  new Date(FIRST_DAY + day * DAY_MS).toISOString().slice(0, 19);
const listPrice = (productKey: number): number =>
  cents(14.95 + productKey * 8.5);

export function dateRows(): Row[] {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return Array.from({ length: CALENDAR_DAYS }, (_, day) => {
    const date = new Date(FIRST_DAY + day * DAY_MS);
    const month = date.getUTCMonth();
    return {
      Date: dateTime(day),
      Year: date.getUTCFullYear(),
      Quarter: `${String(date.getUTCFullYear())} Q${String(Math.floor(month / 3) + 1)}`,
      Month: date.toISOString().slice(0, 7),
      "Month name": months[month],
      "Is weekend": date.getUTCDay() === 0 || date.getUTCDay() === 6,
      "Date last year": dateTime(day - 364),
      "Date last month": dateTime(day - 28),
      "Date last week": dateTime(day - 7),
    };
  });
}

export function productRows(): Row[] {
  const categories = ["Outerwear", "Footwear", "Accessories", "Home"];
  return Array.from({ length: PRODUCT_COUNT }, (_, k) => ({
    "Product key": k + 1,
    Product: `Product ${String(k + 1).padStart(2, "0")}`,
    Category: categories[k % categories.length],
    "List price": listPrice(k + 1),
    "Weight (kg)": Math.round((0.2 + k * 0.35) * 1000) / 1000,
    Image: null,
  }));
}

export function customerRows(): Row[] {
  const random = seeded(2);
  const regions = ["North", "South", "East", "West"];
  return Array.from({ length: CUSTOMER_COUNT }, (_, k) => ({
    "Customer key": k + 1,
    Customer: `Customer ${String(k + 1).padStart(3, "0")}`,
    Region: regions[between(random, 0, regions.length - 1)],
    Segment: random() < 0.8 ? "Consumer" : "Business",
  }));
}

/** One row per order line: one or two orders a day, one to three lines each. */
export function salesRows(): Row[] {
  const random = seeded(1);
  const rows: Row[] = [];
  let orderId = 100_000;
  for (let day = 0; day < SALES_DAYS; day++) {
    const orders = between(random, 1, 2);
    for (let order = 0; order < orders; order++) {
      orderId++;
      const customerKey = between(random, 1, CUSTOMER_COUNT);
      const channelKey = between(random, 1, CHANNELS.length);
      const shipDay = day + between(random, 1, 4);
      const lines = between(random, 1, 3);
      for (let line = 1; line <= lines; line++) {
        const productKey = between(random, 1, PRODUCT_COUNT);
        const quantity = between(random, 1, 4);
        const gross = cents(listPrice(productKey) * quantity);
        const discount = random() < 0.3 ? cents(gross * 0.1) : 0;
        rows.push({
          "Order id": orderId,
          "Order line": line,
          Date: dateTime(day),
          "Ship date": dateTime(shipDay),
          "Product key": productKey,
          "Customer key": customerKey,
          "Channel key": channelKey,
          Quantity: quantity,
          "Gross amount": gross,
          "Discount amount": discount,
          "Net amount": cents(gross - discount),
          "Cost amount": cents(gross * 0.55),
          "Is returned": random() < 0.05,
        });
      }
    }
  }
  return rows;
}

/** Weekly spend on the two paid channels, from the first Monday of 2024. */
export function adSpendRows(): Row[] {
  const random = seeded(3);
  const rows: Row[] = [];
  for (let day = 0; day < SALES_DAYS; day += 7) {
    for (const channelKey of PAID_CHANNEL_KEYS) {
      const spend = cents(400 + random() * 600);
      const clicks = Math.round(spend * (2 + random()));
      rows.push({
        "Week start": dateTime(day),
        "Channel key": channelKey,
        Campaign: `Campaign ${"ABC".charAt((day / 7) % 3)}`,
        Spend: spend,
        Clicks: clicks,
        Impressions: clicks * between(random, 40, 60),
      });
    }
  }
  return rows;
}

export function webSessionRows(): Row[] {
  const random = seeded(4);
  const rows: Row[] = [];
  for (let day = 0; day < SALES_DAYS; day++) {
    for (const device of ["Desktop", "Mobile"]) {
      const sessions = between(random, 200, 500);
      const bounced = Math.round(sessions * (0.3 + random() * 0.2));
      rows.push({
        Date: dateTime(day),
        Device: device,
        "Session count": sessions,
        "Bounced sessions": bounced,
        "Bounce rate": Math.round((bounced / sessions) * 10_000) / 10_000,
      });
    }
  }
  return rows;
}

/** The answer to the recorded query for net sales by month in 2025, keyed as Power BI keys a query's columns. */
export function netSalesByMonth(sales: readonly Row[], year: number): Row[] {
  const byMonth = new Map<string, number>();
  for (const row of sales) {
    const month = String(row.Date).slice(0, 7);
    if (!month.startsWith(String(year))) continue;
    byMonth.set(month, (byMonth.get(month) ?? 0) + Number(row["Net amount"]));
  }
  return [...byMonth.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([month, net]) => ({
      "Date[Month]": month,
      "[Net sales]": cents(net),
    }));
}

/** The answer to the recorded query for orders by channel. */
export function ordersByChannel(sales: readonly Row[]): Row[] {
  return CHANNELS.map((channel) => ({
    "Channel[Channel]": channel.Channel,
    "[Orders]": new Set(
      sales
        .filter((row) => row["Channel key"] === channel["Channel key"])
        .map((row) => row["Order id"]),
    ).size,
  })).toSorted((a, b) =>
    String(a["Channel[Channel]"]).localeCompare(String(b["Channel[Channel]"])),
  );
}
