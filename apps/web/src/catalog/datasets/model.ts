import type { DiagramModel } from "../diagram/model";

type DatasetShape = {
  relationships_source: string | null;
  relationships_note: string | null;
  relationships: {
    from_table: string;
    from_column: string;
    to_table: string;
    to_column: string;
    cardinality: string | null;
    cross_filtering_behavior: string | null;
    is_active: boolean;
  }[];
  tables: { name: string; description: string | null }[];
};
type ColumnShape = {
  name: string;
  table: string;
  data_type: string | null;
  is_hidden: boolean;
  pii?: boolean;
};
type MeasureShape = {
  name: string;
  table: string;
  display_folder: string | null;
  format_string: string | null;
};

export function diagramModel(
  dataset: DatasetShape,
  columns: ColumnShape[],
  measures: MeasureShape[],
): DiagramModel {
  const unknown =
    dataset.relationships_source === "unavailable" ||
    (dataset.relationships.length === 0 && dataset.relationships_note !== null)
      ? (dataset.relationships_note ?? "Relationships are unavailable.")
      : null;
  return {
    unknown,
    relationships: dataset.relationships.map((relationship) => ({
      ...relationship,
      filters:
        relationship.cross_filtering_behavior === "both_directions"
          ? "both_ways"
          : "one_way",
    })),
    tables: dataset.tables.map((table) => ({
      ...table,
      columns: columns
        .filter((column) => column.table === table.name)
        .map((column) => ({
          name: column.name,
          type: column.data_type,
          hidden: column.is_hidden,
          ...(column.pii ? { pii: true } : {}),
        })),
      measures: measures
        .filter((measure) => measure.table === table.name)
        .map((measure) => ({
          name: measure.name,
          folder: measure.display_folder,
          format: measure.format_string,
        })),
    })),
  };
}
