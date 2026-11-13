import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { Database, Layers, Table2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { FoldArrow, FoldMark, useFold } from "../../shell/fold";
import { ItemIcon } from "../../shell/item-icon";
import {
  FOLD_LINK,
  FOLD_ROW,
  FOLD_ROW_CURRENT,
  indent,
  showCurrentRow,
  STANDS_FOR_PAGE,
} from "../../shell/nav-row";
import { ErrorState } from "../../shell/states";
import {
  datasetQuery,
  datasetsQuery,
  tableFieldsQuery,
  workspacesQuery,
} from "../queries";
import { FieldRows } from "./fields";
import { folderLevels, hasDotName } from "./folders";
import { useOpenRows } from "./open-rows";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
const DATASET_PAGE = "/catalog/datasets/";

/** The keys of the rows that fold, so a workspace, a dataset and a table never share one. */
export const rowKey = {
  workspace: (id: string) => `w:${id}`,
  dataset: (id: string) => `d:${id}`,
  table: (dataset: string, table: string) => `t:${dataset}:${table}`,
};

function Loading({ what, depth }: { what: string; depth: number }) {
  return (
    <p
      className="appear-late py-1 text-meta text-ink-3"
      style={indent(depth, false)}
    >
      Loading {what}
    </p>
  );
}

const Count = ({ n }: { n: number }) => (
  <span className="pr-2 font-mono text-label text-ink-3">
    {n.toLocaleString("en")}
  </span>
);

/** A dataset's count of tables, shown once it has been opened: the list of datasets does not carry it, and this asks for nothing itself. */
function TableCount({ datasetId }: { datasetId: string }) {
  const tables = useQuery({
    ...datasetQuery(datasetId),
    enabled: false,
    select: (dataset) => dataset.tables.length,
  });
  return tables.data === undefined ? null : <Count n={tables.data} />;
}

/** A table's fields, asked for only once the table is opened. */
function TableBranch({
  datasetId,
  table,
  depth,
  current,
  currentFolder,
}: {
  datasetId: string;
  table: string;
  depth: number;
  current: string | undefined;
  currentFolder?: string[];
}) {
  const fields = useQuery(tableFieldsQuery(datasetId, table));
  if (fields.error) return <ErrorState error={fields.error} />;
  if (fields.data === undefined)
    return <Loading what="the fields" depth={depth} />;
  return (
    <FieldRows
      datasetId={datasetId}
      table={table}
      depth={depth}
      current={current}
      currentFolder={currentFolder}
      fields={{
        measures: fields.data.measures.map((m) => ({
          name: m.name,
          id: m.id,
          metric: m.metric,
          folder: m.display_folder,
        })),
        columns: fields.data.columns.map((c) => ({
          name: c.name,
          type: c.data_type,
          hidden: c.is_hidden,
          folder: c.display_folder,
        })),
      }}
    />
  );
}

/** A dataset's tables, asked for only once the dataset is opened. */
function DatasetBranch({
  datasetId,
  depth,
  open,
  toggle,
  shown,
}: {
  datasetId: string;
  depth: number;
  open: ReadonlySet<string>;
  toggle: (row: string) => void;
  shown: {
    table: string | undefined;
    field: string | undefined;
    folder: string[] | undefined;
    standIn: string | undefined;
  };
}) {
  const dataset = useQuery(datasetQuery(datasetId));
  if (dataset.error) return <ErrorState error={dataset.error} />;
  if (dataset.data === undefined)
    return <Loading what="the tables" depth={depth} />;
  return dataset.data.tables.map((table) => {
    const key = rowKey.table(datasetId, table.name);
    const isOpen = open.has(key);
    const here = shown.table === table.name;
    return (
      <div key={table.name} className="flex flex-col gap-0.5">
        <div
          className={`${FOLD_ROW} ${FOLD_ROW_CURRENT}`}
          style={indent(depth)}
        >
          <FoldArrow
            open={isOpen}
            label={`${isOpen ? "Close" : "Open"} ${table.name}`}
            onClick={() => {
              toggle(key);
            }}
          />
          {hasDotName(table.name) ? (
            <span className={FOLD_LINK}>
              <Table2 {...ICON} />
              <span className="truncate">{table.name}</span>
            </span>
          ) : (
            <Link
              to="/catalog/datasets/$id/tables/$table"
              params={{ id: datasetId, table: table.name }}
              activeOptions={{ exact: true, includeSearch: true }}
              title={table.name}
              className={`${FOLD_LINK} ${table.is_hidden ? "text-ink-3" : ""}`}
              {...((here &&
                shown.field === undefined &&
                shown.folder === undefined) ||
              shown.standIn === key
                ? STANDS_FOR_PAGE
                : {})}
            >
              <Table2 {...ICON} />
              <span className="truncate">{table.name}</span>
            </Link>
          )}
          <Count n={table.measure_count + table.column_count} />
        </div>
        {isOpen && (
          <TableBranch
            datasetId={datasetId}
            table={table.name}
            depth={depth + 1}
            current={here ? shown.field : undefined}
            currentFolder={here ? shown.folder : undefined}
          />
        )}
      </div>
    );
  });
}

/**
 * Datasets in the first lane: a workspace, its datasets, a dataset's tables,
 * and a table's measures by display folder and its columns. Each level is
 * asked for only when it is opened, so a book with hundreds of measures in a
 * dataset stays quick. Only the way to the page on screen opens by itself,
 * and a person's own opens and closes hold as they move around.
 */
export function DatasetsBranch() {
  const path = useLocation({ select: (location) => location.pathname });
  const search: { table?: string; field?: string } = useSearch({
    strict: false,
  });
  // The matched route's own params, already decoded: re-parsing the pathname would decode a second time.
  const params: {
    id?: string;
    table?: string;
    column?: string;
    folder?: string;
  } = useParams({ strict: false });
  const onDataset = path.startsWith(DATASET_PAGE);
  const datasetId = onDataset ? params.id : undefined;
  const [branchOpen, setBranchOpen] = useFold(onDataset);
  const datasets = useQuery({ ...datasetsQuery, enabled: branchOpen }),
    workspaces = useQuery({ ...workspacesQuery, enabled: branchOpen });
  const shownDataset = datasets.data?.find((d) => d.id === datasetId);
  const table = onDataset ? (params.table ?? search.table) : undefined;
  const field =
    table === undefined ? undefined : (params.column ?? search.field);
  const folder =
    onDataset && params.folder !== undefined
      ? folderLevels(params.folder)
      : undefined;
  const trail =
    shownDataset === undefined
      ? []
      : [
          rowKey.workspace(shownDataset.workspace.id),
          rowKey.dataset(shownDataset.id),
          ...(table === undefined
            ? []
            : [rowKey.table(shownDataset.id, table)]),
        ];
  const { open, toggle } = useOpenRows(
    trail,
    `${path}?${table ?? ""}`,
    datasets.isSuccess,
  );
  // The row that holds the page's place while the page's own row is folded away: the first folded row on the way to it.
  const standIn = trail
    .slice(0, field === undefined && folder === undefined ? -1 : undefined)
    .find((row) => !open.has(row));
  const nav = useRef<HTMLDivElement>(null);
  const ready = datasets.isSuccess && workspaces.isSuccess;
  useEffect(() => {
    if (ready) showCurrentRow(nav.current);
  }, [path, table, field, ready]);
  return (
    <div ref={nav} className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={branchOpen}
        className={`${FOLD_ROW} text-left`}
        onClick={() => {
          setBranchOpen(!branchOpen);
        }}
      >
        <FoldMark open={branchOpen} />
        <span
          className={FOLD_LINK}
          {...(onDataset && !branchOpen ? STANDS_FOR_PAGE : {})}
        >
          <Database {...ICON} />
          Datasets
        </span>
      </button>
      {branchOpen && (datasets.error ?? workspaces.error) && (
        <ErrorState error={datasets.error ?? workspaces.error} />
      )}
      {branchOpen && (datasets.isPending || workspaces.isPending) && (
        <Loading what="the datasets" depth={1} />
      )}
      {branchOpen &&
        workspaces.data &&
        datasets.data &&
        workspaces.data.map((w) => {
          const inside = datasets.data.filter((d) => d.workspace.id === w.id);
          const key = rowKey.workspace(w.id);
          const isOpen = open.has(key);
          return (
            <div key={w.id} className="flex flex-col gap-0.5">
              <button
                type="button"
                aria-expanded={isOpen}
                title={w.name}
                className={`${FOLD_ROW} ${FOLD_ROW_CURRENT} text-left`}
                style={indent(1)}
                onClick={() => {
                  toggle(key);
                }}
              >
                <FoldMark open={isOpen} />
                <span
                  className={FOLD_LINK}
                  {...(standIn === key ? STANDS_FOR_PAGE : {})}
                >
                  <ItemIcon icon={w.icon} fallback={Layers} />
                  <span className="truncate">{w.name}</span>
                </span>
                <Count n={inside.length} />
              </button>
              {isOpen &&
                inside.map((d) => {
                  const dKey = rowKey.dataset(d.id);
                  const dOpen = open.has(dKey);
                  const here = d.id === datasetId;
                  return (
                    <div key={d.id} className="flex flex-col gap-0.5">
                      <div
                        className={`${FOLD_ROW} ${FOLD_ROW_CURRENT}`}
                        style={indent(2)}
                      >
                        <FoldArrow
                          open={dOpen}
                          label={`${dOpen ? "Close" : "Open"} ${d.name}`}
                          onClick={() => {
                            toggle(dKey);
                          }}
                        />
                        <Link
                          to="/catalog/datasets/$id"
                          params={{ id: d.id }}
                          search={{ tab: "diagram", table: undefined }}
                          activeOptions={{ exact: true, includeSearch: true }}
                          title={d.name}
                          className={FOLD_LINK}
                          {...((here && table === undefined) || standIn === dKey
                            ? STANDS_FOR_PAGE
                            : {})}
                        >
                          <ItemIcon icon={d.icon} fallback={Database} />
                          <span className="truncate">{d.name}</span>
                        </Link>
                        <TableCount datasetId={d.id} />
                      </div>
                      {dOpen && (
                        <DatasetBranch
                          datasetId={d.id}
                          depth={3}
                          open={open}
                          toggle={toggle}
                          shown={{
                            table: here ? table : undefined,
                            field,
                            folder,
                            standIn,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
    </div>
  );
}
