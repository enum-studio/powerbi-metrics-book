import { Link } from "@tanstack/react-router";
import type { components } from "../../api/schema";
type Metric = components["schemas"]["MetricDocument"];

export const TEXT_FIELDS = [
  ["importance_why", "Why it matters"],
  ["use_for", "Use for"],
  ["dont_use_for", "Don't use for"],
  ["decisions", "Decisions"],
  ["actions", "Actions"],
  ["not_the_same_as", "Not the same as"],
  ["caveats", "Caveats"],
  ["when_to_use", "When to use"],
  ["grain_and_filters", "Grain and filters"],
  ["owner_team", "Owning team"],
] as const;

export function MetricDocumentation({ metric }: { metric: Metric }) {
  const parts: [string, string | null][] = [
    ["Definition", metric.definition],
    ["Why it matters", metric.importance_why],
    ["Use for", metric.use_for],
    ["Don't use for", metric.dont_use_for],
    ["Decisions", metric.decisions],
    ["Actions", metric.actions],
    ["Primary dimensions", metric.primary_dimensions.join(", ")],
    [
      "Formula",
      metric.edges.length
        ? `${metric.label} = ${metric.edges.map((edge, i) => `${edge.operation === "product" ? `${i ? "times " : ""}${edge.sign === -1 ? "negative " : ""}` : edge.sign === -1 ? "minus " : i ? "plus " : ""}${edge.metric.label}${edge.note ? ` (${edge.note})` : ""}`).join(" ")}`
        : null,
    ],
    ["Calculation in the model", metric.formula ?? null],
    ["Not the same as", metric.not_the_same_as],
    ["Caveats", metric.caveats],
    ["Aliases", metric.aliases?.join(", ") ?? null],
    ["Who may see it", metric.who_may_see],
    ["Owning team", metric.owner_team],
    [
      "Owner",
      metric.owner_person
        ? `${metric.owner_person.name}${metric.owner_person.title ? `, ${metric.owner_person.title}` : ""}${metric.owner_person.left ? " (left)" : ""}`
        : metric.owner,
    ],
    ["When to use", metric.when_to_use],
    ["Grain and filters", metric.grain_and_filters],
    ["Unit", metric.unit],
    ["Tier", metric.tier.replaceAll("_", " ")],
    ["Importance", metric.importance],
    ["Direction", metric.direction.replaceAll("_", " ")],
    ["Building block", metric.building_block ? "Yes" : null],
  ];
  const item = (link: Metric["moves_with"][number]) => (
    <li key={link.metric.id} className="flex flex-col gap-1">
      <Link
        className="text-accent underline"
        to="/catalog/metrics/$name"
        params={{ name: link.metric.name }}
      >
        {link.metric.label}
      </Link>
      <span className="text-body text-ink-2">
        {link.movement}: {link.reason}
      </span>
    </li>
  );
  return (
    <div className="metric-documentation flex flex-col gap-6">
      <dl className="grid gap-4">
        {parts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-meta font-medium text-ink-3">{label}</dt>
              <dd className="text-body whitespace-pre-line text-ink">
                {value}
              </dd>
            </div>
          ))}
      </dl>
      {metric.moves_with.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-heading font-semibold text-ink">Moves with</h3>
          <ul className="grid gap-3">
            {metric.moves_with.slice(0, 6).map(item)}
          </ul>
          {metric.moves_with.length > 6 && (
            <details className="print:contents">
              <summary className="cursor-pointer text-accent print:hidden">
                Show all {metric.moves_with.length}
              </summary>
              <ul className="grid gap-3">
                {metric.moves_with.slice(6).map(item)}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
