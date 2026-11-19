import { useSuspenseQuery } from "@tanstack/react-query";
import { SectionBox } from "../layout/ui";
import {
  type CompanyPart,
  conventionCompanyQuery,
  conventionRulesQuery,
  conventionsQuery,
  conventionVersionsQuery,
} from "./api";
import { Guide } from "./guide";
import { CopyButton } from "../../shell/copy-button";
import { CELL, DataTable, stamp } from "./parts";

const PRESETS: Record<string, string> = {
  metrics_book: "Metrics Book's standard",
  minimal: "The minimal preset",
};

const COMMANDS = [
  {
    command: "pbmb conventions edit",
    what: "Opens the conventions in your editor, checks them, shows what would change and asks before it saves.",
  },
  {
    command: "pbmb conventions set naming.case none",
    what: "Changes one rule by its path, here the naming case. Replace the path and the value.",
  },
  {
    command: "pbmb conventions import conventions.yml",
    what: "Replaces the conventions with a file you keep in git.",
  },
] as const;

/** Keys of the company's part said in a sentence of their own, not listed as values. */
const SAID_APART = new Set(["format", "preset", "guide", "off", "exceptions"]);

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Setting = { id: string; value: unknown };

/** Each value the company's part sets: under the rule whose key holds it, else under its own path. */
function setByCompany(
  company: CompanyPart,
  ids: ReadonlySet<string>,
): Setting[] {
  const walk = (value: unknown, path: string[]): Setting[] => {
    const id = path.join(".");
    return ids.has(id) || !isMapping(value)
      ? [{ id, value }]
      : Object.entries(value).flatMap(([key, under]) =>
          walk(under, [...path, key]),
        );
  };
  return Object.entries(company)
    .filter(([key]) => !SAID_APART.has(key))
    .flatMap(([key, value]) => walk(value, [key]));
}

/** Who saved the version in force, what the company sets in it, the rules that are off and the exceptions; every other rule is the preset's. */
export function WhatChanged({ preset }: { preset: string }) {
  const { data: versions } = useSuspenseQuery(conventionVersionsQuery);
  const { data: rules } = useSuspenseQuery(conventionRulesQuery);
  const { data: company } = useSuspenseQuery(conventionCompanyQuery);
  const newest = versions[0];
  const set = setByCompany(company, new Set(rules.map((rule) => rule.id)));
  const off = rules.filter((rule) => rule.off).map((rule) => rule.id);
  const exceptions = rules.reduce((sum, rule) => sum + rule.exceptions, 0);
  return (
    <SectionBox title="Preset">
      <p className="max-w-(--measure) text-ui text-ink-2">
        Started from{" "}
        <span className="font-medium text-ink">
          {PRESETS[preset] ?? preset}
        </span>
        .{" "}
        {newest === undefined
          ? "Nothing has been changed: the preset is in force."
          : `Version ${String(newest.version)} was saved by ${newest.set_by} on ${stamp(newest.set_at)}. The company sets ${String(set.length)} ${set.length === 1 ? "rule" : "rules"} itself${company.guide === undefined ? "" : ", and its own guide"}.`}
        {off.length > 0 &&
          ` ${String(off.length)} ${off.length === 1 ? "rule is" : "rules are"} off: ${off.join(", ")}.`}
        {exceptions > 0 &&
          ` ${String(exceptions)} ${exceptions === 1 ? "exception lets an element" : "exceptions let elements"} keep failing a rule.`}
      </p>
      {set.length > 0 && (
        <DataTable
          label="Rules the company sets"
          min="min-w-[32rem]"
          head={["Rule", "Set to"]}
        >
          {set.map(({ id, value }) => (
            <tr key={id}>
              <td className={`${CELL} font-mono text-ink`}>{id}</td>
              <td
                className={`${CELL} font-mono break-words [overflow-wrap:anywhere]`}
              >
                {JSON.stringify(value)}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </SectionBox>
  );
}

export function Conventions() {
  const { data: conventions } = useSuspenseQuery(conventionsQuery);
  return (
    <>
      <SectionBox title="Guide">
        <Guide markdown={conventions.guide} />
      </SectionBox>
      <SectionBox title="Rules">
        <ul className="flex max-w-(--measure) list-disc flex-col gap-1 pl-5 text-ui text-ink-2">
          {conventions.summary.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </SectionBox>
      <WhatChanged preset={conventions.preset} />
      <SectionBox title="Edit">
        <p className="max-w-(--measure) text-ui text-ink-2">
          The conventions are changed through the command line, so every change
          is checked, versioned and recorded. This page only shows them.
        </p>
        <ul className="flex flex-col gap-4">
          {COMMANDS.map(({ command, what }) => (
            <li key={command} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded border border-line bg-raised px-2 py-1 font-mono text-ui text-ink">
                  {command}
                </code>
                <CopyButton text={command} label={`Copy ${command}`} />
              </div>
              <p className="max-w-(--measure) text-ui text-ink-2">{what}</p>
            </li>
          ))}
        </ul>
      </SectionBox>
    </>
  );
}
