import type { DiagramModel } from "../diagram/model";
import { cardinalityLabel, filteringTable } from "../diagram/layout";
import { PanelTitle } from "./table-panel";

export function RelationshipPanel({
  relationship,
  onClose,
  onTable,
}: {
  relationship: DiagramModel["relationships"][number];
  onClose: () => void;
  onTable: (name: string) => void;
}) {
  return (
    <>
      <PanelTitle title="Relationship" onClose={onClose} />
      <p className="font-mono text-ui">
        {"'"}
        {relationship.from_table}
        {"'"}[{relationship.from_column}] to {"'"}
        {relationship.to_table}
        {"'"}[{relationship.to_column}]
      </p>
      <dl className="mt-5 space-y-3 text-ui">
        <dt className="font-semibold">Cardinality</dt>
        <dd>{cardinalityLabel(relationship.cardinality)}</dd>
        <dt className="font-semibold">Filters</dt>
        <dd>
          {relationship.filters === "both_ways"
            ? "Both ways"
            : filteringTable(
                relationship.from_table,
                relationship.to_table,
                relationship.cardinality,
              ).join(" filters ")}
        </dd>
        <dt className="font-semibold">State</dt>
        <dd>
          {relationship.is_active
            ? "Active"
            : "Inactive. A query uses it through USERELATIONSHIP."}
        </dd>
      </dl>
      <div className="mt-5 flex gap-3">
        {[relationship.from_table, relationship.to_table].map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => {
              onTable(name);
            }}
            className="text-ui text-accent underline"
          >
            {name}
          </button>
        ))}
      </div>
    </>
  );
}
