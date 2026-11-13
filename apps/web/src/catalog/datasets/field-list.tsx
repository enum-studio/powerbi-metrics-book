import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { metricQuery, variantsQuery } from "../../review/queries";
import { Trust } from "../trust";
import { folderParam, folderTree, hasDotName } from "../tree/folders";

export type Field = {
  kind: "Measure" | "Column" | "Folder";
  name: string;
  display_folder: string | null;
  type?: string | null;
  description?: string | null;
  metric?: { name: string; label: string } | null;
  measureId?: string;
};

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

export function FieldList({
  id,
  table,
  path,
  fields,
}: {
  id: string;
  table: string;
  path: string[];
  fields: Field[];
}) {
  const [filter, setFilter] = useState("");
  const rows = fieldsAt(fields, path).filter((field) =>
    `${field.name} ${field.description ?? ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
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
              {["Name", "Kind", "Type", "Metric", "Description"].map((name) => (
                <th key={name} className="p-2">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-md:block">
            {rows.map((field) => (
              <tr
                key={`${field.kind}:${field.name}`}
                className="border-t border-line max-md:flex max-md:flex-wrap max-md:items-baseline max-md:gap-x-2 max-md:py-2.5"
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
                </td>
                <td className={`${SMALL} text-ink-3`}>{field.kind}</td>
                <td className={`${SMALL} font-mono text-ink-3`}>
                  {field.type}
                </td>
                <td className={SMALL}>
                  {field.kind === "Measure" && field.metric && (
                    <MetricCell metric={field.metric} />
                  )}
                </td>
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
      {rows.length === 0 && (
        <p className="text-ui text-ink-3">No fields here.</p>
      )}
    </section>
  );
}
