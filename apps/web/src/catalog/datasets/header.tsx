import { useQuery } from "@tanstack/react-query";
import { Database, Layers } from "lucide-react";
import { PageIcon } from "../../shell/icon-picker";
import { formatTime } from "../../shell/time";
import { workspacesQuery } from "../queries";
import { Breakable } from "../../shell/breakable";

type DatasetHeaderData = {
  id: string;
  icon: string | null;
  workspace: { id: string; name: string };
  name: string;
  target_storage_mode: string | null;
  endorsement: string | null;
  has_row_level_security: boolean;
  relationships_source: string | null;
  synced_at: string;
  description: string | null;
  description_pbi: string | null;
};

/** A page's short facts beside its title, the empty ones left out. */
export function Facts({
  facts,
}: {
  facts: readonly (string | null | false)[];
}) {
  return (
    <p className="flex flex-wrap font-mono text-meta text-ink-3">
      {facts.filter(Boolean).map((fact, i) => (
        <span key={String(fact)} className="whitespace-nowrap">
          {i > 0 && <span className="px-2 text-line-strong">/</span>}
          {fact}
        </span>
      ))}
    </p>
  );
}

export function DatasetHeader({
  dataset,
  unknown,
}: {
  dataset: DatasetHeaderData;
  unknown: string | null;
}) {
  const workspaceIcon = useQuery(workspacesQuery).data?.find(
    (w) => w.id === dataset.workspace.id,
  )?.icon;
  const facts = [
    dataset.target_storage_mode,
    dataset.endorsement,
    ...(dataset.has_row_level_security ? ["Row-level security"] : []),
    unknown
      ? "Relationships unknown"
      : dataset.relationships_source === "scanner"
        ? "Relationships from the scanner"
        : "Relationships from INFO views",
    `Synced ${formatTime(dataset.synced_at)}`,
  ];
  return (
    <header className="flex flex-col gap-1">
      <PageIcon
        kind="dataset"
        id={dataset.id}
        icon={dataset.icon}
        fallback={Database}
      />
      <div className="flex items-center gap-1 text-meta text-ink-3">
        <PageIcon
          kind="workspace"
          id={dataset.workspace.id}
          icon={workspaceIcon ?? null}
          fallback={Layers}
          size={14}
        />
        <p>{dataset.workspace.name} workspace</p>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h1 className="text-title font-semibold text-ink">
          <Breakable text={dataset.name} />
        </h1>
        <Facts facts={facts} />
      </div>
      <p className="truncate text-ui text-ink-2">
        {dataset.description ?? dataset.description_pbi ?? ""}
      </p>
    </header>
  );
}
