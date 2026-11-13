import type { Me } from "../api/me";
import type { VariantAnchor } from "./queries";

/**
 * The shipped roles the book's policy lets curate and approve
 * (access/policies/book.yaml). The api decides in the end and refuses anyone
 * else; this only keeps the page from offering, or asking for, what would be
 * refused.
 */
const CURATING_ROLES = ["curator", "admin"];

export const mayCurate = (me: Me) =>
  me.roles.some((role) => CURATING_ROLES.includes(role));

export const TRUST_WORDS = {
  draft: "Draft",
  agent_verified: "Checked by an agent",
  human_verified: "Approved by a person",
} as const;

const VIA_WORDS = {
  browser: "the browser",
  cli: "the CLI",
  mcp: "an agent over MCP",
  api: "the API",
} as const;

export const viaWords = (via: keyof typeof VIA_WORDS | null) =>
  via === null ? "the sync" : VIA_WORDS[via];

export const humanize = (key: string) => {
  const words = key.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The period, comparison and currency shared by a variant's shift labels. */
export function formatShift(
  shift: Pick<
    VariantAnchor["shift"],
    "period" | "comparison" | "comparison_period" | "currency"
  >,
): string {
  return [
    humanize(shift.period),
    shift.comparison === "none"
      ? null
      : `${humanize(shift.comparison)} against ${humanize(shift.comparison_period ?? "an unnamed period")}`,
    shift.currency,
  ]
    .filter((value): value is string => value !== null && value !== "")
    .join(", ");
}

/**
 * Fields every change rewrites, and the person and time a verify, approve or
 * dismiss sets: the line above the fields already says who did it and when.
 */
const BOOKKEEPING = new Set([
  "updated_at",
  "touched_at",
  "verified_by",
  "verified_at",
  "name_is_generated",
  "dismissed_at",
]);
const SHORT = 60;

/** Each field under the name the metric page shows it by. */
const FIELD_NAMES: Record<string, string> = {
  label: "Name",
  name: "Key",
  definition: "Definition",
  when_to_use: "When to use it",
  not_the_same_as: "Not the same as",
  grain_and_filters: "Grain and filters",
  aliases: "Also called",
  unit: "Unit",
  category_id: "Category",
  icon: "Icon",
  owner: "Owner",
  trust_state: "Trust",
  dismissed_reason: "Why it was dismissed",
};

/** What a change did, after the name of whoever made it. */
const ACTION_WORDS: Record<string, string> = {
  create: "created it",
  update: "edited it",
  rename: "renamed it",
  verify: "checked it",
  approve: "approved it",
  move: "moved a variant",
  merge: "merged it",
  dismiss: "dismissed it",
  delete: "deleted it",
  icon: "changed its icon",
};

export const actionWords = (action: string) =>
  ACTION_WORDS[action] ?? humanize(action).toLowerCase();

/** A field's value in words. `categoryName` turns a category's id into its names. */
function valueWords(
  field: string,
  value: unknown,
  categoryName: (id: string) => string | undefined,
): string {
  if (value === null || value === undefined || value === "") return "not set";
  if (field === "trust_state" && isTrustState(value)) return TRUST_WORDS[value];
  if (field === "category_id" && typeof value === "string")
    return categoryName(value) ?? "a category no longer listed";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return typeof value === "string" ? value : JSON.stringify(value);
}

export type FieldChange = {
  field: string;
  /** The name the metric page shows the field by. */
  name: string;
  /** Both values, when each is short enough to read in a line. */
  from: string | null;
  to: string;
};

/** The fields a change touched, by their names on the page, with the old value too when both are short enough to read in a line. */
export function changedFields(
  before: unknown,
  after: unknown,
  categoryName: (id: string) => string | undefined = () => undefined,
): FieldChange[] {
  if (!isRecord(before) || !isRecord(after)) return [];
  return Object.keys({ ...before, ...after })
    .filter(
      (key) =>
        !BOOKKEEPING.has(key) &&
        JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map((field) => {
      const from = valueWords(field, before[field], categoryName);
      const to = valueWords(field, after[field], categoryName);
      return {
        field,
        name: FIELD_NAMES[field] ?? humanize(field),
        from: from.length <= SHORT && to.length <= SHORT ? from : null,
        to,
      };
    });
}

const isTrustState = (value: unknown): value is keyof typeof TRUST_WORDS =>
  typeof value === "string" && value in TRUST_WORDS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
