import { Link } from "@tanstack/react-router";
import { Table2 } from "lucide-react";
import { FoldArrow } from "../../shell/fold";
import {
  ARROW_PLACE,
  FOLD_LINK,
  FOLD_ROW,
  FOLD_ROW_CURRENT,
  indent,
  STANDS_FOR_PAGE,
} from "../../shell/nav-row";
import { plural } from "../../shell/plural";
import type { DiagramModel } from "../diagram/model";
import { FieldRows } from "../tree/fields";
import { hasDotName } from "../tree/folders";
import { useOpenRows } from "../tree/open-rows";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * A dataset's tables as a tree, as the first lane has them: each table folds
 * out into its measures by display folder and its columns. A table's name
 * opens its page. The table in the address opens by itself; the measures tab
 * opens every table that holds a measure.
 */
export function TableTree({
  datasetId,
  tables,
  table,
  field,
  measuresOnly = false,
}: {
  datasetId: string;
  tables: DiagramModel["tables"];
  table: string | undefined;
  field: string | undefined;
  measuresOnly?: boolean;
}) {
  const shown = measuresOnly
    ? tables.filter((each) => each.measures.length > 0)
    : tables;
  const trail = measuresOnly
    ? shown.map((each) => each.name)
    : table === undefined
      ? []
      : [table];
  const { open, toggle } = useOpenRows(trail, `${table ?? ""}:${field ?? ""}`);
  return (
    <div
      className={`${ARROW_PLACE} flex max-w-(--read-max) flex-col gap-0.5 rounded border border-line bg-bg p-2`}
    >
      {shown.map((each) => {
        const isOpen = open.has(each.name);
        const measures = plural(each.measures.length, "measure");
        const count = measuresOnly
          ? measures
          : `${plural(each.columns.length, "column")}, ${measures}`;
        return (
          <div key={each.name} className="flex flex-col gap-0.5">
            <div className={`${FOLD_ROW} ${FOLD_ROW_CURRENT}`}>
              <FoldArrow
                open={isOpen}
                label={`${isOpen ? "Close" : "Open"} ${each.name}`}
                onClick={() => {
                  toggle(each.name);
                }}
              />
              {hasDotName(each.name) ? (
                <span className={FOLD_LINK}>
                  <Table2 {...ICON} />
                  <span className="truncate">{each.name}</span>
                </span>
              ) : (
                <Link
                  to="/catalog/datasets/$id/tables/$table"
                  params={{ id: datasetId, table: each.name }}
                  title={each.name}
                  className={FOLD_LINK}
                  {...(each.name === table && field === undefined
                    ? STANDS_FOR_PAGE
                    : {})}
                >
                  <Table2 {...ICON} />
                  <span className="truncate">{each.name}</span>
                </Link>
              )}
              <span className="shrink-0 pr-2 text-meta text-ink-3">
                {count}
              </span>
            </div>
            {each.description !== null && !isOpen && (
              <p className="pb-1 text-meta text-ink-2" style={indent(1, false)}>
                {each.description}
              </p>
            )}
            {isOpen && (
              <FieldRows
                datasetId={datasetId}
                table={each.name}
                depth={1}
                current={each.name === table ? field : undefined}
                details
                fields={{
                  measures: each.measures,
                  columns: measuresOnly ? [] : each.columns,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
