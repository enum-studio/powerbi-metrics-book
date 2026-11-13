/**
 * The roles the default policies (access/policies) ship. A company adds its
 * own by naming them in its own Cerbos policies, which only Cerbos reads, so
 * the api knows no others: assigning one is said to be on purpose.
 */
export const SHIPPED_ROLES = [
  "viewer",
  "curator",
  "admin",
  "pii_reader",
] as const;
export type ShippedRole = (typeof SHIPPED_ROLES)[number];

export function isShippedRole(role: string): role is ShippedRole {
  return SHIPPED_ROLES.some((shipped) => shipped === role);
}
