import { useId } from "react";
import { INPUT, Label } from "../layout/ui";
import type { Setting } from "./api";
import { nextRunInWords } from "./cron";
import { isProvider, type Provider, ProvidersEditor } from "./providers-editor";

/** What a field holds while it is edited: text for anything typed, a boolean for a switch, rows for the providers. */
export type Draft = string | boolean | Provider[];

export type FieldSpec = {
  key: string;
  label: string;
  hint?: string;
} & (
  | { kind: "text" | "number" | "list" | "include" | "cron" }
  | { kind: "bool" }
  | { kind: "choice"; options: readonly { value: string; label: string }[] }
  | { kind: "providers" }
);

function broken(spec: FieldSpec): never {
  throw new Error(
    `The api sent a value for ${spec.key} that this page cannot show.`,
  );
}

const toProviders = (value: unknown): Provider[] =>
  Array.isArray(value) ? value.filter(isProvider) : [];

/** The api's value as the field edits it. A value of another shape is a fault in the api, and says so. */
export function toDraft(spec: FieldSpec, value: unknown): Draft {
  switch (spec.kind) {
    case "bool":
      return typeof value === "boolean" ? value : broken(spec);
    case "providers":
      return Array.isArray(value) && value.every(isProvider)
        ? value
        : broken(spec);
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? value.join("\n")
        : broken(spec);
    case "include":
      if (value === "all") return "all";
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? value.join("\n")
        : broken(spec);
    default:
      if (value === null) return "";
      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : broken(spec);
  }
}

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The field's draft as the value the api takes; a draft the api would not accept is sent as it is, and the api's sentence says why. */
export function fromDraft(spec: FieldSpec, draft: Draft): unknown {
  if (typeof draft === "boolean") return draft;
  if (typeof draft !== "string")
    return draft.map((provider) => ({
      ...provider,
      issuer: provider.issuer?.trim() ? provider.issuer.trim() : null,
    }));
  switch (spec.kind) {
    case "list":
      return lines(draft);
    case "include":
      return draft.trim().toLowerCase() === "all" ? "all" : lines(draft);
    case "number": {
      if (draft.trim() === "") return null;
      const n = Number(draft);
      return Number.isInteger(n) ? n : draft;
    }
    case "text":
      return draft.trim() === "" ? null : draft.trim();
    default:
      return draft.trim();
  }
}

/** One setting: editable, or read-only with where it comes from when the environment sets it. */
export function FieldRow({
  spec,
  setting,
  draft,
  onChange,
}: {
  spec: FieldSpec;
  setting: Setting;
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const id = useId();
  const readOnly = setting.source === "environment" || setting.environment_only;
  if (readOnly) {
    const shown = toDraft(spec, setting.value);
    return (
      <div className="flex flex-col gap-1">
        <span className="text-ui font-medium text-ink">{spec.label}</span>
        <code className="rounded border border-line bg-raised px-3 py-1.5 font-mono text-ui break-all whitespace-pre-wrap text-ink">
          {typeof shown === "boolean"
            ? shown
              ? "on"
              : "off"
            : typeof shown === "string" && shown !== ""
              ? shown
              : "Not set"}
        </code>
        <p className="text-meta text-ink-3">
          {setting.source === "environment"
            ? "set by the environment ("
            : "Set only in the environment ("}
          <code className="font-mono">{setting.environment_variable}</code>
          {setting.source === "environment"
            ? ")"
            : ", by whoever runs the stack)"}
          . {spec.hint}
        </p>
      </div>
    );
  }
  if (spec.kind === "providers" && Array.isArray(draft)) {
    if (setting.redirect_uris === null)
      throw new Error(`The api sent no redirect URIs with ${spec.key}.`);
    return (
      <ProvidersEditor
        providers={draft}
        savedIds={toProviders(setting.value).map((p) => p.id)}
        redirectUris={setting.redirect_uris}
        onChange={onChange}
      />
    );
  }
  if (spec.kind === "bool")
    return (
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={draft === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
          className="mt-0.5 size-4 accent-accent pointer-coarse:size-6"
        />
        <Label htmlFor={id} hint={spec.hint ?? setting.description}>
          {spec.label}
        </Label>
      </div>
    );
  const text = typeof draft === "string" ? draft : "";
  const next = spec.kind === "cron" ? nextRunInWords(text, new Date()) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} hint={spec.hint ?? setting.description}>
        {spec.label}
      </Label>
      {spec.kind === "choice" ? (
        <select
          id={id}
          value={text}
          className={INPUT}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : spec.kind === "list" || spec.kind === "include" ? (
        <textarea
          id={id}
          rows={3}
          value={text}
          spellCheck={false}
          className={`${INPUT} font-mono`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      ) : (
        <input
          id={id}
          type="text"
          inputMode={spec.kind === "number" ? "numeric" : undefined}
          value={text}
          spellCheck={false}
          autoComplete="off"
          className={`${INPUT} ${spec.kind === "text" || spec.kind === "cron" ? "font-mono" : ""}`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
      {next !== null && <p className="text-meta text-ink-2">{next}</p>}
    </div>
  );
}
