import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookText, Network } from "lucide-react";
import { Breadcrumb, Crumb } from "../../shell/breadcrumb";
import { PageIcon } from "../../shell/icon-picker";
import { ItemIcon } from "../../shell/item-icon";
import { ErrorState, Loading } from "../../shell/states";
import { AcceptedAnswers } from "../../review/accepted-answers";
import { termQuery } from "../queries";
import { Trust } from "../trust";

export function TermPage({ name }: { name: string }) {
  const q = useQuery(termQuery(name));
  if (q.isPending) return <Loading what="the term" />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <>
      <Breadcrumb
        here={q.data.name}
        icon={<ItemIcon icon={q.data.icon} fallback={BookText} size={14} />}
      >
        <Crumb to="/catalog/terms">Terms</Crumb>
      </Breadcrumb>
      <PageIcon
        kind="term"
        id={q.data.id}
        icon={q.data.icon}
        fallback={BookText}
      />
      <h1 className="text-title font-semibold">{q.data.name}</h1>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-ink-2">
        <span>{q.data.type === "dimension" ? "Dimension" : "Concept"}</span>
        <Trust state={q.data.trust_state} />
      </p>

      <div className="mt-8 flex flex-col gap-4">
        <section aria-labelledby="term-definition">
          <h2 id="term-definition" className="text-meta font-medium text-ink-3">
            Definition
          </h2>
          <p className="mt-1 max-w-(--measure) text-body text-ink">
            {q.data.definition || (
              <span className="text-ink-3">Not written yet</span>
            )}
          </p>
        </section>
        <section aria-labelledby="term-different">
          <h2 id="term-different" className="text-meta font-medium text-ink-3">
            Not the same as
          </h2>
          <p className="mt-1 max-w-(--measure) text-body text-ink">
            {q.data.not_the_same_as || (
              <span className="text-ink-3">Not written yet</span>
            )}
          </p>
        </section>
        <section aria-labelledby="term-aliases">
          <h2 id="term-aliases" className="text-meta font-medium text-ink-3">
            Also called
          </h2>
          {q.data.aliases !== null && q.data.aliases.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-2">
              {q.data.aliases.map((alias) => (
                <li
                  key={alias}
                  className="rounded border border-line bg-bg px-2 py-1 text-meta text-ink"
                >
                  {alias}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-body text-ink-3">Not written yet</p>
          )}
        </section>
        <section aria-labelledby="term-values">
          <h2 id="term-values" className="text-meta font-medium text-ink-3">
            Values
          </h2>
          <Values value={q.data.values} />
        </section>
        <section aria-labelledby="term-columns" className="mt-4">
          <h2 id="term-columns" className="text-heading font-semibold">
            Columns {q.data.columns.length}
          </h2>
          <ul className="mt-3 divide-y divide-line">
            {q.data.columns.map((column) => (
              <li
                key={column.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-mono text-ui">
                    '{column.table.name}'[{column.name}]
                  </p>
                  <Link
                    to="/catalog/datasets/$id"
                    params={{ id: column.dataset.id }}
                    search={{ tab: undefined, table: undefined }}
                    className="text-meta text-accent underline underline-offset-4 hover:text-accent-hover"
                  >
                    {column.dataset.name}
                  </Link>
                </div>
                <Link
                  to="/catalog/datasets/$id"
                  params={{ id: column.dataset.id }}
                  search={{ tab: "diagram", table: column.table.name }}
                  className="inline-flex items-center gap-2 text-ui text-accent underline underline-offset-4 hover:text-accent-hover"
                >
                  <Network size={16} aria-hidden="true" />
                  Show in the diagram
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="term-metrics" className="mt-4">
          <h2 id="term-metrics" className="text-heading font-semibold">
            Metrics {q.data.metrics.length}
          </h2>
          {q.data.metrics.length === 0 ? (
            <p className="mt-3 text-ui text-ink-3">
              No metrics use this term yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {q.data.metrics.map((metric) => (
                <li key={metric.id} className="py-3">
                  <Link
                    to="/catalog/metrics/$name"
                    params={{ name: metric.name }}
                    className="font-medium text-accent underline underline-offset-4 hover:text-accent-hover"
                  >
                    {metric.label}
                  </Link>
                  <p className="mt-1 text-meta text-ink-2">{metric.summary}</p>
                  <p className="mt-1">
                    <Trust state={metric.trust_state} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <AcceptedAnswers answers={q.data.accepted_answers} />
      </div>
    </>
  );
}

function Values({ value }: { value: unknown }) {
  const values = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "object" && value !== null
      ? Object.entries(value).map(([key, meaning]) =>
          typeof meaning === "string" ? `${key}: ${meaning}` : key,
        )
      : [];
  return values.length === 0 ? (
    <p className="mt-1 text-body text-ink-3">Not written yet</p>
  ) : (
    <ul className="mt-1 flex flex-wrap gap-2">
      {values.map((item) => (
        <li
          key={item}
          className="rounded border border-line bg-bg px-2 py-1 font-mono text-meta"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}
