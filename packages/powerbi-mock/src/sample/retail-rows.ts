/**
 * The rows of the Retail sample dataset: invented order lines, returns,
 * stock and budget, small enough to read. Plain arithmetic, no random, so
 * every call gives the same rows.
 */

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
const FIRST_DAY = Date.UTC(2026, 0, 1);
const DAYS = 90;
const MONTHS = ["2026-01", "2026-02", "2026-03"];
const PRODUCTS = 6;
const STORES = 4;
const CUSTOMERS = 8;
const ORDERS = 14;

const cents = (amount: number): number => Math.round(amount * 100) / 100;
const dateTime = (day: number): string =>
  new Date(FIRST_DAY + day * DAY_MS).toISOString().slice(0, 19);
const listPrice = (productKey: number): number => cents(19.9 + productKey * 12);
const orderDay = (order: number): number => (order * 6) % DAYS;

const CURRENCIES = [
  { code: "EUR", name: "Euro", rate: 1 },
  { code: "USD", name: "US dollar", rate: 1.08 },
  { code: "SEK", name: "Swedish krona", rate: 11.2 },
];

export const currencyRows = (): Row[] =>
  CURRENCIES.map((c) => ({ "Currency code": c.code, Currency: c.name }));

export const exchangeRateRows = (): Row[] =>
  CURRENCIES.map((c) => ({ "Currency code": c.code, Rate: c.rate }));

export function orderLineRows(): Row[] {
  const rows: Row[] = [];
  for (let order = 1; order <= ORDERS; order++) {
    const day = orderDay(order);
    const currency = CURRENCIES[order % CURRENCIES.length] ?? CURRENCIES[0];
    for (let line = 1; line <= 1 + (order % 3); line++) {
      const productKey = ((order + line) % PRODUCTS) + 1;
      const quantity = 1 + ((order + line) % 3);
      const gross = cents(listPrice(productKey) * quantity);
      const discount = order % 4 === 0 ? cents(gross * 0.1) : 0;
      const net = cents(gross - discount);
      rows.push({
        "Order id": 5000 + order,
        Line: line,
        "Order date": dateTime(day),
        "Ship date": dateTime(day + 2),
        "Product key": productKey,
        "Customer key": ((order - 1) % CUSTOMERS) + 1,
        "Store key": (order % STORES) + 1,
        "Currency code": currency?.code,
        Quantity: quantity,
        "Gross amount": gross,
        Discount: discount,
        "Net amount": net,
        "Net amount EUR": cents(net / (currency?.rate ?? 1)),
        Cost: cents(gross * 0.55),
        Tax: cents(net * 0.2),
        "Is first order": order <= CUSTOMERS,
        "Voucher code": order % 4 === 0 ? "SAMPLE10" : null,
        Device: ["Phone", "Desktop", "Tablet"][order % 3],
      });
    }
  }
  return rows;
}

export const returnRows = (): Row[] =>
  [3, 7, 9, 12].map((order, k) => ({
    "Return id": 900 + k,
    "Return date": dateTime(orderDay(order) + 10),
    "Product key": (order % PRODUCTS) + 1,
    "Reason key": (k % 3) + 1,
    Units: 1,
    "Refund amount": listPrice((order % PRODUCTS) + 1),
  }));

export const stockRows = (): Row[] =>
  [0, 31].flatMap((day, snapshot) =>
    Array.from({ length: PRODUCTS }, (_, k) => {
      const units = 40 - k * 4 - snapshot * 10;
      return {
        "Snapshot date": dateTime(day),
        "Product key": k + 1,
        "Store key": 1 + (k % STORES),
        "Units in stock": units,
        Value: cents(units * listPrice(k + 1) * 0.55),
      };
    }),
  );

export const budgetRows = (): Row[] =>
  MONTHS.flatMap((month, m) =>
    Array.from({ length: STORES }, (_, s) => ({
      Month: month,
      "Store key": s + 1,
      Amount: 1500 + m * 100 + s * 250,
    })),
  );

export const retailDateRows = (): Row[] =>
  Array.from({ length: DAYS }, (_, day) => {
    const date = new Date(FIRST_DAY + day * DAY_MS);
    return {
      Date: dateTime(day),
      Month: date.toISOString().slice(0, 7),
      Year: date.getUTCFullYear(),
      Week: Math.floor(day / 7) + 1,
      Weekday: date.toLocaleDateString("en-GB", {
        weekday: "long",
        timeZone: "UTC",
      }),
      "Is holiday": day === 0,
    };
  });

export const monthRows = (): Row[] =>
  MONTHS.map((month, m) => ({
    Month: month,
    "Month name": ["January", "February", "March"][m],
    Quarter: "2026 Q1",
    Year: 2026,
  }));

export const retailProductRows = (): Row[] =>
  Array.from({ length: PRODUCTS }, (_, k) => ({
    "Product key": k + 1,
    "Brand key": (k % 3) + 1,
    "Category key": (k % 2) + 1,
    SKU: `SMP-${String(1000 + k + 1)}`,
    Product: `Retail product ${String(k + 1).padStart(2, "0")}`,
    Colour: ["Black", "Sand", "Green"][k % 3],
    Size: ["S", "M", "L"][k % 3],
    "List price": listPrice(k + 1),
  }));

export const brandRows = (): Row[] =>
  ["Northfield", "Harbour", "Pinewood"].map((brand, k) => ({
    "Brand key": k + 1,
    Brand: brand,
    "Is own brand": k === 0,
  }));

export const categoryRows = (): Row[] => [
  { "Category key": 1, Category: "Jackets", Department: "Outerwear" },
  { "Category key": 2, Category: "Boots", Department: "Footwear" },
];

export const retailCustomerRows = (): Row[] =>
  Array.from({ length: CUSTOMERS }, (_, k) => ({
    "Customer key": k + 1,
    "Region key": (k % 3) + 1,
    Customer: `Retail customer ${String(k + 1).padStart(2, "0")}`,
    Email: `customer${String(k + 1)}@sample.example`,
    Phone: `+00 555 01${String(k).padStart(2, "0")}`,
    "Street address": `${String(k + 1)} Sample Street`,
    "Date of birth": `${String(1970 + k * 3)}-06-15T00:00:00`,
    Segment: k % 4 === 3 ? "Business" : "Consumer",
    "First order date": dateTime(orderDay(k + 1)),
  }));

export const storeRows = (): Row[] =>
  Array.from({ length: STORES }, (_, k) => ({
    "Store key": k + 1,
    "Region key": (k % 3) + 1,
    Store: `Sample store ${String(k + 1)}`,
    "Manager email": `manager${String(k + 1)}@sample.example`,
    Format: k % 2 === 0 ? "High street" : "Outlet",
    Opened: `${String(2015 + k)}-03-01T00:00:00`,
  }));

export const regionRows = (): Row[] => [
  { "Region key": 1, Region: "North", Country: "Sweden" },
  { "Region key": 2, Region: "Central", Country: "Germany" },
  { "Region key": 3, Region: "South", Country: "Spain" },
];

export const returnReasonRows = (): Row[] => [
  { "Reason key": 1, Reason: "Wrong size" },
  { "Reason key": 2, Reason: "Damaged" },
  { "Reason key": 3, Reason: "Changed mind" },
];

/** The answer to the recorded query for net sales, keyed as Power BI keys a query's columns. */
export const retailNetSales = (lines: readonly Row[]): Row[] => [
  {
    "[Net sales]": cents(
      lines.reduce((sum, row) => sum + Number(row["Net amount"]), 0),
    ),
  },
];
