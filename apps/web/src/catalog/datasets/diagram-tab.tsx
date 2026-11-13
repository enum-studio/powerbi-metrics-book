import { useState } from "react";
import { Segmented } from "../../admin/layout/ui";
import { Diagram, type DiagramFocus, Legend } from "../diagram/diagram";
import type { Density, DiagramModel, DiagramSelection } from "../diagram/model";
import { RelationshipPanel } from "./relationship-panel";
import { TablePanel } from "./table-panel";
import { TableSearch } from "./table-search";

export function DiagramTab({
  datasetId,
  model,
  density,
  selection,
  selectedTable,
  field,
  selectedRelationship,
  onDensity,
  onSelect,
  onOpenTable,
}: {
  datasetId: string;
  model: DiagramModel;
  density: Density;
  selection: DiagramSelection;
  selectedTable: DiagramModel["tables"][number] | undefined;
  field: string | undefined;
  selectedRelationship: DiagramModel["relationships"][number] | undefined;
  onDensity: (density: Density) => void;
  onSelect: (selection: DiagramSelection) => void;
  onOpenTable: (name: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [focus, setFocus] = useState<DiagramFocus>(null);
  return (
    <div className="overflow-clip rounded border border-line">
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2">
        <TableSearch
          names={model.tables.map((table) => table.name)}
          term={term}
          onTerm={setTerm}
          onPick={(name) => {
            onSelect({ kind: "table", name });
            setFocus((last) => ({ name, asked: (last?.asked ?? 0) + 1 }));
          }}
        />
        <Segmented
          label="Columns shown"
          value={density}
          onChange={onDensity}
          options={[
            { value: "keys", label: "Key columns" },
            { value: "all", label: "All columns" },
          ]}
        />
        {model.unknown === null && <Legend />}
      </div>
      {model.unknown && (
        <div className="bg-raised px-4 py-3">
          <strong className="text-ui text-ink">No lines drawn.</strong>
          <p className="text-ui text-ink-2">{model.unknown}</p>
        </div>
      )}
      <div className="flex flex-col bg-bg md:h-[calc(100dvh-24rem)] md:min-h-[32rem] md:flex-row">
        <div className="h-[32rem] min-w-0 flex-none md:h-auto md:flex-1">
          <Diagram
            model={model}
            density={density}
            selection={selection}
            onSelect={onSelect}
            term={term}
            focus={focus}
          />
        </div>
        {selection && (
          <aside className="w-full shrink-0 overflow-y-auto border-t border-line bg-surface p-4 md:w-[340px] md:border-l md:border-t-0">
            {selectedTable ? (
              <TablePanel
                datasetId={datasetId}
                table={selectedTable}
                field={field}
                model={model}
                onClose={() => {
                  onSelect(null);
                }}
                onRelationship={(index) => {
                  onSelect({ kind: "relationship", index });
                }}
              />
            ) : selectedRelationship ? (
              <RelationshipPanel
                relationship={selectedRelationship}
                onClose={() => {
                  onSelect(null);
                }}
                onTable={onOpenTable}
              />
            ) : null}
          </aside>
        )}
      </div>
    </div>
  );
}
