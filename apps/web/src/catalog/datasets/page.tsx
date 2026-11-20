import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import { api, read } from "../../api/client";
import { Breadcrumb } from "../../shell/breadcrumb";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { formatTime } from "../../shell/time";
import type { DiagramSelection, Density } from "../diagram/model";
import { diagramModel } from "./model";
import { AcceptedAnswers } from "../../review/accepted-answers";
import { allPages } from "../queries";
import { DatasetHeader } from "./header";
import { DiagramTab } from "./diagram-tab";
import { Documentation } from "./documentation";
import { RelationshipsTab } from "./relationships-tab";
import { DatasetTabs, type DatasetTab } from "./tabs";
import { TableTree } from "./table-tree";

export function DatasetPage({
  id,
  tab,
  table,
  field,
}: {
  id: string;
  tab?: DatasetTab;
  table?: string;
  /** A column or measure of `table`, marked in its panel: where a row of the tree goes. */
  field?: string;
}) {
  const query = useQuery({
    queryKey: ["catalog", "dataset-full", id],
    queryFn: async () => {
      const dataset = await read(
        api.GET("/api/v1/datasets/{id}", { params: { path: { id } } }),
      );
      const [columns, measures] = await Promise.all([
        allPages((cursor) =>
          read(
            api.GET("/api/v1/datasets/{id}/columns", {
              params: {
                path: { id },
                query: { limit: 200, ...(cursor ? { cursor } : {}) },
              },
            }),
          ),
        ),
        allPages((cursor) =>
          read(
            api.GET("/api/v1/datasets/{id}/measures", {
              params: {
                path: { id },
                query: { limit: 200, ...(cursor ? { cursor } : {}) },
              },
            }),
          ),
        ),
      ]);
      return {
        dataset,
        model: diagramModel(
          dataset,
          columns.map((item) => ({ ...item, table: item.table.name })),
          measures.map((item) => ({ ...item, table: item.table.name })),
        ),
      };
    },
    retry: false,
  });
  const navigate = useNavigate({ from: "/catalog/datasets/$id" });
  const [selection, setSelection] = useState<DiagramSelection>(
    table ? { kind: "table", name: table } : null,
  );
  const [density, setDensity] = useState<Density>("keys");
  const currentTab =
    tab ??
    (typeof window !== "undefined" && window.innerWidth < 768
      ? "relationships"
      : "diagram");
  useEffect(() => {
    if (table) setSelection({ kind: "table", name: table });
  }, [table]);
  // The address names the table selected, so a link or a reload shows it; a field stays only while its table does.
  const show = (next: DiagramSelection, toTab?: DatasetTab) => {
    setSelection(next);
    const name = next?.kind === "table" ? next.name : undefined;
    void navigate({
      search: (old) => ({
        ...old,
        ...(toTab === undefined ? {} : { tab: toTab }),
        table: name,
        field: name !== undefined && name === old.table ? old.field : undefined,
      }),
      replace: toTab === undefined,
    });
  };
  // Escape clears the diagram's selection, unless a dialog (search, the phone's menu) or a field such as the table search took it.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (currentTab !== "diagram" || selection === null) return;
    if (event.defaultPrevented || document.querySelector("dialog[open]"))
      return;
    show(null);
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape(event);
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);
  if (query.isPending) return <Loading what="the dataset" />;
  if (query.error) return <ErrorState error={query.error} />;
  const { dataset, model } = query.data;
  const goTab = (next: DatasetTab) =>
    void navigate({ search: (old) => ({ ...old, tab: next }) });
  const openTable = (name: string) => {
    show({ kind: "table", name }, "diagram");
  };
  const selectedTable =
    selection?.kind === "table"
      ? model.tables.find((item) => item.name === selection.name)
      : undefined;
  const selectedRelationship =
    selection?.kind === "relationship"
      ? model.relationships[selection.index]
      : undefined;
  const relationshipCount: number | "unknown" = model.unknown
    ? "unknown"
    : model.relationships.length;
  const counts = {
    tables: model.tables.length,
    measures: model.tables.reduce(
      (count, item) => count + item.measures.length,
      0,
    ),
    relationships: relationshipCount,
  };
  return (
    <div className="flex flex-col gap-4 [body:has(&)]:[--page-max:none]">
      <div>
        <Breadcrumb here={dataset.name}>
          {/* Datasets are listed in the tree alone: there is no page to link to. */}
          <span>Datasets</span>
        </Breadcrumb>
        <DatasetHeader dataset={dataset} unknown={model.unknown} />
      </div>
      <DatasetTabs counts={counts} current={currentTab} onChange={goTab} />
      <div className="min-w-0">
        {currentTab === "documentation" ? (
          <Documentation
            kind="dataset"
            id={id}
            details={[
              ["Workspace", dataset.workspace.name],
              ["Storage mode", dataset.target_storage_mode],
              ["Endorsement", dataset.endorsement],
              ["Sensitivity label", dataset.sensitivity_label],
              [
                "Row-level security",
                dataset.has_row_level_security ? "Yes" : "No",
              ],
              ["Tables", counts.tables.toLocaleString("en")],
              ["Measures", counts.measures.toLocaleString("en")],
              ["Relationships", String(counts.relationships)],
              ["Last synced", formatTime(dataset.synced_at)],
            ]}
          />
        ) : model.tables.length === 0 ? (
          <EmptyState title="No tables to draw">
            Power BI could not give this dataset's schema, so there are no
            tables to draw. It is read again at the next sync after the model is
            refreshed.
          </EmptyState>
        ) : currentTab === "diagram" ? (
          <DiagramTab
            datasetId={id}
            key={id}
            model={model}
            density={density}
            selection={selection}
            selectedTable={selectedTable}
            field={selectedTable?.name === table ? field : undefined}
            selectedRelationship={selectedRelationship}
            onDensity={setDensity}
            onSelect={show}
            onOpenTable={openTable}
          />
        ) : currentTab === "tables" ? (
          <TableTree
            datasetId={id}
            tables={model.tables}
            table={table}
            field={field}
          />
        ) : currentTab === "measures" ? (
          counts.measures === 0 ? (
            <EmptyState title="No measures">
              No table in this dataset holds a measure.
            </EmptyState>
          ) : (
            <TableTree
              datasetId={id}
              tables={model.tables}
              table={table}
              field={field}
              measuresOnly
            />
          )
        ) : (
          <RelationshipsTab
            model={model}
            onOpenRelationship={(index) => {
              show({ kind: "relationship", index }, "diagram");
            }}
          />
        )}
      </div>
      <AcceptedAnswers answers={dataset.accepted_answers} />
    </div>
  );
}
