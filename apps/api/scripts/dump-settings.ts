/*
 * Prints the settings registry and the secrets' readers as JSON, for the docs
 * site's reference/settings.md (apps/docs/scripts/gen-reference.mjs):
 *
 *   pnpm --filter @powerbi-metrics-book/api exec tsx scripts/dump-settings.ts
 *
 * Reads the registry itself, so the page cannot differ from the code.
 */
import { z } from "zod";
import {
  FIXED_SECRET_NAMES,
  readersOf,
} from "../src/services/secrets/readers.js";
import { environmentVariable } from "../src/services/settings/env.js";
import { SETTING_KEYS, SETTINGS } from "../src/services/settings/registry.js";

const settings = SETTING_KEYS.map((key) => {
  const entry = SETTINGS[key];
  return {
    key,
    default: entry.default,
    environment_variable: environmentVariable(key),
    environment_only: entry.environment_only === true,
    description: entry.description,
    // What a value may be, as JSON Schema; a rule it cannot express (a cron
    // line, a GUID's format) is dropped rather than guessed.
    accepts: z.toJSONSchema(entry.schema, {
      io: "input",
      unrepresentable: "any",
    }),
  };
});

/**
 * Every sign-in provider has its own secret, sign_in_<id>_client_secret. Who
 * reads it is the same for every provider, so the row for the pattern takes
 * its readers from one secret per kind of provider the registry accepts, and
 * fails if two kinds disagree.
 */
function signInReaders(): readonly string[] {
  const providers = z.toJSONSchema(SETTINGS["sign_in.providers"].schema, {
    io: "input",
    unrepresentable: "any",
  });
  const { items } = providers;
  const kind =
    typeof items === "object" && !Array.isArray(items)
      ? items.properties?.kind
      : undefined;
  const kinds = (typeof kind === "object" ? kind.enum : undefined) ?? [];
  if (kinds.length === 0)
    throw new Error("sign_in.providers no longer names the kinds of provider.");
  const readers = kinds.map((name) =>
    readersOf(`sign_in_${String(name)}_client_secret`).join(","),
  );
  if (new Set(readers).size !== 1)
    throw new Error(
      "The kinds of sign-in provider are read by different containers.",
    );
  return readersOf(`sign_in_${String(kinds[0])}_client_secret`);
}

const SIGN_IN_SECRET = "sign_in_<provider>_client_secret";
const secrets = [
  ...FIXED_SECRET_NAMES.map((name) => ({ name, readers: readersOf(name) })),
  { name: SIGN_IN_SECRET, readers: signInReaders() },
].map(({ name, readers }) => ({
  name,
  environment_variable: name.toUpperCase(),
  readers,
}));

process.stdout.write(`${JSON.stringify({ settings, secrets }, null, 2)}\n`);
