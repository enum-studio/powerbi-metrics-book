import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { CornerDownLeft, Search as SearchIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { typingIn } from "../../shell/keys";
import { ErrorState } from "../../shell/states";
import { groupSearchHits, hitPage, type SearchHit } from "./model";
import { ResultBody } from "./results";
import { searchQuery } from "./queries";

/** The search dialog, opened from the first lane or with `/` or Cmd+K (Home, the search page, takes these keys first): what is typed is the first row and goes to the full results; below it the best hits, by arrow keys and Enter. */
export function CatalogSearch({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  // Home is the search page and takes these keys for its own box. It may not be mounted yet (the page suspends while its data loads), so the dialog stands aside by path, not by what Home has handled.
  const onHome = useLocation({
    select: (location) => location.pathname === "/",
  });
  useEffect(() => {
    if (onHome) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const slash = event.key === "/" && !typingIn(event.target);
      const palette =
        event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
      if (!slash && !palette) return;
      event.preventDefault();
      onOpen();
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
    };
  }, [onOpen, onHome]);
  return (
    <dialog
      ref={dialog}
      aria-label="Search"
      className="m-0 h-dvh max-h-dvh w-screen max-w-none bg-scrim open:block"
      onClose={onClose}
    >
      {open && <SearchPanel onClose={onClose} />}
      <button
        type="button"
        aria-label="Close the search"
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
    </dialog>
  );
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(value.trim());
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value]);
  const result = useQuery(searchQuery(query));
  const groups = useMemo(
    () => groupSearchHits(result.data?.items ?? []),
    [result.data],
  );
  const hits = groups.flatMap((group) => group.hits);
  const typed = value.trim();
  const hasQuery = typed.length >= 2;
  // Row 0 is what was typed; the hits follow it.
  const rows = hasQuery ? hits.length + 1 : 0;
  useEffect(() => {
    setActive(0);
  }, [query, hits.length]);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const openAll = () => {
    onClose();
    void navigate({
      to: "/",
      search: { q: typed },
    });
  };
  const openHit = (hit: SearchHit | undefined) => {
    const page = hit && hitPage(hit);
    if (!page) return;
    onClose();
    void navigate(page);
  };

  return (
    <div className="relative z-10 mx-auto mt-[12dvh] flex max-h-[76dvh] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-clip rounded-sheet bg-surface shadow-sheet">
      <div className="flex min-h-12 items-center gap-3 border-b border-line px-4 text-ink-2">
        <SearchIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        <input
          role="combobox"
          aria-label="Search the catalog"
          aria-autocomplete="list"
          aria-expanded={hasQuery}
          aria-controls={hasQuery ? "catalog-search-results" : undefined}
          aria-activedescendant={
            hasQuery ? `catalog-search-${String(active)}` : undefined
          }
          className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
          placeholder="Search metrics, terms, datasets, tables and columns"
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && rows > 0) {
              event.preventDefault();
              setActive((index) => (index + 1) % rows);
            } else if (event.key === "ArrowUp" && rows > 0) {
              event.preventDefault();
              setActive((index) => (index - 1 + rows) % rows);
            } else if (event.key === "Enter" && hasQuery) {
              event.preventDefault();
              if (active === 0) openAll();
              else openHit(hits[active - 1]);
            }
          }}
        />
      </div>
      {!hasQuery ? (
        <p className="p-4 text-ui text-ink-2">
          Type a name or what it means. Agents search the same index.
        </p>
      ) : (
        <div
          ref={list}
          id="catalog-search-results"
          role="listbox"
          aria-label="Catalog search results"
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          <Row
            index={0}
            active={active}
            onActive={setActive}
            onChoose={openAll}
          >
            <SearchIcon
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
              className="shrink-0 text-ink-2"
            />
            <span className="min-w-0 truncate text-ui font-medium text-ink">
              {typed}
              <span className="font-normal text-ink-3"> in all results</span>
            </span>
          </Row>
          {result.isError ? (
            <ErrorState error={result.error} />
          ) : (
            result.isSuccess &&
            hits.length === 0 && (
              <p className="p-2 text-ui text-ink-2">
                Nothing matches. Agents search the same index.
              </p>
            )
          )}
          {groups.map((group) => (
            <section key={group.label} role="group" aria-label={group.label}>
              <p
                aria-hidden="true"
                className="px-2 pt-3 pb-1 text-meta text-ink-3"
              >
                {group.label}
              </p>
              {group.hits.map((hit) => (
                <Row
                  key={`${hit.kind}:${hit.id}`}
                  index={hits.indexOf(hit) + 1}
                  active={active}
                  onActive={setActive}
                  onChoose={() => {
                    openHit(hit);
                  }}
                >
                  <ResultBody hit={hit} query={query} />
                </Row>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  index,
  active,
  onActive,
  onChoose,
  children,
}: {
  index: number;
  active: number;
  onActive: (index: number) => void;
  onChoose: () => void;
  children: ReactNode;
}) {
  const current = index === active;
  return (
    <div
      id={`catalog-search-${String(index)}`}
      role="option"
      aria-selected={current}
      className={`flex min-h-9 cursor-pointer items-center gap-3 rounded px-2 py-1.5 ${current ? "bg-raised" : ""}`}
      onMouseEnter={() => {
        onActive(index);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onChoose}
    >
      {children}
      {current && (
        <CornerDownLeft
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className="ml-auto shrink-0 text-ink-3 pointer-coarse:hidden"
        />
      )}
    </div>
  );
}
