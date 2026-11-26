import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { BookText, ChartNoAxesColumn, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { metricQuery } from "../../review/queries";
import { FoldArrow, useFold } from "../../shell/fold";
import { ItemIcon } from "../../shell/item-icon";
import {
  FOLD_LINK,
  FOLD_ROW,
  FOLD_ROW_CURRENT,
  indent,
  NAV_ROW,
  showCurrentRow,
  STANDS_FOR_PAGE,
} from "../../shell/nav-row";
import { ErrorState } from "../../shell/states";
import {
  bookSummaryQuery,
  categoriesQuery,
  metricPagesQuery,
} from "../queries";
import { categoryCounts, categoryTrail, type Category } from "./model";
import { exportsQuery } from "../guide/queries";
import { DatasetsBranch } from "./datasets";
import { useOpenRows } from "./open-rows";

const CATEGORY_PAGE = "/catalog/categories/";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

/** An open category's own metrics, asked for only once it is open; a long list goes on a page at a time. */
function CategoryMetrics({
  category,
  depth,
}: {
  category: Category;
  depth: number;
}) {
  const list = useInfiniteQuery(metricPagesQuery({ category: category.path }));
  if (list.error && list.data === undefined)
    return <ErrorState error={list.error} />;
  const metrics = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      {metrics.map((m) => (
        <Link
          key={m.name}
          to="/catalog/metrics/$name"
          params={{ name: m.name }}
          title={m.label}
          className={NAV_ROW}
          style={indent(depth, false)}
        >
          <ItemIcon icon={m.icon} fallback={ChartNoAxesColumn} />
          <span className="truncate">{m.label}</span>
        </Link>
      ))}
      {list.hasNextPage && (
        <button
          type="button"
          disabled={list.isFetchingNextPage}
          className={`${NAV_ROW} justify-between text-left`}
          style={indent(depth, false)}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage ? "Loading" : "Show more"}
          <span className="font-mono text-label font-normal text-ink-3">
            {(category.metric_count - metrics.length).toLocaleString("en")}
          </span>
        </button>
      )}
      {list.isFetchNextPageError && <ErrorState error={list.error} />}
    </>
  );
}

