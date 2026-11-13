export type DatasetTab = "diagram" | "tables" | "measures" | "relationships";

export function DatasetTabs({
  counts,
  current,
  onChange,
}: {
  counts: {
    tables: number;
    measures: number;
    relationships: number | "unknown";
  };
  current: DatasetTab;
  onChange: (tab: DatasetTab) => void;
}) {
  const tabs: { label: string; value: DatasetTab }[] = [
    { label: "Diagram", value: "diagram" },
    { label: `Tables ${String(counts.tables)}`, value: "tables" },
    { label: `Measures ${String(counts.measures)}`, value: "measures" },
    {
      label: `Relationships ${String(counts.relationships)}`,
      value: "relationships",
    },
  ];
  return (
    <nav
      className="flex gap-5 overflow-x-auto border-b border-line"
      aria-label="Dataset"
    >
      {tabs.map(({ label, value }) => (
        <button
          key={value}
          type="button"
          onClick={() => {
            onChange(value);
          }}
          className={`shrink-0 border-b-2 py-2 text-ui whitespace-nowrap pointer-coarse:min-h-(--tap) ${current === value ? "border-accent font-medium text-ink" : "border-transparent text-ink-2"}`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
