import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Breakable } from "../../shell/breakable";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { Trust } from "../trust";
import { HitIcon } from "./hit";
import {
  hitPage,
  hitTitle,
  KIND_NAME,
  markWords,
  SECTIONS,
  stepPage,
  type SearchAnswer,
  type SearchFilters,
  type SearchHit,
} from "./model";
import { searchQuery } from "./queries";

/** On a phone the best match's name is a heading, not a page title: a long one would take four lines and push the rest down. */
const BEST_TITLE = "min-w-0 text-heading font-semibold text-ink sm:text-title";

function Summary({ hit, query }: { hit: SearchHit; query: string }) {
  return markWords(hit.summary, query).map((part, index) =>
    part.marked ? (
      <mark key={index} className="bg-accent-soft text-ink">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}
/** What a hit shows, with no link of its own: the dialog's option wraps it, so the listbox holds nothing focusable. */
export function ResultBody({ hit, query }: { hit: SearchHit; query: string }) {
  return (
    <>
      <HitIcon kind={hit.kind} icon={hit.icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-semibold text-ink">
          {hitTitle(hit)}
        </span>
        <span className="flex gap-2 text-meta text-ink-3">
          {hit.trust_state && (
            <span className="shrink-0 sm:hidden">
              <Trust state={hit.trust_state} />
            </span>
          )}
          <span className="truncate">
            {hit.path.map((part) => part.name).join(" / ")}
          </span>
        </span>
        <span className="block truncate text-ui text-ink-2">
          <Summary hit={hit} query={query} />
        </span>
      </span>
      {hit.trust_state && (
        <span className="hidden shrink-0 sm:block">
          <Trust state={hit.trust_state} />
        </span>
      )}
    </>
  );
}
export function ResultRow({ hit, query }: { hit: SearchHit; query: string }) {
  const page = hitPage(hit);
  const className = "flex items-start gap-3 rounded p-3";
  if (!page)
    return (
      <div className={className}>
        <ResultBody hit={hit} query={query} />
      </div>
    );
  return (
    <Link
      {...page}
      data-search-row
      tabIndex={-1}
      className={`${className} hover:bg-raised focus-visible:outline-accent`}
    >
      <ResultBody hit={hit} query={query} />
    </Link>
  );
}
function HitPath({
  hit,
  query,
  filters,
}: {
  hit: SearchHit;
  query: string;
  filters: SearchFilters;
}) {
  return (
    <nav
      aria-label="Best match path"
      className="flex flex-wrap text-meta text-ink-3"
    >
      {hit.path.map((part, index) => {
        const page = stepPage(hit, index);
        return (
          <span key={`${part.kind}:${part.id}`}>
            {index > 0 && (
              <span aria-hidden="true" className="px-1.5">
                /
              </span>
            )}
            {part.kind === "workspace" ? (
              <Link
                to="/"
                search={{ ...filters, q: query, workspace: part.id }}
              >
                {part.name}
              </Link>
            ) : page ? (
              <Link {...page}>{part.name}</Link>
            ) : (
              part.name
            )}
          </span>
        );
      })}
    </nav>
  );
}
function Section({
  kind,
  label,
  count,
  items,
  best,
  query,
  filters,
  only,
}: {
  kind: SearchHit["kind"];
  label: string;
  count: number;
  items: SearchHit[];
  best?: SearchHit;
  query: string;
  filters: SearchFilters;
  only: boolean;
}) {
  const [all, setAll] = useState(false);
  const expanded = useQuery({
    ...searchQuery(query, {
      ...filters,
      kind: kind === "variant" ? "measure" : kind,
      limit: 50,
    }),
    enabled: all,
  });
  const hits = (all && expanded.data ? expanded.data.items : items).filter(
    (hit) =>
      hit.kind === kind && !(hit.kind === best?.kind && hit.id === best.id),
  );
  // The page holds the best hits of every kind together, so a section can hold fewer than its count says exist.
  const more = count - (best?.kind === kind ? 1 : 0) > Math.min(hits.length, 5);
  return (
    <details
      open={only || kind === "metric" || kind === "variant" || kind === "term"}
      className="border-t border-line py-3"
    >
      <summary className="cursor-pointer text-ui font-semibold text-ink">
        {label} ({count})
      </summary>
      {(kind === "metric" || kind === "term") && (
        <Link
          to={kind === "metric" ? "/catalog" : "/catalog/terms"}
          className="text-meta text-ink-3"
        >
          Browse all
        </Link>
      )}
      <ul>
        {(all ? hits : hits.slice(0, 5)).map((hit) => (
          <li key={`${hit.kind}:${hit.id}`}>
            <ResultRow hit={hit} query={query} />
          </li>
        ))}
      </ul>
      {!all && more && (
        <button
          type="button"
          className="text-ui text-ink-2"
          onClick={() => {
            setAll(true);
          }}
        >
          Show all {count}
        </button>
      )}
      {all && expanded.isPending && <Loading what="the results" />}
      {all && expanded.isError && <ErrorState error={expanded.error} />}
    </details>
  );
}
export function Results({
  query,
  filters = {},
  data,
}: {
  query: string;
  filters?: SearchFilters;
  data: SearchAnswer;
}) {
  if (data.items.length === 0)
    return (
      <EmptyState title="Nothing matches">
        Try other words, or fewer. Agents search the same index.
      </EmptyState>
    );
  const first = data.items[0];
  const best =
    first?.match === "exact" || first?.match === "words" ? first : undefined;
  const bestPage = best && hitPage(best);
  const sections = SECTIONS.filter(({ kind }) => (data.counts[kind] ?? 0) > 0);
  return (
    <div className="flex flex-col gap-3">
      {data.search_mode === "words_only" && data.note && (
        <p className="text-ui text-ink-2">{data.note}</p>
      )}
      {best && (
        <section
          aria-label="Best match"
          className="rounded border border-line p-4"
        >
          <h2 className="text-meta text-ink-3">Best match</h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex min-w-0 items-center gap-2 max-sm:basis-full">
              <HitIcon kind={best.kind} icon={best.icon} />
              {bestPage ? (
                <Link
                  {...bestPage}
                  data-search-row
                  tabIndex={-1}
                  className={BEST_TITLE}
                >
                  <Breakable text={hitTitle(best)} />
                </Link>
              ) : (
                <span className={BEST_TITLE}>
                  <Breakable text={hitTitle(best)} />
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
              <span className="rounded bg-raised px-2 text-meta text-ink-2">
                {KIND_NAME[best.kind]}
              </span>
              {best.trust_state && <Trust state={best.trust_state} />}
            </span>
          </div>
          <p className="line-clamp-2 text-ui text-ink-2">
            <Summary hit={best} query={query} />
          </p>
          <HitPath hit={best} query={query} filters={filters} />
        </section>
      )}
      {sections.map(({ kind, label }) => (
        <Section
          key={`${query}:${kind}:${JSON.stringify(filters)}`}
          kind={kind}
          label={label}
          count={data.counts[kind] ?? 0}
          items={data.items}
          best={best}
          query={query}
          filters={filters}
          only={sections.length === 1}
        />
      ))}
    </div>
  );
}
