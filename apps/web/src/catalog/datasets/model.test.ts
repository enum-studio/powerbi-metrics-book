import { describe, expect, it } from "vitest";
import { diagramModel } from "./model";

describe("diagramModel", () => {
  it("maps both direction relationships and groups every column by table", () => {
    const model = diagramModel(
      {
        relationships_source: "scanner",
        relationships_note: null,
        relationships: [
          {
            from_table: "Orders",
            from_column: "RegionId",
            to_table: "Regions",
            to_column: "Id",
            cardinality: "many_to_one",
            cross_filtering_behavior: "both_directions",
            is_active: true,
          },
        ],
        tables: [
          { name: "Orders", description: "Orders" },
          { name: "Regions", description: null },
        ],
      },
      [
        {
          name: "RegionId",
          table: "Orders",
          data_type: "int64",
          is_hidden: false,
          pii: true,
        },
        { name: "Id", table: "Regions", data_type: "int64", is_hidden: true },
      ],
      [
        {
          name: "Gross",
          table: "Orders",
          display_folder: null,
          format_string: "#,##0.00",
        },
      ],
    );
    expect(model.relationships[0]?.filters).toBe("both_ways");
    expect(model.tables[0]?.columns[0]?.pii).toBe(true);
    expect(model.tables[1]?.columns[0]?.pii).toBeUndefined();
    expect(model.tables[0]?.measures[0]).toMatchObject({ format: "#,##0.00" });
    expect(model.relationships[0]?.cardinality).toBe("many_to_one");
    expect(
      model.tables.map((table) => table.columns.map((column) => column.name)),
    ).toEqual([["RegionId"], ["Id"]]);
  });

  it("preserves the unknown relationship note when unavailable", () => {
    expect(
      diagramModel(
        {
          relationships_source: "unavailable",
          relationships_note: "Schema is refreshing.",
          relationships: [],
          tables: [],
        },
        [],
        [],
      ).unknown,
    ).toBe("Schema is refreshing.");
  });
});