export function CatalogTree() {
  const available = useQuery(exportsQuery);
  const location = useLocation();
  const path = location.pathname;
  const onMetric = path.startsWith("/catalog/metrics/");
  const inMetrics =
    path === "/catalog" ||
    path === "/catalog/guide" ||
    onMetric ||
    path.startsWith(CATEGORY_PAGE);
  const [metricsOpen, setMetricsOpen] = useFold(inMetrics);
  const categories = useQuery(categoriesQuery),
    summary = useQuery(bookSummaryQuery);
  const selected = path.startsWith(CATEGORY_PAGE)
    ? decodeURIComponent(path.slice(CATEGORY_PAGE.length))
    : onMetric
      ? (path.split("/").at(-1) ?? "")
      : "";
  const shown = useQuery({ ...metricQuery(selected), enabled: onMetric });
  // While the next metric loads, the tree stays as it is rather than closing and opening again.
  const [lastTrail, setLastTrail] = useState("");
  const loading = onMetric && shown.isPending;
  // A metric with no category has no row of its own here; it is one of what is not filed.
  const unfiled = onMetric && shown.isSuccess && !shown.data.category;
  const trailTo = loading
    ? lastTrail
    : onMetric
      ? (shown.data?.category?.path ?? "")
      : selected;
  useEffect(() => {
    setLastTrail(trailTo);
  }, [trailTo]);
  // The same pages CategoryMetrics shows, so the tree knows whether this metric has a row yet.
  const metricCategory = onMetric ? shown.data?.category?.path : undefined;
  const listedHere = useInfiniteQuery({
    ...metricPagesQuery({ category: metricCategory ?? "" }),
    enabled: metricCategory !== undefined,
  });
  const metricListed =
    listedHere.data?.pages.some((page) =>
      page.items.some((m) => m.name === selected),
    ) ?? false;
  const tree = categories.data ?? [];
  const counts = categoryCounts(tree);
  const trail = categoryTrail(tree, trailTo);
  const { open, toggle } = useOpenRows(
    trail,
    path,
    categories.data !== undefined && !loading,
  );
  // The row that stands for this page while its own is not showing: the first
  // folded category on the way to it, or the category of a metric past the pages loaded.
  const standIn = loading
    ? undefined
    : (trail.slice(0, onMetric ? undefined : -1).find((p) => !open.has(p)) ??
      (listedHere.isSuccess && !metricListed ? metricCategory : undefined));
  // The row for this page is brought into view, once the rows are there.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (categories.isSuccess) showCurrentRow(nav.current);
  }, [path, categories.isSuccess, standIn, listedHere.isSuccess]);
  const rows = (nodes: Category[], depth: number) =>
    nodes.map((c) => (
      <div key={c.path} className="flex flex-col gap-0.5">
        <div
          className={`${FOLD_ROW} ${FOLD_ROW_CURRENT}`}
          style={indent(depth)}
        >
          <FoldArrow
            open={open.has(c.path)}
            label={`${open.has(c.path) ? "Close" : "Open"} ${c.name}`}
            onClick={() => {
              toggle(c.path);
            }}
          />
          <Link
            to="/catalog/categories/$"
            params={{ _splat: c.path }}
            activeOptions={{ exact: true }}
            title={c.name}
            className={FOLD_LINK}
            {...(standIn === c.path ? STANDS_FOR_PAGE : {})}
          >
            <ItemIcon icon={c.icon} fallback={Folder} />
            <span className="truncate">{c.name}</span>
          </Link>
          <span className="pr-2 font-mono text-label text-ink-3">
            {counts.get(c.path) ?? 0}
          </span>
        </div>
        {open.has(c.path) && (
          <>
            {rows(c.children, depth + 1)}
            {c.metric_count > 0 && (
              <CategoryMetrics category={c} depth={depth + 1} />
            )}
          </>
        )}
      </div>
    ));
  return (
    <nav
      ref={nav}
      aria-label="Catalog"
      className="flex flex-col gap-0.5 px-2 pb-2"
    >
      <div className={`${FOLD_ROW} ${FOLD_ROW_CURRENT}`}>
        <FoldArrow
          open={metricsOpen}
          label={metricsOpen ? "Close Metrics" : "Open Metrics"}
          onClick={() => {
            setMetricsOpen(!metricsOpen);
          }}
        />
        <Link
          to="/catalog"
          activeOptions={{ exact: true }}
          className={FOLD_LINK}
          {...(inMetrics && !metricsOpen ? STANDS_FOR_PAGE : {})}
        >
          <ChartNoAxesColumn {...ICON} />
          Metrics
        </Link>
      </div>
      {metricsOpen && (
        <>
          {available.data?.guide && (
            <Link
              to="/catalog/guide"
              className={NAV_ROW}
              style={indent(1, false)}
            >
              Reading guide
            </Link>
          )}
          {categories.error && <ErrorState error={categories.error} />}
          {categories.isPending && (
            <p className="appear-late px-2 py-1 text-meta text-ink-3">
              Loading the categories
            </p>
          )}
          {rows(tree, 1)}
          {summary.error && summary.data === undefined && (
            <ErrorState error={summary.error} />
          )}
          {summary.data !== undefined && summary.data.not_filed > 0 && (
            <Link
              to="/catalog"
              search={{ view: "not-filed" }}
              activeOptions={{ exact: true }}
              className={`${NAV_ROW} justify-between`}
              style={indent(1, false)}
              {...(unfiled ? STANDS_FOR_PAGE : {})}
            >
              Not filed
              <span className="font-mono text-label font-normal text-ink-3">
                {summary.data.not_filed.toLocaleString("en")}
              </span>
            </Link>
          )}
        </>
      )}
      <Link to="/catalog/terms" className={NAV_ROW} style={indent(0, false)}>
        <BookText {...ICON} />
        Terms
      </Link>
      <DatasetsBranch />
    </nav>
  );
}
