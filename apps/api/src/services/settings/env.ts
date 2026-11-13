import type { SettingKey, SettingValue } from "../../context.js";
import { describeIssues, SETTINGS } from "./registry.js";

export type Environment = Readonly<Record<string, string | undefined>>;

/** powerbi.sync.workspaces.include is POWERBI_SYNC_WORKSPACES_INCLUDE. */
export function environmentVariable(key: SettingKey): string {
  return key.replaceAll(".", "_").toUpperCase();
}

export function isSetByEnvironment(
  key: SettingKey,
  environment: Environment,
): boolean {
  return environment[environmentVariable(key)] !== undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * The value the environment gives a setting, or undefined when it gives none
 * (no setting's value is ever undefined). The text is tried as it is, which
 * is how a string or "all" is written, then as JSON, which is how a number, a
 * boolean, a list or an object is written; the setting's own schema decides.
 * A value neither way satisfies throws, naming the variable.
 */
export function readEnvironment<K extends SettingKey>(
  key: K,
  environment: Environment,
): SettingValue<K> | undefined {
  const variable = environmentVariable(key);
  const text = environment[variable];
  if (text === undefined) return undefined;
  const { schema } = SETTINGS[key];
  const asText = schema.safeParse(text);
  if (asText.success) return asText.data;
  const json = parseJson(text);
  if (!json.ok) {
    throw new Error(
      `${variable} is not valid for the setting ${key}: ${describeIssues(asText.error)}, and it is not JSON either`,
    );
  }
  const asJson = schema.safeParse(json.value);
  if (asJson.success) return asJson.data;
  throw new Error(
    `${variable} is not valid for the setting ${key}: ${describeIssues(asJson.error)}`,
  );
}
