import { Link } from "@tanstack/react-router";
import { EyeOff, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, read } from "../../api/client";
import { meQuery } from "../../api/me";
import { Notice } from "../../shell/notice";
import type { DiagramModel, DiagramTable } from "../diagram/model";
import { useDemo } from "../../shell/demo";
import { useColumnPii } from "./column-pii";

export function TablePanel({
  datasetId,
  table,
  field,
  model,
  onClose,
  onRelationship,
}: {
  datasetId: string;
  table: DiagramTable;
  /** The column or measure a link asked for: marked, and brought into view. */
  field: string | undefined;
  model: DiagramModel;
  onClose: () => void;
  onRelationship: (index: number) => void;
}) {
  const { data: me } = useQuery(meQuery);
  // Brought into view when a link asks for it, not again as the panel redraws, so a refetch leaves the scroll where the person put it.
  const markedRow = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    markedRow.current?.scrollIntoView({ block: "nearest" });
  }, [table.name, field]);
  const marked = (name: string) =>
    name === field ? { "aria-current": true, ref: markedRow } : {};
  const demo = useDemo();
  const { change, notice, dismiss } = useColumnPii();
  const hidden = useQuery({
    queryKey: ["catalog", "pii-hidden", datasetId, table.name],
    queryFn: async () =>
      (
        await read(
          api.GET("/api/v1/datasets/{id}/columns", {
            params: {
              path: { id: datasetId },
              query: { table: table.name, limit: 1 },
            },
          }),
        )
      ).pii_hidden ?? 0,
    retry: false,
  });
  const matching = model.relationships
    .map((relationship, index) => ({ relationship, index }))
    .filter(
      ({ relationship }) =>
        relationship.from_table === table.name ||
        relationship.to_table === table.name,
    );
  return (
    <>
      <PanelTitle title={table.name} onClose={onClose} />
      <p className="mb-5 text-ui text-ink-3">
        {table.description ?? "No description in Power BI or the book."}
      </p>
      <h3 className="text-ui font-semibold">Columns {table.columns.length}</h3>
      {hidden.data !== undefined && hidden.data > 0 && (
        <p className="text-meta text-ink-3">
          {hidden.data} {hidden.data === 1 ? "column" : "columns"} hidden as
          PII.
        </p>
      )}
      {hidden.error && (
        <p role="alert" className="text-meta text-ink-3">
          {hidden.error.message}
        </p>
      )}
      {table.columns.map((column) => (
        <p
          key={column.name}
          {...marked(column.name)}
          className="group flex items-center gap-2 border-b border-line py-2 text-ui aria-[current=true]:bg-accent-soft"
        >
          <span className="flex-1">
            <span>{column.name}</span>{" "}
            {column.pii &&
              (me?.may_admin ? (
                <Link
                  to="/admin/pii"
                  className="border border-ink-3 px-1 font-mono text-label text-ink-2"
                >
                  PII
                </Link>
              ) : (
                <span className="border border-ink-3 px-1 font-mono text-label text-ink-2">
                  PII
                </span>
              ))}
          </span>
          {!column.pii && me?.may_admin && !demo && (
            <button
              type="button"
              disabled={change.isPending}
              onClick={() => {
                change.mutate({ table: table.name, name: column.name });
              }}
              className="text-accent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:min-h-(--tap) pointer-coarse:opacity-100"
            >
              Mark PII
            </button>
          )}
          {column.hidden && <EyeOff size={13} aria-label="hidden" />}
          <span className="font-mono text-meta text-ink-3">{column.type}</span>
        </p>
      ))}
      <h3 className="mt-5 text-ui font-semibold">
        Measures {table.measures.length}
      </h3>
      {Object.entries(
        Object.groupBy(table.measures, (measure) => measure.folder ?? ""),
      ).map(([folder, items]) => (
        <div key={folder}>
          <p className="mt-2 text-meta text-ink-3">{folder}</p>
          {items?.map((measure) => (
            <p
              key={measure.name}
              {...marked(measure.name)}
              className="py-1 text-ui text-accent aria-[current=true]:bg-accent-soft"
            >
              {measure.name}
            </p>
          ))}
        </div>
      ))}
      <h3 className="mt-5 text-ui font-semibold">
        Relationships {matching.length}
      </h3>
      {matching.map(({ relationship, index }) => {
        const fromSide = relationship.from_table === table.name;
        const ownColumn = fromSide
          ? relationship.from_column
          : relationship.to_column;
        const otherTable = fromSide
          ? relationship.to_table
          : relationship.from_table;
        return (
          <button
            key={index}
            type="button"
            onClick={() => {
              onRelationship(index);
            }}
            className="block py-2 text-left text-ui text-ink-2 pointer-coarse:min-h-(--tap)"
          >
            {ownColumn} to {otherTable}
            {!relationship.is_active && (
              <span className="ml-2 font-mono text-meta">inactive</span>
            )}
          </button>
        );
      })}
      {notice !== null && <Notice {...notice} onDismiss={dismiss} />}
    </>
  );
}

export function PanelTitle({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="mb-4 flex items-center">
      <h2 className="flex-1 text-heading font-semibold">{title}</h2>
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="grid place-items-center p-2 text-ink-2 pointer-coarse:size-(--tap)"
      >
        <X size={16} />
      </button>
    </div>
  );
}
