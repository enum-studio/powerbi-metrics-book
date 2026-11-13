import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Folder, Table2 } from "lucide-react";
import { ApiError } from "../../api/client";
import { Breadcrumb, Crumb } from "../../shell/breadcrumb";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { datasetQuery, tableFieldsQuery } from "../queries";
import { folderParam, hasDotName } from "../tree/folders";
import { FieldList } from "./field-list";
import { Breakable } from "../../shell/breakable";

/** A name that is no link: titled and clipped like the links, so a long one gives way on a narrow screen. */
const NAME = "block truncate";

export function FieldBreadcrumb({
  id,
  dataset,
  table,
  path,
  column,
}: {
  id: string;
  dataset: { name: string; workspace: { name: string } };
  table: string;
  path: string[];
  column?: string;
}) {
  return (
    <Breadcrumb here={column ?? path.at(-1) ?? table}>
      <span>Datasets</span>
      <span title={dataset.workspace.name} className={NAME}>
        {dataset.workspace.name}
      </span>
      <Crumb
        to="/catalog/datasets/$id"
        params={{ id }}
        search={{ tab: "tables", table: undefined }}
        title={dataset.name}
      >
        {dataset.name}
      </Crumb>
      {(path.length > 0 || column !== undefined) &&
        (hasDotName(table) ? (
          <span title={table} className={NAME}>
            {table}
          </span>
        ) : (
          <Crumb
            to="/catalog/datasets/$id/tables/$table"
            params={{ id, table }}
            title={table}
          >
            {table}
          </Crumb>
        ))}
      {path
        .slice(0, column === undefined ? -1 : undefined)
        .map((part, index) =>
          hasDotName(table, ...path.slice(0, index + 1)) ? (
            <span key={index} title={part} className={NAME}>
              {part}
            </span>
          ) : (
            <Crumb
              key={index}
              to="/catalog/datasets/$id/tables/$table/folders/$folder"
              params={{
                id,
                table,
                folder: folderParam(path.slice(0, index + 1)),
              }}
              title={part}
            >
              {part}
            </Crumb>
          ),
        )}
    </Breadcrumb>
  );
}

/**
 * A table or column the dataset does not hold, or one the reader may not see:
 * the api answers both alike, and so does this. A dataset the reader may not
 * see never gets this far; it fails as the dataset's own page does.
 */
export function NoSuchField({
  id,
  dataset,
  kind,
  name,
}: {
  id: string;
  dataset: string;
  kind: "table" | "column";
  name: string;
}) {
  return (
    <EmptyState
      title={`No such ${kind}`}
      action={
        <Link
          to="/catalog/datasets/$id"
          params={{ id }}
          search={{ tab: "tables", table: undefined }}
          className="text-accent underline underline-offset-4 hover:text-accent-hover"
        >
          Go to {dataset}
        </Link>
      }
    >
      There is no {kind} called {name} in {dataset} that you can see. Check the
      address for a typo, or ask whoever sent you the link.
    </EmptyState>
  );
}

export function FolderPage({
  id,
  table,
  path,
}: {
  id: string;
  table: string;
  path: string[];
}) {
  const dataset = useQuery(datasetQuery(id));
  const fields = useQuery(tableFieldsQuery(id, table));
  if (dataset.error) return <ErrorState error={dataset.error} />;
  if (!dataset.data) return <Loading what="the fields" />;
  const modelTable = dataset.data.tables.find((item) => item.name === table);
  if (
    !modelTable ||
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
  if (!fields.data) return <Loading what="the fields" />;
  const Icon = path.length === 0 ? Table2 : Folder;
  return (
    <>
      <FieldBreadcrumb
        id={id}
        dataset={dataset.data}
        table={table}
        path={path}
      />
      <div className="flex flex-col gap-6">
        <h1 className="flex items-center gap-2 text-title font-semibold text-ink">
          <Icon aria-hidden="true" className="shrink-0" />
          <span className="min-w-0">
            <Breakable text={path.at(-1) ?? table} />
          </span>
        </h1>
        {path.length === 0 && (
          <p className="text-ui text-ink-2">
            {modelTable.description ?? modelTable.description_pbi}
          </p>
        )}
        <FieldList
          id={id}
          table={table}
          path={path}
          fields={[
            ...fields.data.measures.map((item) => ({
              kind: "Measure" as const,
              name: item.name,
              display_folder: item.display_folder,
              type: item.format_string,
              description: item.description ?? item.description_pbi,
              metric: item.metric,
              measureId: item.id,
            })),
            ...fields.data.columns.map((item) => ({
              kind: "Column" as const,
              name: item.name,
              display_folder: item.display_folder,
              type: item.data_type,
              description: item.description ?? item.description_pbi,
            })),
          ]}
        />
      </div>
    </>
  );
}
