import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Me } from "../api/me";
import { CheckMessage, RuleId } from "./check-message";
import { humanize, mayCurate } from "./format";
import { Approve } from "./trust";
import { checksQuery, type Metric } from "./queries";

type CategoryLink = { path: string; name: string };

/** The metric's properties and the curator's one browser-only approval action. */
export function Panel({
  metric,
  me,
  categoryLinks = [],
}: {
  metric: Metric;
  me: Me;
  categoryLinks?: CategoryLink[];
}) {
  return (
    <aside className="flex flex-col gap-6">
      <Approve metric={metric} me={me} />
      <dl className="flex flex-col gap-4">
        <Property term="Unit">
          {metric.unit ?? <span className="text-ink-3">None</span>}
        </Property>
        <Property term="Category">
          {categoryLinks.length === 0 ? (
            <span className="text-ink-3">None</span>
          ) : (
            <nav aria-label="Category">
              {categoryLinks.map((category, index) => (
                <span key={category.path}>
                  {index > 0 && " / "}
                  <Link
                    to="/catalog/categories/$"
                    params={{ _splat: category.path }}
                    className="underline underline-offset-4 hover:text-accent"
                  >
                    {category.name}
                  </Link>
                </span>
              ))}
            </nav>
          )}
        </Property>
        <Property term="Owner">
          {metric.owner_person
            ? `${metric.owner_person.name}${metric.owner_person.title ? `, ${metric.owner_person.title}` : ""}${metric.owner_person.left ? " (left)" : ""}`
            : (metric.owner ?? <span className="text-ink-3">Nobody yet</span>)}
        </Property>
        <Property term="Also called">
          {metric.aliases === null || metric.aliases.length === 0 ? (
            <span className="text-ink-3">Nothing else</span>
          ) : (
            metric.aliases.join(", ")
          )}
        </Property>
        <Property term="Terms">
          {metric.terms.length === 0 ? (
            <span className="text-ink-3">None</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {metric.terms.map((term) => (
                <li key={term.id}>
                  <Link
                    to="/catalog/terms/$term"
                    params={{ term: term.name }}
                    className="underline underline-offset-4 hover:text-accent"
                  >
                    {term.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Property>
      </dl>
      <Checks metric={metric} me={me} />
    </aside>
  );
}

function Checks({ metric, me }: { metric: Metric; me: Me }) {
  const all = useQuery({ ...checksQuery(metric.name), enabled: mayCurate(me) });
  const checks =
    all.data ??
    metric.failing_checks.map((failing) => ({ ...failing, passed: false }));
  const ordered = checks.toSorted(
    (a, b) => Number(a.passed) - Number(b.passed),
  );
  return (
    <section aria-labelledby="checks-heading" className="flex flex-col gap-2">
      <h2 id="checks-heading" className="text-heading font-semibold text-ink">
        Checks
      </h2>
      {all.error !== null && (
        <p role="alert" className="text-ui text-ink-2">
          The checks could not be loaded: {all.error.message}
        </p>
      )}
      {ordered.length === 0 ? (
        <p className="text-ui text-ink-2">No check fails.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ordered.map(({ check, rule, message, passed, other_labels }) => (
            <li key={`${check}:${rule}`} className="text-ui">
              <span className="font-medium text-ink">
                {humanize(check)}: {passed ? "passes" : "fails"}
              </span>
              {passed ? (
                <RuleId rule={rule} />
              ) : (
                <div className="mt-0.5 text-ink-2">
                  <CheckMessage
                    message={message}
                    rule={rule}
                    otherLabels={other_labels}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Property({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-meta font-medium text-ink-3">{term}</dt>
      <dd className="text-ui break-words text-ink">{children}</dd>
    </div>
  );
}
