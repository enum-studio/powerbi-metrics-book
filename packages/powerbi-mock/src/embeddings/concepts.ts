/**
 * What the mock's embedding treats as the same word. Each group holds words
 * (already stemmed by `tokens`) that mean one thing in the sample tenant,
 * taken from its measures, columns and tables. A search "by meaning" against
 * the mock can match exactly these and nothing else. The sample's README
 * lists the groups in prose; keep the two in step.
 */
export const CONCEPTS: Record<string, string[]> = {
  revenue: ["revenue", "sale", "turnover", "income", "earning"],
  order: ["order", "purchase", "booking", "transaction"],
  customer: ["customer", "client", "buyer", "shopper"],
  traffic: ["visit", "visitor", "session", "traffic"],
  margin: ["margin", "profit", "profitability"],
  return: ["return", "refund"],
  cost: ["cost", "spend", "spending", "expense"],
  advertising: ["ad", "ads", "advert", "advertising"],
  target: ["target", "goal", "quota"],
  unit: ["unit", "quantity"],
  discount: ["discount", "rebate"],
  average: ["average", "avg", "mean"],
  rate: ["rate", "ratio", "percent", "percentage"],
  previous: ["previous", "last", "prior", "ly", "py"],
};

/**
 * Words that carry no meaning of their own, plus the aggregation words
 * (total, sum, number, count, amount) that a measure name may or may not
 * carry: "Order count" and "Orders" should be one thing.
 */
export const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "in",
  "on",
  "to",
  "by",
  "and",
  "or",
  "is",
  "are",
  "was",
  "with",
  "from",
  "at",
  "as",
  "per",
  "how",
  "many",
  "much",
  "what",
  "total",
  "sum",
  "number",
  "count",
  "amount",
]);

const CONCEPT_OF = new Map(
  Object.entries(CONCEPTS).flatMap(([concept, words]) =>
    words.map((word) => [word, concept] as const),
  ),
);

/** Lowercase, split on anything but letters and digits, drop stop words, stem plurals. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !STOP_WORDS.has(word))
    .map(stem);
}

/** Plurals only: "ies" to "y", "sses" to "ss", a final "s" off, except after "s", "u" and "i". */
function stem(word: string): string {
  if (CONCEPT_OF.has(word)) return word;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("sses")) return word.slice(0, -2);
  if (word.length > 3 && /[^sui]s$/u.test(word)) return word.slice(0, -1);
  return word;
}

/** The concept a word belongs to, or the word itself, under a prefix so the two never collide. */
export function conceptKey(word: string): string {
  const concept = CONCEPT_OF.get(word);
  return concept === undefined ? `word:${word}` : `concept:${concept}`;
}
