import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { conventionsQuery } from "../../admin/access/api";
import { ErrorState, Loading } from "../../shell/states";
import { formatTime } from "../../shell/time";
import { elementDocsQuery } from "./queries";

const NOT_WRITTEN = "Not written yet";

/** A custom field's value in words; the conventions have already checked it against the field's type. */
function fieldText(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Part({ term, text }: { term: string; text: string | null }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-meta font-medium text-ink-3">{term}</h2>
      {text === null ? (
        <p className="text-body text-ink-3">{NOT_WRITTEN}</p>
      ) : (
        <p className="text-body whitespace-pre-line text-ink">{text}</p>
      )}
    </section>
  );
}

/**
 * What the book says about a dataset, table or column, in the same order on
 * each: the description, Power BI's own where it differs, the fields the
 * company's conventions ask for, then the facts the mirror holds.
 */
export function Documentation({
  kind,
  id,
  details,
}: {
  kind: "dataset" | "table" | "column";
  id: string;
  details: readonly (readonly [string, ReactNode])[];
}) {
  const docs = useQuery(elementDocsQuery(kind, id));
  const conventions = useQuery(conventionsQuery);
  const error = docs.error ?? conventions.error;
  if (error) return <ErrorState error={error} />;
  if (!docs.data || !conventions.data)
    return <Loading what="the documentation" />;
  const { description, description_pbi, custom, described_at } = docs.data;
  const facts = [
    ...details,
    ...(described_at === null
      ? []
      : ([["Last documented", formatTime(described_at)]] as const)),
  ];
  return (
    <div className="flex max-w-(--measure) flex-col gap-5">
      <Part term="Description" text={description ?? description_pbi} />
      {description !== null &&
        description_pbi !== null &&
        description !== description_pbi && (
          <Part term="Description in Power BI" text={description_pbi} />
        )}
      {conventions.data.rules[`${kind}_fields`].custom.map((field) => (
        <Part
          key={field.key}
          term={field.label}
          text={fieldText(custom[field.key])}
        />
      ))}
      <section className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold text-ink">Details</h2>
        <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-3">{label}</dt>
              <dd className="wrap-anywhere text-ink-2">{value ?? "None"}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
