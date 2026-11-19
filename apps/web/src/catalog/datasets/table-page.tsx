import { useQuery } from "@tanstack/react-query";
import { Table2 } from "lucide-react";
import { ApiError } from "../../api/client";
import { Breakable } from "../../shell/breakable";
import { plural } from "../../shell/plural";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { formatTime } from "../../shell/time";
import { datasetQuery, tableFieldsQuery } from "../queries";
import { Documentation } from "./documentation";
import { FieldList, tableFields } from "./field-list";
import { FieldBreadcrumb, NoSuchField } from "./folder-page";
import { Facts } from "./header";
import { diagramModel } from "./model";
import { piiHiddenQuery } from "./queries";
import { TableRelationships } from "./relationships-tab";
import { PageTabs } from "./tabs";

export const TABLE_TABS = [
  "documentation",
  "columns",
  "measures",
  "relationships",
] as const;
export type TableTab = (typeof TABLE_TABS)[number];

const KIND = {
  measures: "Measures table",
  date: "Date table",
  fact: "Fact table",
  dimension: "Dimension table",
  standalone: "Standalone table",
} as const;

/**
 * A table of a dataset: its documentation first, then its columns, measures
 * and relationships. The diagram belongs to the dataset's page and has no tab
 * here.
 */
export function TablePage({
  id,
  table,
  tab = "documentation",
  field,
  onTab,
}: {
  id: string;
  table: string;
  tab?: TableTab | undefined;
  /** A measure a link asked for, marked on the Measures tab. */
  field?: string | undefined;
  onTab: (tab: TableTab) => void;
}) {
  const dataset = useQuery(datasetQuery(id));
  const fields = useQuery(tableFieldsQuery(id, table));
  const hidden = useQuery(piiHiddenQuery(id, table));
  if (dataset.error) return <ErrorState error={dataset.error} />;
  if (!dataset.data) return <Loading what="the table" />;
  const item = dataset.data.tables.find((each) => each.name === table);
  if (
    !item ||
    (fields.error instanceof ApiError && fields.error.status === 404)
  )
    return (
      <NoSuchField
        id={id}
        dataset={dataset.data.name}
        kind="table"
        name={table}
      />
    );
  if (fields.error) return <ErrorState error={fields.error} />;
  if (!fields.data) return <Loading what="the table" />;
  const { measures, columns } = tableFields(fields.data);
  const model = diagramModel(dataset.data, [], []);
  const relationships = model.relationships.filter(
    (relationship) =>
      relationship.from_table === table || relationship.to_table === table,
  );
  const list = tab === "measures" ? measures : columns;
  const relationshipCount = model.unknown
    ? "unknown"
    : String(relationships.length);
  return (
    <div className="flex flex-col gap-4 [body:has(&)]:[--page-max:none]">
      <div>
        <FieldBreadcrumb
          id={id}
          dataset={dataset.data}
          table={table}
          path={[]}
        />
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <h1 className="flex items-center gap-2 text-title font-semibold text-ink">
              <Table2 aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">
                <Breakable text={table} />
              </span>
            </h1>
            <Facts
              facts={[
                item.kind !== undefined && KIND[item.kind],
                item.is_hidden && "Hidden",
                item.pii === true && "PII",
              ]}
            />
          </div>
        </header>
      </div>
      <PageTabs
        label="Table"
        current={tab}
        onChange={onTab}
        tabs={[
          { label: "Documentation", value: "documentation" },
          { label: `Columns ${String(columns.length)}`, value: "columns" },
          { label: `Measures ${String(measures.length)}`, value: "measures" },
          {
            label: `Relationships ${relationshipCount}`,
            value: "relationships",
          },
        ]}
      />
      <div className="flex min-w-0 flex-col gap-3">
        {tab === "columns" && hidden.data !== undefined && hidden.data > 0 && (
          <p className="text-meta text-ink-3">
            {plural(hidden.data, "column")} hidden as PII.
          </p>
        )}
        {tab === "documentation" ? (
          <Documentation
            kind="table"
            id={item.id}
            details={[
              ["Type", item.kind === undefined ? null : KIND[item.kind]],
              ["Hidden in Power BI", item.is_hidden ? "Yes" : "No"],
              ["Columns", columns.length.toLocaleString("en")],
              ["Measures", measures.length.toLocaleString("en")],
              ["Relationships", relationshipCount],
              ["Dataset", dataset.data.name],
              ["Workspace", dataset.data.workspace.name],
              ["Last synced", formatTime(dataset.data.synced_at)],
            ]}
          />
        ) : tab === "relationships" ? (
          model.unknown ? (
            <p className="text-ui text-ink-2">{model.unknown}</p>
          ) : relationships.length === 0 ? (
            <EmptyState title="No relationships">
              No relationship names this table.
            </EmptyState>
          ) : (
            <TableRelationships datasetId={id} relationships={relationships} />
          )
        ) : list.length === 0 ? (
          <EmptyState title={tab === "measures" ? "No measures" : "No columns"}>
            This table holds no {tab}.
          </EmptyState>
        ) : (
          <FieldList
            key={tab}
            id={id}
            table={table}
            path={[]}
            fields={list}
            flat
            current={tab === "measures" ? field : undefined}
          />
        )}
      </div>
    </div>
  );
}
