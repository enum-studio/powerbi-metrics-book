/*
 * The words `pbmb admin pii suggest` looks for in a column name. It only
 * suggests: nothing is marked without a person or agent setting a rule.
 */

const ANYWHERE = [
  "first_name",
  "last_name",
  "full_name",
  "phone_number",
  "mobile_number",
  "date_of_birth",
  "birth_date",
  "social_security",
  "national_id",
  "passport",
  "iban",
  "ip_address",
] as const;
const WHOLE_WORD = [
  "email",
  "phone",
  "mobile",
  "address",
  "street",
  "birthday",
  "ssn",
  "cpr",
] as const;
const DROP_PREFIXES = ["is_", "has_"] as const;
const DROP_SUFFIXES = [
  "_count",
  "_type",
  "_category",
  "_country",
  "_city",
  "_zip",
  "_domain",
] as const;

/** `DateOfBirth`, `Customer Email` and `IPAddress` become `date_of_birth`, `customer_email` and `ip_address`. */
function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The word that makes the column name look like personal data, or null. */
export function suspectedPii(columnName: string): string | null {
  const name = snakeCase(columnName);
  const phrase = ANYWHERE.find((word) => name.includes(word));
  if (phrase !== undefined) return phrase;
  const words = name.split("_");
  const word = WHOLE_WORD.find((candidate) => words.includes(candidate));
  if (word === undefined) return null;
  const dropped =
    DROP_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    DROP_SUFFIXES.some((suffix) => name.endsWith(suffix));
  return dropped ? null : word;
}
