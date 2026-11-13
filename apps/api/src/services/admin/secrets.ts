import { eq } from "drizzle-orm";
import type { Db, SecretName, ServiceContext } from "../../context.js";
import { secret } from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import { namesOf, REMOVED_PERSON, whoKey } from "../auth/people.js";
import {
  createSecretWriter,
  type SecretAdmin,
  type SecretListing,
} from "../secrets/store.js";
import { readersOf } from "../secrets/readers.js";
import { checkFor, isSecretName, storeCheck } from "./checks.js";
import { audited, requireAdmin } from "./guard.js";

/** No function here returns a value: the writer and its list hold none to give. */

/** The longest secret value either way of entering one takes: this section's route and the setup's steps. */
export const SECRET_VALUE_MAX = 8192;

function writer(context: ServiceContext): SecretAdmin {
  return createSecretWriter({
    container: context.container,
    db: context.db,
    clock: context.clock,
    onWrite: (write) =>
      audited(
        context,
        "secret.set",
        { kind: "secret", id: write.name },
        { expires_at: write.expires_at },
      ),
  });
}

const FIXED_SETTERS: Record<string, string> = {
  setup_link: "the setup link",
};

/**
 * Who set each secret, as a person reads it: the email, the service
 * account's name, a fixed label for the setup link or for the stack itself
 * (a secret it generated), and "a removed person" for an id no account holds.
 */
async function withSetterNames(
  db: Db,
  listed: SecretListing[],
): Promise<SecretListing[]> {
  const ids = new Set(
    listed.flatMap(({ set_by }) =>
      set_by === null || FIXED_SETTERS[set_by] !== undefined ? [] : [set_by],
    ),
  );
  // The secret's row keeps the setter's id and not its kind, so a person is
  // read first and a service account only where no person has that id.
  const names = await namesOf(
    db,
    [...ids].flatMap((id) => [
      { kind: "person" as const, id },
      { kind: "service_account" as const, id },
    ]),
    "email",
  );
  return listed.map((secret) => ({
    ...secret,
    set_by:
      secret.set_by === null
        ? secret.set
          ? "the stack"
          : null
        : (FIXED_SETTERS[secret.set_by] ??
          names.get(whoKey({ kind: "person", id: secret.set_by })) ??
          names.get(whoKey({ kind: "service_account", id: secret.set_by })) ??
          REMOVED_PERSON),
  }));
}

/** Each sign-in provider has a secret from the moment it is saved, set or not, so there is a row to set it in. */
async function withProviderSecrets(
  context: ServiceContext,
  listed: SecretListing[],
): Promise<SecretListing[]> {
  const have = new Set(listed.map(({ name }) => name));
  const missing = (await context.settings.get("sign_in.providers"))
    .map(({ id }): SecretName => `sign_in_${id}_client_secret`)
    .filter((name) => !have.has(name))
    .map((name) => ({
      name,
      readers: readersOf(name),
      set: false,
      needs_reentry_for: [],
      hint: null,
      set_by: null,
      set_at: null,
      expires_at: null,
      checked_at: null,
      check_status: null,
      check_message: null,
    }));
  return [...listed, ...missing].sort((a, b) => a.name.localeCompare(b.name));
}

/** What the admin sees of each secret: the writer's listing, the providers' secrets not yet set, and who set each by name. */
async function described(
  context: ServiceContext,
  listed: SecretListing[],
): Promise<SecretListing[]> {
  return withSetterNames(
    context.db,
    await withProviderSecrets(context, listed),
  );
}

/** Name, readers, whether set, hint, who (by name) and when, expiry and last check. */
export async function listSecrets(
  context: ServiceContext,
): Promise<SecretListing[]> {
  await requireAdmin(context, "manage_secrets");
  return described(context, await writer(context).list());
}

/** Saves through the writer, then runs the secret's check when one is registered. */
export async function setSecret(
  context: ServiceContext,
  name: string,
  value: string,
  options: { expires_at: Date | null },
): Promise<SecretListing> {
  await requireAdmin(context, "manage_secrets");
  if (!isSecretName(name))
    throw new ServiceError("invalid", `There is no secret named ${name}.`);
  const secrets = writer(context);
  await secrets.write(name, value, context.principal, options.expires_at);
  const check = checkFor(name);
  if (check !== undefined)
    await storeCheck(context, name, await check(context), value);
  return listedAfterSaving(context, name);
}

/**
 * Changes a saved secret's date and nothing else. Entra shows a value once, so
 * a person who comes back with the date no longer has the value to enter again.
 */
export async function setSecretExpiry(
  context: ServiceContext,
  name: string,
  expires_at: Date | null,
): Promise<SecretListing> {
  await requireAdmin(context, "manage_secrets");
  if (!isSecretName(name))
    throw new ServiceError("invalid", `There is no secret named ${name}.`);
  const [saved] = await context.db
    .update(secret)
    .set({ expires_at })
    .where(eq(secret.name, name))
    .returning({ name: secret.name });
  if (saved === undefined)
    throw new ServiceError(
      "invalid",
      `${name} has no value yet. Set it first, then its expiry date.`,
    );
  await audited(
    context,
    "secret.expiry_set",
    { kind: "secret", id: name },
    { expires_at },
  );
  return listedAfterSaving(context, name);
}

async function listedAfterSaving(
  context: ServiceContext,
  name: SecretName,
): Promise<SecretListing> {
  const saved = (await described(context, await writer(context).list())).find(
    (listed) => listed.name === name,
  );
  if (saved === undefined) throw new Error(`${name} was saved but not listed`);
  return saved;
}
