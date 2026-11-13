import { PageFrame } from "../layout/ui";
import type { FieldSpec } from "./fields";
import { Section } from "./section";

const RESULTS: FieldSpec[] = [
  {
    key: "results.ttl_hours",
    label: "Result lifetime (hours)",
    kind: "number",
    hint: "How long a stored query result is kept. 24 by default, at most 72.",
  },
  {
    key: "results.preview_rows",
    label: "Preview rows",
    kind: "number",
    hint: "How many rows a query answers with before the full result.",
  },
  {
    key: "results.page_rows_max",
    label: "Page size (rows)",
    kind: "number",
    hint: "The most rows one page of a stored result returns, at most 500.",
  },
  {
    key: "results.daily_row_budget",
    label: "Daily row budget",
    kind: "number",
    hint: "The most rows one person's queries may store in a day.",
  },
];
const RATE: FieldSpec[] = [
  {
    key: "queries.rate_per_minute",
    label: "Queries per minute",
    kind: "number",
    hint: "The most queries one person or service account may run in a minute.",
  },
];

export function LimitsPage() {
  return (
    <PageFrame
      title="Limits"
      lede="How long results are kept, how much a query returns, and how fast people may ask."
      help={
        <p>
          Limits apply from the next query. Results already stored keep the
          lifetime they were made with.
        </p>
      }
    >
      <Section title="Results" fields={RESULTS} />
      <Section title="Rate limits" fields={RATE} />
    </PageFrame>
  );
}
