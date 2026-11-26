import { isDeepStrictEqual } from "node:util";
import { currentConventions } from "../conventions/store.js";
import { and, asc, eq, exists, isNull, or, sql } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { metric, metricFollow } from "../../db/schema/book.js";
import { visibleMetric } from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import { executeDax } from "../queries/execute.js";
import { getMetric } from "./metrics.js";
import { requirePerson } from "./ownership.js";
import { listVariants } from "./variants.js";

export async function myMetrics(
  context: ServiceContext,
  options: {
    with_values?: boolean;
    dataset?: string;
    previous_period?: string;
    currency?: string;
    after?: string;
    limit?: number;
  } = {},
) {
  const person = requirePerson(context);
  const periods = (await currentConventions(context.db)).variants.axes.period
    .values;
  const previousPeriod =
    options.previous_period ??
    (periods.includes("previous_year") ? "previous_year" : undefined);
  const allowed = await context.access.describableDatasets(context.principal);
  const limit = Math.min(options.limit ?? 20, 50);
  const rows = await context.db
    .select({ id: metric.id, name: metric.name })
    .from(metric)
    .where(
      and(
        isNull(metric.dismissed_at),
        visibleMetric(context.db, allowed, !(await readsPii(context))),
        options.after === undefined
          ? undefined
          : sql`${metric.name} > ${options.after}`,
        or(
          eq(metric.owner_person, person),
          exists(
            context.db
              .select({ one: sql`1` })
              .from(metricFollow)
              .where(
                and(
                  eq(metricFollow.metric_id, metric.id),
                  eq(metricFollow.person_id, person),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(metric.name))
    .limit(limit + 1);
  const items = [];
  for (const row of rows.slice(0, limit)) {
    const documentation = await getMetric(context, row.id);
    const values = [];
    let note: string | null = null;
    if (options.with_values) {
      if (
        !previousPeriod ||
        previousPeriod === "current" ||
        !periods.includes(previousPeriod)
      )
        note =
          "Choose previous_period from the conventions before comparing values.";
      else {
        const current = await listVariants(context, row.id, {
          dataset: options.dataset,
          currency: options.currency,
          period: "current",
          comparison: "none",
          limit: 2,
        });
        const previous = await listVariants(context, row.id, {
          dataset: options.dataset,
          currency: options.currency,
          period: previousPeriod,
          comparison: "none",
          limit: 2,
        });
        const a = current.items[0];
        const b = previous.items[0];
        if (
          !a ||
          !b ||
          current.items.length !== 1 ||
          previous.items.length !== 1 ||
          a.dataset.id !== b.dataset.id ||
          a.shift.currency !== b.shift.currency ||
          !isDeepStrictEqual(a.shift.custom_axes, b.shift.custom_axes) ||
          a.reads_selection ||
          b.reads_selection
        )
          note =
            "Choose one dataset and currency with matching current and previous-period variants that need no report selection.";
        else
          for (const variant of [a, b])
            values.push({
              period: variant.shift.period,
              result: await executeDax(context, {
                dataset: variant.dataset.id,
                dax: `EVALUATE ROW("Value", ${variant.measure_reference})`,
                purpose: `Check my metric ${row.name} (${variant.shift.period})`,
                preview_rows: 1,
              }),
            });
      }
    }
    items.push({
      ...documentation,
      page: new URL(
        `/catalog/metrics/${encodeURIComponent(row.name)}`,
        context.config.public_base_url,
      ).href,
      values,
      note,
    });
  }
  return {
    items,
    next_cursor: rows.length > limit ? (rows[limit - 1]?.name ?? null) : null,
  };
}
