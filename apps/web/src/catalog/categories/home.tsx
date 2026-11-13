import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Breadcrumb, Crumb } from "../../shell/breadcrumb";
import { plural } from "../../shell/plural";
import { ErrorState, Loading } from "../../shell/states";
import {
  bookSummaryQuery,
  categoriesQuery,
  metricPagesQuery,
} from "../queries";
import { categoryCounts, type Category } from "../tree/model";
import { MetricList } from "./metric-list";
import { MetricColumnHeads } from "./metric-row";

const NOT_FILED = { not_filed: "true" } as const;

/**
 * The first page and the count are two requests, so they can disagree for a moment:
 * rows in hand beat a count of zero, and a count above zero beats an empty page.
 */
function reconcile(rows: number | undefined, total: number | undefined) {
  return {
    count: rows !== undefined && rows > 0 && total === 0 ? undefined : total,
    empty: rows === 0 && (total === undefined || total === 0),
  };
}

/**
 * A view of /catalog rather than a page of its own: a new path would be one more entry on the public list.
 * Its first page says whether anything is unfiled; the count only adds the number.
 */
function NotFiled({ total }: { total: number | undefined }) {
  const list = useInfiniteQuery(metricPagesQuery(NOT_FILED));
  const rows = list.data?.pages[0]?.items.length;
  const { count, empty } = reconcile(rows, total);
  return (
    <>
      <Breadcrumb here="Not filed">
        <Crumb to="/catalog">Metrics</Crumb>
      </Breadcrumb>
      <h1 className="text-title font-semibold">Not filed</h1>
      {rows !== undefined && (
        <p className="mt-1 max-w-(--measure) text-ui text-ink-2">
          {empty
            ? "Every metric has a category."
            : `${count === undefined ? "Metrics" : plural(count, "metric")} with no category yet. A curator or an agent can file them.`}
        </p>
      )}
      {!empty && (
        <div className="mt-6">
          <MetricColumnHeads />
          <MetricList filter={NOT_FILED} total={count} />
        </div>
      )}
    </>
  );
}

/** Shows once its own first page has rows; the count only adds the number. */
function NotFiledSection({ total }: { total: number | undefined }) {
  const list = useInfiniteQuery(metricPagesQuery(NOT_FILED));
  const { count, empty } = reconcile(list.data?.pages[0]?.items.length, total);
  if (empty) return null;
  if (list.data === undefined)
    return list.error ? (
      <ErrorState error={list.error} />
    ) : (
      <Loading what="the metrics" />
    );
  return (
    <section className="mt-6">
      <h2 className="text-heading font-semibold">
        <Link
          to="/catalog"
          search={{ view: "not-filed" }}
          className="pointer-coarse:inline-flex pointer-coarse:min-h-(--tap) pointer-coarse:items-center"
        >
          Not filed
        </Link>{" "}
        {count !== undefined && (
          <span className="font-mono text-label font-normal text-ink-3">
            {count.toLocaleString("en")}
          </span>
        )}
      </h2>
      <MetricList filter={NOT_FILED} total={count} />
    </section>
  );
}

export function MetricsHome({ notFiledOnly }: { notFiledOnly: boolean }) {
  const cats = useQuery(categoriesQuery),
    summary = useQuery(bookSummaryQuery);
  // A failed count leaves the lists as they are; the tree says so.
  const notFiled = summary.data?.not_filed;
  if (notFiledOnly) return <NotFiled total={notFiled} />;
  if (cats.data === undefined)
    return cats.error ? (
      <ErrorState error={cats.error} />
    ) : (
      <Loading what="the catalog" />
    );
  const tree = cats.data;
  const counts = categoryCounts(tree);
  const groups = (nodes: Category[], depth = 0) =>
    nodes.map((c) => (
      <section key={c.path} className="mt-6" style={{ marginLeft: depth * 20 }}>
        <header>
          <Link
            to="/catalog/categories/$"
            params={{ _splat: c.path }}
            className={`${depth ? "text-ui font-semibold" : "text-heading font-semibold"} pointer-coarse:inline-flex pointer-coarse:min-h-(--tap) pointer-coarse:items-center`}
          >
            {c.name}
          </Link>{" "}
          <span className="font-mono text-label text-ink-3">
            {counts.get(c.path) ?? 0}
          </span>
          <p
            className={
              depth ? "text-meta text-ink-2" : "mt-1 text-ui text-ink-2"
            }
          >
            {c.description}
          </p>
        </header>
        {c.metric_count > 0 && (
          <MetricList filter={{ category: c.path }} total={c.metric_count} />
        )}
        {groups(c.children, depth + 1)}
      </section>
    ));
  return (
    <>
      <header>
        <h1 className="text-title font-semibold">Metrics</h1>
        <p className="mt-1 max-w-(--measure) text-ui text-ink-2">
          What each number means, and the Power BI measures that compute it,
          filed by category. Agents answer from these first.
        </p>
      </header>
      <div className="mt-6">
        <MetricColumnHeads />
        {groups(tree)}
        <NotFiledSection total={notFiled} />
      </div>
    </>
  );
}
