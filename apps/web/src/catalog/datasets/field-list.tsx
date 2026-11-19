import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EyeOff } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { metricQuery, variantsQuery } from "../../review/queries";
import { Trust } from "../trust";
import { useCapped } from "../tree/fields";
import {
  byName,
  folderParam,
  folderPaths,
  folderTree,
  hasDotName,
} from "../tree/folders";

export type Field = {
  kind: "Measure" | "Column" | "Folder";
  name: string;
  display_folder: string | null;
  type?: string | null;
  description?: string | null;
  metric?: { name: string; label: string } | null;
  measureId?: string;
  hidden?: boolean;
  pii?: boolean;
};

type ListedField = {
  name: string;
  display_folder: string | null;
  description: string | null;
  description_pbi: string | null;
  is_hidden: boolean;
  pii?: boolean;
};

/** A table's measures and columns from the api, as the lists show them. */
export function tableFields({
  measures,
  columns,
}: {
  measures: (ListedField & {
    id: string;
    format_string: string | null;
    metric: { name: string; label: string } | null;
  })[];
  columns: (ListedField & { data_type: string | null })[];
}): { measures: Field[]; columns: Field[] } {
  const shared = (item: ListedField) => ({
    name: item.name,
    display_folder: item.display_folder,
    description: item.description ?? item.description_pbi,
    hidden: item.is_hidden,
    pii: item.pii === true,
  });
  return {
    measures: measures.map((item) => ({
      ...shared(item),
      kind: "Measure",
      type: item.format_string,
      metric: item.metric,
      measureId: item.id,
    })),
    columns: columns.map((item) => ({
      ...shared(item),
      kind: "Column",
      type: item.data_type,
    })),
  };
}

export function fieldsAt(fields: Field[], path: string[]): Field[] {
  const tree = folderTree(
    fields.map((field) => ({ ...field, folder: field.display_folder })),
  );
  let folders = tree.folders;
  let items = tree.loose;
  for (const part of path) {
    const folder = folders.find((folder) => folder.name === part);
    if (folder === undefined) return [];
    folders = folder.folders;
    items = folder.items;
  }
  return [
    ...folders.map((folder): Field => ({
      kind: "Folder",
      name: folder.name,
      display_folder: folder.path,
    })),
    ...items.filter((field) => field.kind === "Measure"),
    ...items.filter((field) => field.kind === "Column"),
  ];
}

/** The list APIs name the measure; the variant API supplies its anchor. */
export function MeasureLink({
  name,
  measureId,
  metric,
}: {
  name: string;
  measureId: string;
  metric: Field["metric"];
}) {
  const variants = useQuery({
    ...variantsQuery(metric?.name ?? ""),
    enabled: metric != null,
  });
  if (metric == null) return <span>{name}</span>;
  const variant = variants.data?.find(
    (variant) => variant.measure.id === measureId,
  );
  return (
    <Link
      to="/catalog/metrics/$name"
      params={{ name: metric.name }}
      search={{ variant: variant?.id }}
    >
      {name}
    </Link>
  );
}

function MetricCell({ metric }: { metric: NonNullable<Field["metric"]> }) {
  const detail = useQuery(metricQuery(metric.name));
  return (
    <span>
      <Link to="/catalog/metrics/$name" params={{ name: metric.name }}>
        {metric.label}
      </Link>
      {detail.data && (
        <span className="ml-2">
          <Trust state={detail.data.trust_state} />
        </span>
      )}
    </span>
  );
}

/** A cell beside the name: in its column on a wider screen, a small fact under the name on a phone, and gone there when empty. */
const SMALL = "p-2 max-md:p-0 max-md:text-meta max-md:empty:hidden md:text-ink";

/** The folders a field sits in, each a link to its page. */
function FolderLinks({
  id,
  table,
  folder,
}: {
  id: string;
  table: string;
  folder: string | null;
}) {
  return folderPaths(folder).map((levels, index) => (
    <Fragment key={levels.join("\\")}>
      {index > 0 && ", "}
      {hasDotName(table, ...levels) ? (
        levels.join(" / ")
      ) : (
        <Link
          to="/catalog/datasets/$id/tables/$table/folders/$folder"
          params={{ id, table, folder: folderParam(levels) }}
          className="text-accent"
        >
          {levels.join(" / ")}
        </Link>
      )}
    </Fragment>
  ));
}

