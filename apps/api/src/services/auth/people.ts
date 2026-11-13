import { inArray } from "drizzle-orm";
import type { Db } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { serviceAccount } from "../../db/schema/service-accounts.js";

/** What an id reads as when no account holds it now. */
export const REMOVED_PERSON = "a removed person";

export type Who = { kind: "person" | "service_account"; id: string };

/** The key of a name in the map `namesOf` answers: a person and a service account of one id are two entries. */
export const whoKey = ({ kind, id }: Who) => `${kind}:${id}`;

/**
 * Who each principal is, by kind so that a service account named like a
 * person's id is never taken for the person. `show` is a person's display
 * name for anything a signed-in caller may read, or their email for the admin
 * section. A service account is its name. An account no longer held is
 * missing from the answer.
 */
export async function namesOf(
  db: Db,
  who: Who[],
  show: "name" | "email",
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const idsOf = (kind: Who["kind"]) => [
    ...new Set(who.filter((one) => one.kind === kind).map((one) => one.id)),
  ];
  const persons = idsOf("person");
  if (persons.length > 0)
    for (const row of await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, persons)))
      names.set(whoKey({ kind: "person", id: row.id }), row[show]);
  const accounts = idsOf("service_account");
  if (accounts.length > 0)
    for (const row of await db
      .select({ name: serviceAccount.name })
      .from(serviceAccount)
      .where(inArray(serviceAccount.name, accounts)))
      names.set(whoKey({ kind: "service_account", id: row.name }), row.name);
  return names;
}
