import { Link } from "@tanstack/react-router";
import {
  Calendar,
  CaseSensitive,
  Folder as FolderIcon,
  Hash,
  type LucideIcon,
  Sigma,
  ToggleLeft,
  Columns3,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { FoldArrow } from "../../shell/fold";
import {
  FOLD_LINK,
  FOLD_ROW,
  FOLD_ROW_CURRENT,
  indent,
  NAV_ROW,
  STANDS_FOR_PAGE,
} from "../../shell/nav-row";
import {
  type Folder,
  folderPaths,
  folderTrail,
  folderTree,
  folderLevels,
  hasDotName,
} from "./folders";
import { useOpenRows } from "./open-rows";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

/** A table's measures and columns, as the tree shows them. */
export type TableFields = {
  measures: readonly {
    name: string;
    folder: string | null;
    format?: string | null;
    id?: string;
    metric?: { name: string; label: string } | null;
  }[];
  columns: readonly {
    name: string;
    type: string | null;
    hidden: boolean;
    folder?: string | null;
  }[];
};

/** Rows shown before a long list asks for more, so a table of hundreds of fields stays quick to draw. */
export const FIELDS_SHOWN = 100;

/** A column's icon by its Power BI data type: a number, text, a date, true or false. */
export function columnIcon(type: string | null): LucideIcon {
  const kind = (type ?? "").toLowerCase();
  if (/int|double|decimal|currency|number/.test(kind)) return Hash;
  if (/string|text/.test(kind)) return CaseSensitive;
  if (/date|time/.test(kind)) return Calendar;
  if (/bool/.test(kind)) return ToggleLeft;
  return Columns3;
}

/**
 * A table's fields, under its row in the tree: its measures' display folders,
 * the measures in no folder, then its columns. Each row goes to the table's
 * panel with that field marked. The way to the field on screen opens, and a
 * person's own opens and closes hold.
 */
export function FieldRows({
  datasetId,
  table,
  fields,
  depth,
  current,
  currentFolder,
  details = false,
}: {
  datasetId: string;
  table: string;
  fields: TableFields;
  depth: number;
  /** The field on screen, when it is one of this table's. */
  current: string | undefined;
  currentFolder?: string[];
  /** Each field's format string or data type at the row's end, where there is room for it. */
  details?: boolean;
}) {
  const folderPath = currentFolder?.join("\\");
  const members = [
    ...fields.measures.map((m) => ({ ...m, kind: "measure" as const })),
    ...fields.columns.map((c) => ({
      name: c.name,
      folder: c.folder ?? null,
      format: c.type,
      hidden: c.hidden,
      kind: "column" as const,
    })),
  ];
  const tree = folderTree(members);
  const ordered = (items: typeof members) => [
    ...items.filter((m) => m.kind === "measure"),
    ...items.filter((m) => m.kind === "column"),
  ];
  // A measure in several folders opens the way to the first of them.
  const way = folderPaths(
    members.find((m) => m.name === current)?.folder ?? null,
  )[0];
  const trail =
    folderPath !== undefined
      ? folderTrail(folderPath)
      : way === undefined
        ? []
        : folderTrail(way.join("\\"));
  const { open, toggle } = useOpenRows(
    trail,
    `${folderPath ?? ""}:${current ?? ""}`,
  );
  // The first folded folder on the way to the field on screen holds its place.
  const standIn = trail.find((path) => !open.has(path));
  const leaf = (
    name: string,
    Icon: LucideIcon,
    at: number,
    detail: string | null | undefined,
    hidden = false,
    column = false,
  ) =>
    column && hasDotName(table, name) ? (
      <span
        key={`column:${name}`}
        className={`${NAV_ROW} ${hidden ? "text-ink-3" : ""}`}
        style={indent(at, false)}
      >
        <Icon {...ICON} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </span>
    ) : (
      <Link
        key={`${column ? "column" : "measure"}:${name}`}
        to={
          column
            ? "/catalog/datasets/$id/tables/$table/columns/$column"
            : "/catalog/datasets/$id"
        }
        params={{ id: datasetId, table, column: name }}
        search={column ? {} : { tab: "diagram", table, field: name }}
        activeOptions={{ exact: true, includeSearch: true }}
        title={name}
        className={`${NAV_ROW} ${hidden ? "text-ink-3" : ""}`}
        style={indent(at, false)}
        {...(name === current ? STANDS_FOR_PAGE : {})}
      >
        <Icon {...ICON} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {details && detail && (
          <span className="shrink-0 font-mono text-meta font-normal text-ink-3">
            <span className="sr-only">, </span>
            {detail}
          </span>
        )}
      </Link>
    );
  const itemRow = (m: (typeof members)[number], at: number) =>
    leaf(
      m.name,
      m.kind === "column" ? columnIcon(m.format) : Sigma,
      at,
      m.format,
      m.kind === "column" && m.hidden,
      m.kind === "column",
    );
  const isCurrent = (field: { name: string }) => field.name === current;
  const folderRows = (
    folders: Folder<(typeof members)[number]>[],
    at: number,
  ) =>
    folders.map((folder) => (
      <div key={folder.path} className="flex flex-col gap-0.5">
        <div className={`${FOLD_ROW} ${FOLD_ROW_CURRENT}`} style={indent(at)}>
          <FoldArrow
            open={open.has(folder.path)}
            label={`${open.has(folder.path) ? "Close" : "Open"} ${folder.name}`}
            onClick={() => {
              toggle(folder.path);
            }}
          />
          {hasDotName(table, ...folderLevels(folder.path)) ? (
            <span className={FOLD_LINK}>
              <FolderIcon {...ICON} />
              <span className="truncate">{folder.name}</span>
            </span>
          ) : (
            <Link
              to="/catalog/datasets/$id/tables/$table/folders/$folder"
              params={{
                id: datasetId,
                table,
                folder: folder.path,
              }}
              className={FOLD_LINK}
              activeOptions={{ exact: true }}
              {...(standIn === folder.path || folderPath === folder.path
                ? STANDS_FOR_PAGE
                : {})}
            >
              <FolderIcon {...ICON} />
              <span className="truncate">{folder.name}</span>
            </Link>
          )}
          <span className="pr-2 font-mono text-label text-ink-3">
            {folder.count}
          </span>
        </div>
        {open.has(folder.path) && (
          <>
            {folderRows(folder.folders, at + 1)}
            <Capped
              items={ordered(folder.items)}
              depth={at + 1}
              keep={isCurrent}
              row={(m) => itemRow(m, at + 1)}
            />
          </>
        )}
      </div>
    ));
  return (
    <>
      {folderRows(tree.folders, depth)}
      <Capped
        items={ordered(tree.loose)}
        depth={depth}
        keep={isCurrent}
        row={(m) => itemRow(m, depth)}
      />
    </>
  );
}

/**
 * A list that shows its first rows and, below them, a row that shows the
 * rest. A row to keep, such as the field on screen, shows even past the cap.
 */
function Capped<T>({
  items,
  depth,
  keep,
  row,
}: {
  items: readonly T[];
  depth: number;
  keep: (item: T) => boolean;
  row: (item: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all
    ? items
    : [
        ...items.slice(0, FIELDS_SHOWN),
        ...items.slice(FIELDS_SHOWN).filter(keep),
      ];
  return (
    <>
      {shown.map(row)}
      {shown.length < items.length && (
        <button
          type="button"
          className={`${NAV_ROW} justify-between text-left`}
          style={indent(depth, false)}
          onClick={() => {
            setAll(true);
          }}
        >
          Show more
          <span className="font-mono text-label font-normal text-ink-3">
            {(items.length - shown.length).toLocaleString("en")}
          </span>
        </button>
      )}
    </>
  );
}