export function FieldList({
  id,
  table,
  path,
  fields,
  flat = false,
  current,
}: {
  id: string;
  table: string;
  path: string[];
  fields: Field[];
  /** Every field at once, A to Z, each with its folder, rather than one level of the folders. */
  flat?: boolean;
  /** The field a link asked for: marked, and brought into view. */
  current?: string | undefined;
}) {
  const [filter, setFilter] = useState("");
  const level = flat ? [...fields].sort(byName) : fieldsAt(fields, path);
  const rows = level.filter((field) =>
    `${field.name} ${field.description ?? ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const isCurrent = (field: Field) =>
    field.kind !== "Folder" && field.name === current;
  const { shown, more, showAll } = useCapped(rows, isCurrent);
  const markedRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    markedRow.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const holdsMeasures = fields.some((field) => field.kind === "Measure");
  const showFolder =
    flat && fields.some((field) => field.display_folder !== null);
  const showMetric = !flat || holdsMeasures;
  const headings = flat
    ? [
        "Name",
        ...(showFolder ? ["Folder"] : []),
        holdsMeasures ? "Format" : "Type",
        ...(showMetric ? ["Metric"] : []),
        "Description",
      ]
    : ["Name", "Kind", "Type", "Metric", "Description"];
  return (
    <section className="flex flex-col gap-3">
      <input
        aria-label="Filter fields"
        placeholder="Filter fields"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
        className="rounded border border-line-control bg-surface px-3 py-2 text-ui"
      />
      {/* On a phone each row is a short list item, as Attio and Notion show a table there: the name on its own line, the kind, type and metric under it, then the description. */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-ui max-md:block">
          <thead className="text-meta text-ink-3 max-md:hidden">
            <tr>
              {headings.map((name) => (
                <th key={name} className="p-2">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-md:block">
            {shown.map((field) => (
              <tr
                key={`${field.kind}:${field.name}`}
                {...(isCurrent(field)
                  ? { "aria-current": true, ref: markedRow }
                  : {})}
                className="border-t border-line aria-[current=true]:bg-accent-soft max-md:flex max-md:flex-wrap max-md:items-baseline max-md:gap-x-2 max-md:py-2.5"
              >
                <td className="p-2 text-accent max-md:basis-full max-md:p-0 md:min-w-40">
                  {field.kind === "Folder" ? (
                    hasDotName(table, ...path, field.name) ? (
                      field.name
                    ) : (
                      <Link
                        to="/catalog/datasets/$id/tables/$table/folders/$folder"
                        params={{
                          id,
                          table,
                          folder: folderParam([...path, field.name]),
                        }}
                      >
                        {field.name}
                      </Link>
                    )
                  ) : field.kind === "Column" ? (
                    hasDotName(table, field.name) ? (
                      field.name
                    ) : (
                      <Link
                        to="/catalog/datasets/$id/tables/$table/columns/$column"
                        params={{ id, table, column: field.name }}
                      >
                        {field.name}
                      </Link>
                    )
                  ) : (
                    <MeasureLink
                      name={field.name}
                      measureId={field.measureId ?? ""}
                      metric={field.metric}
                    />
                  )}
                  {field.hidden && (
                    <EyeOff
                      size={13}
                      aria-label="hidden"
                      className="ml-2 inline text-ink-3"
                    />
                  )}
                  {field.pii && (
                    <span className="ml-2 border border-ink-3 px-1 font-mono text-label text-ink-2">
                      PII
                    </span>
                  )}
                </td>
                {!flat && (
                  <td className={`${SMALL} text-ink-3`}>{field.kind}</td>
                )}
                {showFolder && (
                  <td className={`${SMALL} text-ink-3`}>
                    <FolderLinks
                      id={id}
                      table={table}
                      folder={field.display_folder}
                    />
                  </td>
                )}
                <td className={`${SMALL} font-mono text-ink-3`}>
                  {field.type}
                </td>
                {showMetric && (
                  <td className={SMALL}>
                    {field.kind === "Measure" && field.metric && (
                      <MetricCell metric={field.metric} />
                    )}
                  </td>
                )}
                <td
                  className={`${SMALL} text-ink-2 max-md:line-clamp-2 max-md:basis-full`}
                >
                  {field.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 && (
        <button
          type="button"
          onClick={showAll}
          className="self-start text-ui text-accent pointer-coarse:min-h-(--tap)"
        >
          Show {more.toLocaleString("en")} more
        </button>
      )}
      {rows.length === 0 && (
        <p className="text-ui text-ink-3">No fields here.</p>
      )}
    </section>
  );
}
