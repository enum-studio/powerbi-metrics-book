import { Search, Table2, X } from "lucide-react";
import { useId, useState } from "react";
import { INPUT } from "../../admin/layout/ui";
import { findTables } from "../diagram/find";

const ICON = { size: 14, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * The diagram's search: a box that finds tables by name as a person types,
 * with the hits listed under it. The arrow keys move through them, Enter or a
 * click picks one, and Escape closes the list, then clears the box.
 */
export function TableSearch({
  names,
  term,
  onTerm,
  onPick,
}: {
  names: readonly string[];
  term: string;
  onTerm: (term: string) => void;
  onPick: (name: string) => void;
}) {
  const id = useId();
  const [listed, setListed] = useState(false);
  const [active, setActive] = useState(0);
  const hits = findTables(names, term);
  const open = listed && term.trim() !== "";
  const showing = open && hits.length > 0;
  const pick = (name: string | undefined) => {
    if (name === undefined) return;
    setListed(false);
    onPick(name);
  };
  return (
    <div className="relative w-full sm:w-64">
      <Search
        {...ICON}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"
      />
      <input
        role="combobox"
        aria-label="Find a table"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? `${id}-hits` : undefined}
        aria-activedescendant={
          showing ? `${id}-hit-${String(active)}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        placeholder="Find a table"
        className={`${INPUT} pl-8 ${term === "" ? "" : "pr-8"}`}
        value={term}
        onChange={(event) => {
          onTerm(event.currentTarget.value);
          setListed(true);
          setActive(0);
        }}
        onFocus={() => {
          setListed(true);
        }}
        onBlur={() => {
          setListed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!showing) {
              setListed(true);
              return;
            }
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((at) => (at + step + hits.length) % hits.length);
          } else if (event.key === "Enter" && showing) {
            event.preventDefault();
            pick(hits[active]);
          } else if (event.key === "Escape" && (open || term !== "")) {
            // The box's own Escape: the page's Escape, which clears the selection, waits for the next.
            event.preventDefault();
            if (open) setListed(false);
            else onTerm("");
          }
        }}
      />
      {term !== "" && (
        <button
          type="button"
          aria-label="Clear the search"
          className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-3 hover:bg-raised hover:text-ink pointer-coarse:size-(--tap)"
          onClick={() => {
            onTerm("");
          }}
        >
          <X {...ICON} />
        </button>
      )}
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 w-full min-w-56 rounded border border-line bg-surface p-1 shadow-sheet">
          {hits.length === 0 ? (
            <p role="status" className="px-2 py-1.5 text-ui text-ink-2">
              No table has that in its name.
            </p>
          ) : (
            <div id={`${id}-hits`} role="listbox" aria-label="Tables found">
              {hits.map((name, index) => (
                <div
                  key={name}
                  id={`${id}-hit-${String(index)}`}
                  role="option"
                  aria-selected={index === active}
                  className={`flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 text-ui text-ink pointer-coarse:min-h-(--tap) ${index === active ? "bg-raised" : ""}`}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onMouseDown={(event) => {
                    // Keep the box's focus, so the click lands as a pick.
                    event.preventDefault();
                  }}
                  onClick={() => {
                    pick(name);
                  }}
                >
                  <Table2 {...ICON} className="shrink-0 text-ink-3" />
                  <span className="min-w-0 truncate">{name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
