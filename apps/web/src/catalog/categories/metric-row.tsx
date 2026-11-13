import { Link } from "@tanstack/react-router";
import { ChartNoAxesColumn } from "lucide-react";
import { ItemIcon } from "../../shell/item-icon";
import type { MetricListItem } from "../tree/model";
import { Trust } from "../trust";

// On a phone, one column: the metric's name gets the width, and its trust sits under the summary, as Linear and Jira list issues.
const columns =
  "grid grid-cols-1 gap-3 px-3 md:grid-cols-[minmax(12rem,1fr)_5rem_5rem_10rem]";
const WIDE = "hidden md:block";

export function MetricColumnHeads() {
  return (
    <div
      className={`${columns} hidden border-b border-line py-2 text-meta text-ink-3 md:grid`}
    >
      <span>Metric</span>
      <span>Unit</span>
      <span>Datasets</span>
      <span>Trust</span>
    </div>
  );
}

export function MetricRow({ metric }: { metric: MetricListItem }) {
  return (
    <Link
      to="/catalog/metrics/$name"
      params={{ name: metric.name }}
      className={`${columns} border-b border-line py-2.5 hover:bg-raised`}
    >
      <span className="flex items-start gap-2">
        <span className="mt-0.5">
          <ItemIcon icon={metric.icon} fallback={ChartNoAxesColumn} />
        </span>
        <span>
          <span className="font-medium">{metric.label}</span>
          <small className="block text-meta text-ink-2">{metric.summary}</small>
          <span className="block md:hidden">
            <Trust state={metric.trust_state} />
          </span>
        </span>
      </span>
      <span className={`${WIDE} font-mono text-meta`}>
        {metric.unit ?? "—"}
      </span>
      <span className={`${WIDE} text-meta`}>{metric.dataset_count}</span>
      <span className={WIDE}>
        <Trust state={metric.trust_state} />
      </span>
    </Link>
  );
}
