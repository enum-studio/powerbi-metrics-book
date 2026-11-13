import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { categoriesQuery, datasetsQuery, workspacesQuery } from "../queries";
import { ErrorState } from "../../shell/states";
import { SEARCH_KINDS, SECTIONS, type SearchFilters } from "./model";

const TRUST = ["draft", "agent_verified", "human_verified"] as const;
const LABELS = ["Draft", "Agent verified", "Human verified"];
const CONTROL =
  "rounded border border-line-control bg-surface px-2 py-1 text-ui text-ink";
/** No trust state chosen is no trust filter: the api refuses an empty list. */
function withTrust(value: SearchFilters, trust: string[] | undefined) {
  return { ...value, trust: trust?.length ? trust : undefined };
}

export function Filters({
  value,
  onChange,
}: {
  value: SearchFilters;
  onChange: (next: SearchFilters) => void;
}) {
  const [adding, setAdding] = useState("");
  const workspaces = useQuery({
    ...workspacesQuery,
    enabled: adding === "workspace" || value.workspace !== undefined,
  });
  const datasets = useQuery({
    ...datasetsQuery,
    enabled: adding === "dataset" || value.dataset !== undefined,
  });
  const categories = useQuery({
    ...categoriesQuery,
    enabled: adding === "category" || value.category !== undefined,
  });
  const options =
    adding === "workspace"
      ? workspaces.data
      : adding === "dataset"
        ? datasets.data
        : categories.data;
  const error =
    adding === "workspace"
      ? workspaces.error
      : adding === "dataset"
        ? datasets.error
        : categories.error;
  const held = {
    workspace: workspaces.data?.find((item) => item.id === value.workspace)
      ?.name,
    dataset: datasets.data?.find((item) => item.id === value.dataset)?.name,
    category: categories.data?.find((item) => item.path === value.category)
      ?.name,
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-ui text-ink-2">
        Type{" "}
        <select
          aria-label="Type"
          className={CONTROL}
          value={value.kind ?? ""}
          onChange={(event) => {
            onChange({
              ...value,
              kind: SEARCH_KINDS.find((kind) => kind === event.target.value),
            });
          }}
        >
          <option value="">All</option>
          {SECTIONS.map(({ kind, label }) => (
            <option key={kind} value={kind === "variant" ? "measure" : kind}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <select
        aria-label="Add filter"
        className={CONTROL}
        value={adding}
        onChange={(event) => {
          setAdding(event.target.value);
        }}
      >
        <option value="">Add filter</option>
        {["Trust", "Workspace", "Dataset", "Category"].map((label) => (
          <option key={label} value={label.toLowerCase()}>
            {label}
          </option>
        ))}
      </select>
      {adding === "trust" ? (
        <fieldset className="flex gap-2">
          <legend className="sr-only">Trust</legend>
          {TRUST.map((state, index) => (
            <label key={state} className="text-meta text-ink-2">
              <input
                type="checkbox"
                checked={value.trust?.includes(state) ?? false}
                onChange={(event) => {
                  onChange(
                    withTrust(
                      value,
                      event.target.checked
                        ? [...(value.trust ?? []), state]
                        : value.trust?.filter((item) => item !== state),
                    ),
                  );
                }}
              />
              {LABELS[index]}
            </label>
          ))}
        </fieldset>
      ) : (
        adding && (
          <label className="text-ui text-ink-2">
            {adding}
            <select
              aria-label={`Choose ${adding}`}
              className={CONTROL}
              value=""
              onChange={(event) => {
                onChange({ ...value, [adding]: event.target.value });
                setAdding("");
              }}
            >
              <option value="">Choose {adding}</option>
              {options?.map((item) => (
                <option
                  key={item.id}
                  value={"path" in item ? item.path : item.id}
                >
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )
      )}
      {error && <ErrorState error={error} />}
      {value.trust?.map((state) => (
        <button
          key={state}
          type="button"
          className={CONTROL}
          aria-label={`Remove trust ${state}`}
          onClick={() => {
            onChange(
              withTrust(
                value,
                value.trust?.filter((item) => item !== state),
              ),
            );
          }}
        >
          Trust: {state.replaceAll("_", " ")} ×
        </button>
      ))}
      {(["workspace", "dataset", "category"] as const).map(
        (key) =>
          value[key] && (
            <button
              key={key}
              type="button"
              className={CONTROL}
              aria-label={`Remove ${key}`}
              onClick={() => {
                onChange({ ...value, [key]: undefined });
              }}
            >
              {key}: {held[key]} ×
            </button>
          ),
      )}
    </div>
  );
}
