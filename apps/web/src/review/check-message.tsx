import { useState } from "react";

const FIRST_LABELS = 5;

/** A check's sentence, then the metrics it counts as a list, short until asked for: a common word can match hundreds. */
export function CheckMessage({
  message,
  rule,
  otherLabels = [],
}: {
  message: string;
  /** The id of the rule the sentence is about, shown after it. */
  rule: string;
  otherLabels?: readonly string[];
}) {
  const [all, setAll] = useState(false);
  const labels = all ? otherLabels : otherLabels.slice(0, FIRST_LABELS);
  return (
    <>
      <p>
        {message}
        <RuleId rule={rule} />
      </p>
      {labels.length > 0 && (
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-ink">
          {labels.map((label, index) => (
            <li key={`${String(index)}-${label}`} className="break-words">
              {label}
            </li>
          ))}
        </ul>
      )}
      {otherLabels.length > FIRST_LABELS && (
        <button
          type="button"
          className="mt-1 underline underline-offset-4 hover:text-accent pointer-coarse:min-h-(--tap)"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? "Show fewer" : `Show all ${String(otherLabels.length)}`}
        </button>
      )}
    </>
  );
}

/** A rule's id, in small monospace text, for a person to quote when they ask for an exception. */
export function RuleId({ rule }: { rule: string }) {
  return <code className="ml-1.5 font-mono text-meta text-ink-2">{rule}</code>;
}
