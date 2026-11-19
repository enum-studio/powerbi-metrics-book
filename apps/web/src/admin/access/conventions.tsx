import { useSuspenseQuery } from "@tanstack/react-query";
import { SectionBox } from "../layout/ui";
import {
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

/** Who saved the version in force, and the rules the company sets in it; every other rule is the preset's. */
export function WhatChanged({ preset }: { preset: string }) {
  const { data: versions } = useSuspenseQuery(conventionVersionsQuery);
  const { data: rules } = useSuspenseQuery(conventionRulesQuery);
  const { data: company } = useSuspenseQuery(conventionCompanyQuery);
  const newest = versions[0];
  const set = rules.filter((rule) => rule.source === "company");
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
