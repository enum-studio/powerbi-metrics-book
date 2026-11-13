import { useSuspenseQuery } from "@tanstack/react-query";
import { SectionBox } from "../layout/ui";
import { conventionsQuery, conventionVersionsQuery } from "./api";
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

/** A document's leaves as dotted paths with their values: the stored overrides, one line each. */
function leaves(value: unknown, path: string[] = []): [string, string][] {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return Object.entries(value).flatMap(([key, each]) =>
      leaves(each, [...path, key]),
    );
  return [[path.join("."), JSON.stringify(value)]];
}

function WhatChanged() {
  const { data: conventions } = useSuspenseQuery(conventionsQuery);
  const { data: versions } = useSuspenseQuery(conventionVersionsQuery);
  const newest = versions[0];
  const preset = PRESETS[conventions.preset] ?? conventions.preset;
  const changes =
    newest === undefined
      ? []
      : leaves(newest.document).filter(
          ([path]) => path !== "preset" && path !== "guide",
        );
  return (
    <SectionBox title="Preset">
      <p className="max-w-(--measure) text-ui text-ink-2">
        Started from <span className="font-medium text-ink">{preset}</span>.{" "}
        {newest === undefined
          ? "Nothing has been changed: the preset is in force."
          : `Version ${String(newest.version)} was saved by ${newest.set_by} on ${stamp(newest.set_at)}. It changes ${String(changes.length)} ${changes.length === 1 ? "value" : "values"} of the preset${newest.document.guide === undefined ? "" : " and carries the company's own guide"}.`}
      </p>
      {changes.length > 0 && (
        <DataTable
          label="What was changed"
          min="min-w-[32rem]"
          head={["Rule", "Set to"]}
        >
          {changes.map(([path, value]) => (
            <tr key={path}>
              <td className={`${CELL} font-mono text-ink`}>{path}</td>
              <td
                className={`${CELL} font-mono break-words [overflow-wrap:anywhere]`}
              >
                {value}
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
      <WhatChanged />
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
