import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Me } from "../api/me";
import { bookSummaryQuery } from "../catalog/queries";
import { Filters } from "../catalog/search/filters";
import type { HomeSearch } from "../catalog/search/model";
import { searchQuery } from "../catalog/search/queries";
import { Results } from "../catalog/search/results";
import { ErrorState, Loading } from "../shell/states";
import { LINK } from "../setup/parts";
import { useDemo } from "../shell/demo";
import { plural } from "../shell/plural";
import { ChecksLine, SetupNotice } from "./setup-notice";

const EXAMPLES = [
  "which metric is revenue",
  "orders by month",
  "net sales in EUR",
  "what does churn mean",
];
/** The result links a person can reach, in page order; a closed section holds none. */
function searchRows(root: HTMLElement | null) {
  return [
    ...(root?.querySelectorAll<HTMLAnchorElement>("[data-search-row]") ?? []),
  ].filter((row) => !row.closest("details:not([open])"));
}
export function Home({ me, search = {} }: { me: Me; search?: HomeSearch }) {
  const { q = "", ...filters } = search;
  const demo = useDemo();
  const navigate = useNavigate();
  const [value, setValue] = useState(q);
  const box = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  // Only a search from elsewhere replaces what is typed while navigation catches up.
  const asked = useRef(q);
  useEffect(() => {
    if (q !== asked.current) {
      asked.current = q;
      setValue(q);
    }
  }, [q]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const typed = value.trim();
      if (typed === asked.current) return;
      asked.current = typed;
      void navigate({
        to: "/",
        search: { ...search, q: typed },
        replace: true,
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, search, navigate]);
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) box.current?.focus();
    const focus = (event: KeyboardEvent) => {
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select") || target.isContentEditable);
      if (
        (event.key === "/" && !editing) ||
        (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        box.current?.focus();
      }
    };
    document.addEventListener("keydown", focus, true);
    return () => {
      document.removeEventListener("keydown", focus, true);
    };
  }, []);
  const result = useQuery(searchQuery(q, { ...filters, limit: 50 }));
  // One result is a tab stop, so Tab reaches the list and the arrows rove from there.
  useEffect(() => {
    const rows = searchRows(results.current);
    const first = rows[0];
    if (first && !rows.some((row) => row.tabIndex === 0)) first.tabIndex = 0;
  }, [result.data]);
  const { data: summary } = useSuspenseQuery(bookSummaryQuery);
  const { draft, agent_verified, human_verified } = summary.metrics;
  const verified = agent_verified + human_verified;
  const total = draft + verified;
  const count = result.data
    ? Object.values(result.data.counts).reduce((sum, n) => sum + n, 0)
    : undefined;
  const curates = me.may_admin || me.roles.includes("curator");
  return (
    <div
      className="mx-auto flex w-full max-w-(--read-max) flex-col gap-6"
      ref={results}
      onKeyDown={(event) => {
        const rows = searchRows(results.current);
        const current = rows.findIndex((row) => row === document.activeElement);
        if (event.key === "Escape" && current >= 0) {
          event.preventDefault();
          box.current?.focus();
        }
        if (
          (event.key === "ArrowDown" || event.key === "ArrowUp") &&
          (current >= 0 || event.target === box.current)
        ) {
          event.preventDefault();
          const next =
            rows[
              Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  current + (event.key === "ArrowDown" ? 1 : -1),
                ),
              )
            ];
          rows.forEach((row) => {
            row.tabIndex = row === next ? 0 : -1;
          });
          next?.focus();
        }
      }}
      onFocus={(event) => {
        const target = event.target;
        if (
          !(target instanceof HTMLAnchorElement) ||
          !target.hasAttribute("data-search-row")
        )
          return;
        results.current
          ?.querySelectorAll<HTMLAnchorElement>("[data-search-row]")
          .forEach((row) => {
            row.tabIndex = row === target ? 0 : -1;
          });
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-title font-semibold text-ink">Search</h1>
        {demo ? null : <SetupNotice me={me} />}
      </div>
      <label className="flex h-(--bar-height) w-full items-center gap-2 rounded border border-line-control bg-surface px-3 focus-within:outline-2 focus-within:outline-accent">
        <span className="sr-only">Search the catalog</span>
        <input
          ref={box}
          type="search"
          className="min-w-0 flex-1 self-stretch bg-transparent text-ui text-ink outline-none placeholder:text-ink-3"
          placeholder="Search metrics, terms, datasets, tables and columns"
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
          }}
        />
        {q.length >= 2 && count !== undefined && (
          <span role="status" className="shrink-0 text-meta text-ink-3">
            {plural(count, "result")}
          </span>
        )}
      </label>
      {q.length < 2 ? (
        <>
          <p className="text-ui text-ink-2">
            {total === 0 ? (
              "You can see nothing in the book yet. The first sync may still be running."
            ) : (
              <>
                {plural(total, "metric")} in{" "}
                {plural(summary.datasets, "dataset")}:{" "}
                {verified.toLocaleString("en")} verified,{" "}
                {draft.toLocaleString("en")}{" "}
                {curates ? (
                  <a href="/docs/use/for-curators-drafts/" className={LINK}>
                    drafts
                  </a>
                ) : (
                  "drafts"
                )}
              </>
            )}
          </p>
          <ChecksLine me={me} />
          <ul>
            {EXAMPLES.map((example) => (
              <li key={example}>
                <Link
                  to="/"
                  search={{ q: example }}
                  className="block rounded border-b border-line p-3 text-ui text-ink-2 hover:bg-raised"
                >
                  {example}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <Filters
            value={filters}
            onChange={(next) => {
              void navigate({ to: "/", search: { q, ...next }, replace: true });
            }}
          />
          {result.isPending ? (
            <Loading what="the results" />
          ) : result.isError ? (
            <ErrorState error={result.error} />
          ) : (
            <Results query={q} filters={filters} data={result.data} />
          )}
        </>
      )}
    </div>
  );
}
