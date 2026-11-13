import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError } from "../../api/client";
import { CodePanel } from "../../review/code-panel";
import { ErrorState, Loading } from "../../shell/states";
import { datasetQuery, tableFieldsQuery } from "../queries";
import { columnIcon } from "../tree/fields";
import { folderPaths } from "../tree/folders";
import { MeasureLink } from "./field-list";
import { FieldBreadcrumb, NoSuchField } from "./folder-page";
import { columnQuery } from "./queries";
import { Breakable } from "../../shell/breakable";

export function ColumnPage({
  id,
  table,
  column,
}: {
  id: string;
  table: string;
  column: string;
}) {
  const dataset = useQuery(datasetQuery(id));
  const fields = useQuery(tableFieldsQuery(id, table));
  const match = fields.data?.columns.find((item) => item.name === column);
  const detail = useQuery(columnQuery(id, match?.id));
  if (dataset.error) return <ErrorState error={dataset.error} />;
  if (!dataset.data) return <Loading what="the column" />;
  const error = fields.error ?? detail.error;
  if (
    (error instanceof ApiError && error.status === 404) ||
    (fields.isSuccess && !match)
  )
    return (
      <NoSuchField
        id={id}
        dataset={dataset.data.name}
        kind="column"
        name={column}
      />
    );
  if (error) return <ErrorState error={error} />;
  if (!detail.data) return <Loading what="the column" />;
  const { column: item, terms, relationships, used_by: usedBy } = detail.data;
  const Icon = columnIcon(item.data_type);
  return (
    <>
      <FieldBreadcrumb
        id={id}
        dataset={dataset.data}
        table={table}
        path={folderPaths(item.display_folder)[0] ?? []}
        column={column}
      />
      <div className="flex flex-col gap-6 text-ui text-ink-2">
        <h1 className="flex items-center gap-2 text-title font-semibold text-ink">
          <Icon aria-hidden="true" className="shrink-0" />
          <span className="min-w-0">
            <Breakable text={item.name} />
          </span>
        </h1>
        <div className="flex gap-2 text-meta">
          {[
            item.is_hidden && "Hidden",
            item.column_type === "calculated" && "Calculated",
            item.pii && "PII",
          ]
            .filter(Boolean)
            .map((badge) => (
              <span key={String(badge)} className="rounded bg-raised px-2 py-1">
                {badge}
              </span>
            ))}
        </div>
        <p>
          {item.description ?? item.description_pbi ?? "No description yet."}
        </p>
        <dl className="grid grid-cols-2 gap-2">
          {[
            ["Data type", item.data_type],
            ["Format string", item.format_string],
            ["Display folder", item.display_folder],
            ["Column type", item.column_type],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-meta text-ink-3">{label}</dt>
              <dd>{value ?? "None"}</dd>
            </div>
          ))}
        </dl>
        {item.column_type === "calculated" && item.expression !== null && (
          <CodePanel heading="DAX" label="DAX" code={item.expression} />
        )}
        <section>
          <h2 className="text-heading font-semibold">Terms</h2>
          {terms.length === 0 ? (
            <p>No terms linked to this column.</p>
          ) : (
            <ul>
              {terms.map((term) => (
                <li key={term.name}>
                  <Link
                    to="/catalog/terms/$term"
                    params={{ term: term.name }}
                    className="text-accent"
                  >
                    {term.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2 className="text-heading font-semibold">Relationships</h2>
          {relationships.length === 0 ? (
            <p>No relationships name this column.</p>
          ) : (
            <ul>
              {relationships.map((relationship, index) => (
                <li key={index}>
                  <Link
                    to="/catalog/datasets/$id"
                    params={{ id }}
                    search={{ tab: "relationships", table: undefined }}
                    className="text-accent"
                  >
                    {relationship.from_table}[{relationship.from_column}] →{" "}
                    {relationship.to_table}[{relationship.to_column}]
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2 className="text-heading font-semibold">
            Measures whose DAX names this column
          </h2>
          {usedBy.length === 0 ? (
            <p>No measures name this column.</p>
          ) : (
            <ul>
              {usedBy.map((measure) => (
                <li key={measure.id} className="text-accent">
                  <MeasureLink
                    name={measure.name}
                    measureId={measure.id}
                    metric={measure.metric}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
