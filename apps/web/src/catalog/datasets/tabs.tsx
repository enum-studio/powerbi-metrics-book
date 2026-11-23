export type DatasetTab =
  "diagram" | "documentation" | "tables" | "measures" | "relationships";

export function PageTabs<T extends string>({
  label,
  tabs,
  current,
  onChange,
}: {
  label: string;
  tabs: { label: string; value: T }[];
  current: T;
  onChange: (tab: T) => void;
}) {
  return (
    <nav
      className="flex gap-5 overflow-x-auto border-b border-line"
      aria-label={label}
    >
      {tabs.map(({ label: name, value }) => (
        <button
          key={value}
          type="button"
          aria-current={current === value ? "page" : undefined}
          onClick={() => {
            onChange(value);
          }}
          className={`shrink-0 border-b-2 py-2 text-ui whitespace-nowrap pointer-coarse:min-h-(--tap) ${current === value ? "border-accent font-medium text-ink" : "border-transparent text-ink-2"}`}
        >
          {name}
        </button>
      ))}
    </nav>
  );
}

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
  return (
    <PageTabs
      label="Dataset"
      current={current}
      onChange={onChange}
      tabs={[
        { label: "Diagram", value: "diagram" },
        { label: "Documentation", value: "documentation" },
        { label: `Tables ${String(counts.tables)}`, value: "tables" },
        { label: `Measures ${String(counts.measures)}`, value: "measures" },
        {
          label: `Relationships ${String(counts.relationships)}`,
          value: "relationships",
        },
      ]}
    />
  );
}
