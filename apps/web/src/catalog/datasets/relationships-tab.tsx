import { TABLE_BOX, TABLE_HEAD } from "../../admin/layout/ui";
import type { DiagramModel } from "../diagram/model";
import { cardinalityLabel, filteringTable } from "../diagram/layout";

/** On a phone one block per relationship, as a list: From over To, then its facts in a line. */
const COLUMNS =
  "flex flex-wrap gap-x-2 px-3 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_5rem] md:gap-3";
const FACT = "max-md:text-meta max-md:text-ink-3";

/** A column as DAX names it, which may break before its bracket. */
function ColumnName({ table, column }: { table: string; column: string }) {
  return (
    <>
      {"'"}
      {table}
      {"'"}
      <wbr />[{column}]
    </>
  );
}

export function RelationshipsTab({
  model,
  onOpenRelationship,
}: {
  model: DiagramModel;
  onOpenRelationship: (index: number) => void;
}) {
  return (
    <div>
      {model.unknown ? (
        <p className="text-ui text-ink-2">{model.unknown}</p>
      ) : (
        <div className={TABLE_BOX}>
          <div className="divide-y divide-line md:min-w-[52rem]">
            <div
              className={`${COLUMNS} ${TABLE_HEAD} py-2 font-medium max-md:hidden`}
            >
              <span>From</span>
              <span>To</span>
              <span>Cardinality</span>
              <span>Filters</span>
              <span>State</span>
            </div>
            {model.relationships.map((relationship, index) => (
              <button
                key={`${relationship.from_table}.${relationship.from_column}`}
                type="button"
                onClick={() => {
                  onOpenRelationship(index);
                }}
                className={`${COLUMNS} w-full py-2.5 text-left text-ui hover:bg-raised pointer-coarse:min-h-(--tap)`}
              >
                <span className="font-mono wrap-anywhere max-md:basis-full">
                  <ColumnName
                    table={relationship.from_table}
                    column={relationship.from_column}
                  />
                </span>
                <span className="font-mono wrap-anywhere max-md:mb-1 max-md:basis-full">
                  <span className="font-sans text-ink-3 md:hidden">to </span>
                  <ColumnName
                    table={relationship.to_table}
                    column={relationship.to_column}
                  />
                </span>
                <span className={FACT}>
                  {cardinalityLabel(relationship.cardinality)}
                </span>
                <span className={FACT}>
                  {relationship.filters === "both_ways"
                    ? "Both ways"
                    : filteringTable(
                        relationship.from_table,
                        relationship.to_table,
                        relationship.cardinality,
                      ).join(" filters ")}
                </span>
                <span className={FACT}>
                  {relationship.is_active ? "Active" : "Inactive"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
