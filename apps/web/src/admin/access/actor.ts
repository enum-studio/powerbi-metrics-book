/** The id the audit log gives an action taken through the setup link, before any admin exists (services/setup/link.ts, setupPrincipal). */
const SETUP_LINK = "setup_link";

/** Who did it, as an admin reads the audit log: a person's email, the setup link, or the kind and id of anyone else. */
export function actorName(
  people: readonly { id: string; email: string }[],
  kind: string,
  id: string,
): string {
  if (kind === "person" && id === SETUP_LINK) return "the setup link";
  return people.find((person) => person.id === id)?.email ?? `${kind} ${id}`;
}
