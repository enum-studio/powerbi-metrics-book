import { useId } from "react";
import { SecretInput } from "../admin/settings/secret-input";
import type { Field, StepInput } from "./api";

/*
 * A step's fields as the API lists them: settings with their values, and
 * secrets that say whether they are set and their expiry date. A value is
 * written, never read back, so its field starts empty whatever it holds.
 */

type SettingSpec = { label: string; hint?: string; mono?: boolean };

const SETTINGS: Record<string, SettingSpec> = {
  "powerbi.tenant_id": {
    mono: true,
    label: "Directory (tenant) ID",
    hint: "On the app registration's Overview page.",
  },
  "powerbi.app_client_id": {
    mono: true,
    label: "Application (client) ID",
    hint: "On the same page.",
  },
  "powerbi.scanner_client_id": {
    mono: true,
    label: "Application (client) ID",
    hint: "The scanner's own, on its Overview page.",
  },
};

type SecretSpec = { label: string; expires: boolean };
const SECRETS: Record<string, SecretSpec> = {
  powerbi_app_client_secret: { label: "Client secret value", expires: true },
  powerbi_scanner_client_secret: {
    label: "Client secret value",
    expires: true,
  },
};

/** What the form holds: a setting's value as its control edits it, and each secret typed in. */
export type Draft = {
  settings: Record<string, unknown>;
  secrets: Record<string, { value: string; expires: string }>;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
const savedDate = (field: Field & { kind: "secret" }) =>
  field.expires_at?.slice(0, 10) ?? "";

export function draftOf(fields: Field[]): Draft {
  const settings: Record<string, unknown> = {};
  for (const field of fields)
    if (field.kind === "setting" && field.key in SETTINGS)
      settings[field.key] = text(field.value);
  return { settings, secrets: {} };
}

/** The settings that changed and the secrets typed in, as the step takes them. */
export function inputOf(fields: Field[], draft: Draft): StepInput {
  const before = draftOf(fields).settings;
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft.settings)) {
    if (JSON.stringify(value) === JSON.stringify(before[key])) continue;
    settings[key] = value === "" ? null : value;
  }
  const secrets: NonNullable<StepInput["secrets"]> = {};
  for (const [name, { value, expires }] of Object.entries(draft.secrets)) {
    const expires_at =
      expires === "" ? null : new Date(`${expires}T23:59:59Z`).toISOString();
    const field = fields.find(
      (each) => each.kind === "secret" && each.name === name,
    );
    if (value !== "") secrets[name] = { value, expires_at };
    else if (
      field?.kind === "secret" &&
      field.set &&
      expires !== savedDate(field)
    )
      secrets[name] = { expires_at };
  }
  return { settings, secrets };
}

export const CONTROL =
  "w-full rounded border border-line-control bg-surface px-2.5 py-1.5 text-ui text-ink disabled:bg-raised disabled:text-ink-3 pointer-coarse:min-h-(--tap)";

function Labelled({
  label,
  hint,
  id,
  children,
}: {
  label: string;
  hint?: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-ui font-medium text-ink">
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-meta text-ink-3">{hint}</p>}
    </div>
  );
}

export function SettingField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Field & { kind: "setting" };
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const id = useId();
  const spec = SETTINGS[field.key];
  if (spec === undefined) return null;
  return (
    <Labelled id={id} label={spec.label} hint={spec.hint}>
      <input
        id={id}
        className={`${CONTROL} ${spec.mono === true ? "font-mono" : ""}`}
        value={text(value)}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Labelled>
  );
}

/** A secret field shows whether a value is saved, never the value. */
export function SecretField({
  field,
  draft,
  disabled,
  onChange,
}: {
  field: Field & { kind: "secret" };
  draft: { value: string; expires: string } | undefined;
  disabled: boolean;
  onChange: (value: { value: string; expires: string }) => void;
}) {
  const id = useId();
  const spec = SECRETS[field.name];
  if (spec === undefined) return null;
  const typed = draft ?? { value: "", expires: savedDate(field) };
  return (
    <div className="flex flex-col gap-4">
      <Labelled
        id={id}
        label={spec.label}
        hint={
          field.set
            ? "A value is saved. Enter a new one only to replace it."
            : undefined
        }
      >
        <SecretInput
          id={id}
          className={`${CONTROL} font-mono`}
          value={typed.value}
          placeholder={field.set ? "*****" : undefined}
          disabled={disabled}
          required={!field.set}
          onChange={(event) => {
            const value = event.target.value;
            // A new value is a new secret: the old one's date does not carry over.
            const saved = savedDate(field);
            const expires =
              typed.value === "" && typed.expires === saved
                ? ""
                : value === "" && typed.expires === ""
                  ? saved
                  : typed.expires;
            onChange({ value, expires });
          }}
        />
      </Labelled>
      {spec.expires && (
        <Labelled
          id={`${id}-expires`}
          label="The secret expires on (optional)"
          hint="As Entra shows it under Certificates & secrets. The admin's status page warns before it does."
        >
          <input
            id={`${id}-expires`}
            type="date"
            className={`${CONTROL} sm:w-48`}
            value={typed.expires}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...typed, expires: event.target.value });
            }}
          />
        </Labelled>
      )}
    </div>
  );
}
