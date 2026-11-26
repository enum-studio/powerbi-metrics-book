import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "../../api/schema";
type Metric = components["schemas"]["MetricDocument"];
import { ErrorState, Loading } from "../../shell/states";
import { guideQuery } from "./queries";
import { Exports } from "./exports";
import { MetricDocumentation } from "./documentation";

function MetricCard({ metric }: { metric: Metric }) {
  return (
    <article className="break-inside-avoid rounded-lg border border-line bg-surface p-4">
      <p className="text-meta text-ink-3">
        {metric.category?.name ? `${metric.category.name} · ` : ""}
        {metric.tier.replaceAll("_", " ")} · {metric.importance}
      </p>
      <Link
        to="/catalog/metrics/$name"
        params={{ name: metric.name }}
        className="text-heading font-semibold text-accent"
      >
        {metric.label}
      </Link>
      <p className="mt-2 text-body text-ink-2">{metric.definition}</p>
    </article>
  );
}

export function GuidePage() {
  const query = useQuery(guideQuery);
  if (query.isPending) return <Loading what="the metrics guide" />;
  if (query.error) return <ErrorState error={query.error} />;
  const guide = query.data;
  const groups = [...new Set(guide.glossary.map((t) => t.group ?? "Glossary"))];
  return (
    <div className="metrics-guide flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <p className="text-meta text-ink-3">The metrics book</p>
        <h1 className="text-title font-semibold text-ink">
          How the business works
        </h1>
        <p className="text-body text-ink-2">
          Start with the result, explore each area, then read the definitions
          behind the numbers.
        </p>
        <Exports />
      </header>
      {guide.sum && (
        <section className="flex flex-col gap-4">
          <h2 className="text-heading font-semibold text-ink">
            One sum behind every number
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <MetricCard metric={guide.sum} />
            <span>=</span>
            {guide.sum.edges.map((edge, index) => (
              <div key={edge.metric.id} className="flex items-center gap-3">
                <span>
                  {edge.operation === "product"
                    ? `${index > 0 ? "× " : ""}${edge.sign === -1 ? "−" : ""}`
                    : edge.sign === -1
                      ? "−"
                      : index > 0
                        ? "+"
                        : ""}
                </span>
                <Link
                  className="rounded-lg border border-line p-4 text-accent"
                  to="/catalog/metrics/$name"
                  params={{ name: edge.metric.name }}
                >
                  <span className="block text-meta text-ink-3">
                    {
                      guide.metrics.find(
                        (metric) => metric.id === edge.metric.id,
                      )?.category?.name
                    }
                  </span>
                  {edge.metric.label}
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}
      {guide.areas.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-heading font-semibold text-ink">
            The areas at a glance
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {guide.areas.map((area) => (
              <article
                key={area.id}
                className="rounded-lg border border-line p-5"
              >
                <p className="text-meta text-ink-3">{area.kicker}</p>
                <h3 className="text-heading font-semibold text-ink">
                  {area.name}
                </h3>
                <p className="my-3 text-body text-ink-2">{area.question}</p>
                <ul className="flex flex-col gap-2">
                  {area.headlines.map((m) => (
                    <li key={m.id}>
                      <Link
                        className="text-accent underline"
                        to="/catalog/metrics/$name"
                        params={{ name: m.name }}
                      >
                        {m.label}
                      </Link>
                    </li>
                  ))}
                </ul>
                <a
                  className="mt-4 block text-meta text-ink-3"
                  href={`#area-${area.id}`}
                >
                  {area.metrics.length} metrics in {area.name}
                </a>
              </article>
            ))}
          </div>
        </section>
      )}
      {guide.naming.case !== "none" && (
        <section className="flex flex-col gap-3">
          <h2 className="text-heading font-semibold text-ink">
            How to read a metric's name
          </h2>
          <p className="text-body text-ink-2">
            Kind, subject, then{" "}
            {guide.naming.qualifier_order.join(", ").replaceAll("_", " ")}.
            Money qualifiers: {guide.naming.money_qualifier.values.join(", ")}.
          </p>
          <ul className="grid gap-2 md:grid-cols-2">
            {guide.naming.kinds.map((kind) => (
              <li key={kind} className="font-mono text-ui text-ink">
                {kind}:{" "}
                {kind.endsWith("_") ? `${kind}subject` : `subject${kind}`}
              </li>
            ))}
          </ul>
        </section>
      )}
      {guide.areas.map((area) => (
        <section
          id={`area-${area.id}`}
          key={area.id}
          className="flex flex-col gap-4"
        >
          <h2 className="text-heading font-semibold text-ink">{area.name}</h2>
          <p className="text-body text-ink-2">{area.description}</p>
          <div className="grid gap-3">
            {area.metrics.slice(0, 3).map((m) => (
              <MetricCard key={m.id} metric={m} />
            ))}
          </div>
          {area.metrics.length > 3 && (
            <details className="print:contents">
              <summary className="cursor-pointer text-accent print:hidden">
                Show all {area.metrics.length}
              </summary>
              <div className="mt-3 grid gap-3">
                {area.metrics.slice(3).map((m) => (
                  <MetricCard key={m.id} metric={m} />
                ))}
              </div>
            </details>
          )}
        </section>
      ))}
      {guide.featured && (
        <section className="flex flex-col gap-4">
          <p className="text-meta text-ink-3">One metric up close</p>
          <h2 className="text-heading font-semibold text-ink">
            <Link
              to="/catalog/metrics/$name"
              params={{ name: guide.featured.name }}
            >
              {guide.featured.label}
            </Link>
          </h2>
          <MetricDocumentation metric={guide.featured} />
        </section>
      )}
      {guide.glossary.length > 0 && (
        <section className="flex flex-col gap-6">
          <h2 className="text-heading font-semibold text-ink">The glossary</h2>
          {groups.map((group) => (
            <section key={group} className="flex flex-col gap-4">
              <h3 className="text-heading text-ink">{group}</h3>
              {guide.glossary
                .filter((t) => (t.group ?? "Glossary") === group)
                .map((term) => (
                  <article key={term.id}>
                    <Link
                      to="/catalog/terms/$term"
                      params={{ term: term.name }}
                      className="font-semibold text-accent"
                    >
                      {term.name}
                    </Link>
                    <p className="text-body text-ink-2">{term.definition}</p>
                    <p className="text-meta">
                      {term.metrics.map((m, i) => (
                        <span key={m.id}>
                          {i > 0 && ", "}
                          <Link
                            to="/catalog/metrics/$name"
                            params={{ name: m.name }}
                          >
                            {m.name}
                          </Link>
                        </span>
                      ))}
                    </p>
                  </article>
                ))}
            </section>
          ))}
        </section>
      )}
    </div>
  );
}
