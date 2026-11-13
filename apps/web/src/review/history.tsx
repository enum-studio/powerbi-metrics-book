import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { categoryNamesById, type Category } from "../catalog/tree/model";
import { formatTime } from "../shell/time";
import { actionWords, changedFields, viaWords } from "./format";
import { historyQuery } from "./queries";

const PAGE_SIZE = 10;

/** Each change to the metric, newest first, ten at a time. The api sends them all, oldest first. */
export function History({
  name,
  categories,
}: {
  name: string;
  /** The book's categories, already read by the page, to name a category a change filed the metric in. */
  categories: Category[];
}) {
  const { data, error, isPending } = useQuery(historyQuery(name));
  const [shown, setShown] = useState(PAGE_SIZE);
  if (isPending)
    return <p className="text-ui text-ink-3">Loading the history</p>;
  if (error !== null)
    return (
      <p role="alert" className="text-ui text-ink-2">
        The history could not be loaded: {error.message}
      </p>
    );
  const newest = data.toReversed();
  if (newest.length === 0)
    return (
      <p className="text-ui text-ink-2">Nobody has changed this metric.</p>
    );
  return (
    <div className="flex flex-col items-start gap-4">
      <ol className="flex w-full flex-col divide-y divide-line">
        {newest.slice(0, shown).map((change) => {
          const fields = changedFields(change.before, change.after, (id) =>
            categoryNamesById(categories, id),
          );
          return (
            <li key={change.id} className="flex flex-col gap-1.5 py-3">
              <p className="text-ui text-ink">
                <span className="font-medium">
                  {change.principal_kind === "system"
                    ? "The system"
                    : change.principal_name}
                </span>{" "}
                {actionWords(change.action)} through {viaWords(change.via)}
                <span className="text-ink-3">
                  {" · "}
                  <time dateTime={change.at}>{formatTime(change.at)}</time>
                </span>
              </p>
              {fields.length > 0 && (
                <dl className="flex flex-col gap-1 text-meta text-ink-2">
                  {fields.map(({ field, name: fieldName, from, to }) => (
                    <div key={field}>
                      <dt
                        className={`font-medium text-ink-3 ${from === null ? "" : "inline"}`}
                      >
                        {fieldName}
                        {from !== null && ": "}
                      </dt>
                      {from === null ? (
                        <dd className="line-clamp-3 whitespace-pre-line">
                          {to}
                        </dd>
                      ) : (
                        <dd className="inline">
                          {from} to {to}
                        </dd>
                      )}
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
      {shown < newest.length && (
        <button
          type="button"
          className="rounded border border-line-control bg-surface px-3 py-1.5 text-ui text-ink hover:bg-raised pointer-coarse:min-h-(--tap)"
          onClick={() => {
            setShown(shown + PAGE_SIZE);
          }}
        >
          Show {Math.min(PAGE_SIZE, newest.length - shown)} older changes
        </button>
      )}
    </div>
  );
}
