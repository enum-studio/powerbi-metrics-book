import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "../../admin/layout/ui";
import { ErrorState, Loading } from "../../shell/states";
import { metricPagesQuery, type MetricFilter } from "../queries";
import { MetricRow } from "./metric-row";

/** One list of metrics a page at a time: a real book holds thousands, and most are never scrolled to. */
export function MetricList({
  filter,
  total,
}: {
  filter: MetricFilter;
  /** Undefined while the count is still on its way. */
  total: number | undefined;
}) {
  const list = useInfiniteQuery(metricPagesQuery(filter));
  if (list.data === undefined)
    return list.error ? (
      <ErrorState error={list.error} />
    ) : (
      <Loading what="the metrics" />
    );
  const metrics = list.data.pages.flatMap((page) => page.items);
  return (
    <>
      {metrics.map((metric) => (
        <MetricRow key={metric.name} metric={metric} />
      ))}
      {list.hasNextPage && (
        <div className="flex items-center gap-3 py-3">
          <Button
            disabled={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            Show more
          </Button>
          {total !== undefined && (
            <span className="text-meta text-ink-3">
              {metrics.length.toLocaleString("en")} of{" "}
              {total.toLocaleString("en")}
            </span>
          )}
        </div>
      )}
      {list.isFetchNextPageError && (
        <p role="alert" className="text-ui text-ink-2">
          The next metrics could not be loaded. Show more tries again.
        </p>
      )}
    </>
  );
}
