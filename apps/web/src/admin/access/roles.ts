import type { operations } from "../../api/schema";

/** A role a person is given directly, as the api's Change role route names them. */
export type PersonRole =
  operations["putApiV1AdminPeopleByIdRole"]["requestBody"]["content"]["application/json"]["role"];

/**
 * Each shipped role's name and its one line from the spec. One map on each side of the HTTP
 * boundary: these names are the api's email labels (ROLE_LABELS in
 * apps/api/src/services/auth/invites.ts), and a role the api adds fails this typecheck until it
 * has one here; a roles endpoint replaces both once custom roles can be given in the app.
 */
const WORDS: Record<PersonRole, { label: string; hint: string }> = {
  viewer: {
    label: "Viewer",
    hint: "Reads the book and queries Power BI with their own rights.",
  },
  curator: {
    label: "Curator",
    hint: "Also changes metrics, terms and categories.",
  },
  admin: {
    label: "Admin",
    hint: "Also manages users, settings and the Power BI connection.",
  },
};

const isPersonRole = (role: string): role is PersonRole =>
  Object.hasOwn(WORDS, role);

/** The shipped roles in the order a picker offers them. */
export const SHIPPED_ROLES = Object.entries(WORDS).flatMap(([value, words]) =>
  isPersonRole(value) ? [{ value, ...words }] : [],
);

/** A role as people read it: Viewer, Curator or Admin, and a custom role as written. */
export const roleLabel = (role: string) =>
  isPersonRole(role) ? WORDS[role].label : role;
