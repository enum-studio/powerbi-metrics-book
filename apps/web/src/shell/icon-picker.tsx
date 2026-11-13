import {
  useMutation,
  useQuery,
  useQueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Search, Smile, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, read } from "../api/client";
import { meQuery } from "../api/me";
import { mayCurate } from "../review/format";
import { useDemo } from "./demo";
import { ItemIcon } from "./item-icon";

const COLUMNS = 8;

const iconChoicesQuery = queryOptions({
  queryKey: ["icons"],
  queryFn: () => read(api.GET("/api/v1/icons")),
  staleTime: Infinity,
});

/** The api's rule for an emoji (apps/api/src/services/book/icons.ts): one RGI emoji with no ASCII character, 32 bytes at most. */
const EMOJI = /^(?!.*\p{ASCII})\p{RGI_Emoji}$/v;
const EMOJI_BYTES = 32;

export const offered = (emoji: string) =>
  EMOJI.test(emoji) && new TextEncoder().encode(emoji).length <= EMOJI_BYTES;

/**
 * The list writes some emoji with a variation selector they do not need
 * ("💰" as U+1F4B0 U+FE0F), a form the api does not take as one emoji. Such an
 * emoji is offered without its selectors; one that needs them keeps them.
 */
const plainForm = (emoji: string) => {
  const plain = emoji.replaceAll("\uFE0F", "");
  return !offered(emoji) && offered(plain) ? plain : emoji;
};

/** The emoji the api takes, in their Unicode groups without the components, fetched when the Emoji tab first opens so they stay out of the first bundle. */
export async function loadEmoji() {
  const [{ default: list }, { default: messages }] = await Promise.all([
    import("emojibase-data/en/compact.json"),
    import("emojibase-data/en/messages.json"),
  ]);
  return messages.groups.flatMap(({ key, order, message }) => {
    const items = list
      .filter((emoji) => emoji.group === order)
      .map((emoji) => ({ ...emoji, unicode: plainForm(emoji.unicode) }))
      .filter((emoji) => offered(emoji.unicode))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return key === "component" || items.length === 0
      ? []
      : [{ title: message, items }];
  });
}

const emojiQuery = queryOptions({
  queryKey: ["emoji-data"],
  queryFn: loadEmoji,
  staleTime: Infinity,
});

const TAB = (on: boolean) =>
  `rounded px-2.5 py-1 text-ui ${on ? "bg-raised font-medium text-ink" : "text-ink-3 hover:text-ink"}`;
const CELL =
  "flex aspect-square items-center justify-center rounded text-ink hover:bg-raised focus-visible:bg-raised";

/** A grid whose cells are buttons: the arrows move between them, Enter chooses (the button's own click). */
function Grid({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const move = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    }[event.key];
    if (step === undefined) return;
    const cells = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("button"),
    ];
    const at = cells.indexOf(document.activeElement as HTMLElement);
    const next = cells[Math.min(Math.max(at + step, 0), cells.length - 1)];
    if (at < 0 || next === undefined) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <fieldset
      aria-label={label}
      className="max-h-64 min-w-0 overflow-y-auto border-0 p-0"
      onKeyDown={move}
    >
      {children}
    </fieldset>
  );
}

function EmojiTab({
  query,
  onPick,
}: {
  query: string;
  onPick: (emoji: string) => void;
}) {
  const emoji = useQuery(emojiQuery);
  if (emoji.error)
    return <p className="p-3 text-meta text-out">Emoji could not load.</p>;
  if (emoji.data === undefined)
    return <p className="p-3 text-meta text-ink-3">Loading emoji</p>;
  const needle = query.trim().toLowerCase();
  const groups = emoji.data.flatMap(({ title, items }) => {
    const shown = items.filter(
      ({ label, tags }) =>
        needle === "" ||
        label.includes(needle) ||
        (tags ?? []).some((tag) => tag.includes(needle)),
    );
    return shown.length === 0 ? [] : [{ title, items: shown }];
  });
  if (groups.length === 0)
    return <p className="p-3 text-meta text-ink-3">No emoji match.</p>;
  return (
    <Grid label="Emoji">
      {groups.map(({ title, items }) => (
        <section key={title}>
          <h3 className="px-1 pt-2 pb-1 text-label text-ink-3 capitalize">
            {title}
          </h3>
          <div className="grid grid-cols-8 gap-0.5">
            {items.map(({ unicode, label }) => (
              <button
                key={unicode}
                type="button"
                title={label}
                aria-label={label}
                className={`${CELL} text-body`}
                onClick={() => {
                  onPick(unicode);
                }}
              >
                {unicode}
              </button>
            ))}
          </div>
        </section>
      ))}
    </Grid>
  );
}

function IconsTab({
  query,
  color,
  onColor,
  onPick,
}: {
  query: string;
  color: string;
  onColor: (color: string) => void;
  onPick: (glyph: string) => void;
}) {
  const choices = useQuery(iconChoicesQuery);
  if (choices.error)
    return <p className="p-3 text-meta text-out">Icons could not load.</p>;
  if (choices.data === undefined)
    return <p className="p-3 text-meta text-ink-3">Loading icons</p>;
  const needle = query.trim().toLowerCase().replaceAll(" ", "-");
  const glyphs = choices.data.glyphs.filter((name) => name.includes(needle));
  return (
    <>
      <fieldset aria-label="Color" className="flex gap-2 border-0 px-1 py-2">
        {choices.data.colors.map((name) => (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={name === color}
            className="size-5 rounded-full outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-ink"
            style={{ backgroundColor: `var(--icon-${name})` }}
            onClick={() => {
              onColor(name);
            }}
          />
        ))}
      </fieldset>
      {glyphs.length === 0 ? (
        <p className="p-3 text-meta text-ink-3">No icons match.</p>
      ) : (
        <Grid label="Icons">
          <div className="grid grid-cols-8 gap-0.5">
            {glyphs.map((name) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={name}
                className={CELL}
                onClick={() => {
                  onPick(name);
                }}
              >
                <ItemIcon icon={`glyph:${name}:${color}`} fallback={Smile} />
              </button>
            ))}
          </div>
        </Grid>
      )}
    </>
  );
}

/**
 * Chooses how a book element looks, as Secoda's picker does: an Emoji tab and
 * an Icons tab with the eight colours, each with a search field, and Reset.
 * It sits under the element that holds it (a `relative` parent). Esc and a
 * click outside close it.
 */
export function IconPicker({
  value,
  onChange,
  onClose,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"emoji" | "icons">(
    value?.startsWith("glyph:") === true ? "icons" : "emoji",
  );
  const [query, setQuery] = useState("");
  const [color, setColor] = useState(
    value?.startsWith("glyph:") === true
      ? (value.split(":")[2] ?? "gray")
      : "gray",
  );
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
  }, [tab]);
  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-10"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Choose an icon"
        className="absolute top-full left-0 z-20 mt-2 w-80 max-w-[calc(100vw-var(--space-8))] rounded-sheet border border-line bg-surface p-2 shadow-sheet"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="flex items-center gap-1 pb-2">
          <div role="tablist" className="flex gap-1">
            {(["emoji", "icons"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                className={TAB(tab === name)}
                onClick={() => {
                  setTab(name);
                  setQuery("");
                }}
              >
                {name === "emoji" ? "Emoji" : "Icons"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ml-auto rounded px-2.5 py-1 text-ui text-ink-3 hover:text-ink"
            onClick={() => {
              onChange(null);
            }}
          >
            Reset
          </button>
        </div>
        <label className="flex items-center gap-2 rounded border border-line-control px-2 focus-within:border-accent">
          <Search size={14} strokeWidth={1.5} aria-hidden="true" />
          <input
            ref={search}
            type="search"
            value={query}
            aria-label={tab === "emoji" ? "Search emoji" : "Search icons"}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-ui outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        {tab === "emoji" ? (
          <EmojiTab
            query={query}
            onPick={(emoji) => {
              onChange(`emoji:${emoji}`);
            }}
          />
        ) : (
          <IconsTab
            query={query}
            color={color}
            onColor={setColor}
            onPick={(name) => {
              onChange(`glyph:${name}:${color}`);
            }}
          />
        )}
      </div>
    </>
  );
}

type Kind = "metric" | "category" | "term" | "workspace" | "dataset";

/**
 * The icon above a page's title. A curator or an admin gets a button that
 * opens the picker; anyone else sees the icon alone, and nothing when none is set.
 */
export function PageIcon({
  kind,
  id,
  icon,
  fallback,
  size = 32,
}: {
  kind: Kind;
  id: string;
  icon: string | null;
  fallback: LucideIcon;
  size?: number;
}) {
  const me = useQuery(meQuery).data;
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const change = useMutation({
    mutationFn: (next: string | null) => {
      const target = { params: { path: { kind, id } } };
      return next === null
        ? read(api.DELETE("/api/v1/elements/{kind}/{id}/icon", target))
        : read(
            api.PUT("/api/v1/elements/{kind}/{id}/icon", {
              ...target,
              body: { icon: next },
            }),
          );
    },
    onSuccess: async () => {
      setOpen(false);
      await queries.invalidateQueries();
    },
  });
  const demo = useDemo();
  const mayChange =
    !demo && me !== null && me !== undefined && (me.may_admin || mayCurate(me));
  if (!mayChange)
    return icon === null ? null : (
      <ItemIcon icon={icon} fallback={fallback} size={size} />
    );
  return (
    <div className="relative w-fit">
      <button
        type="button"
        aria-label="Change the icon"
        aria-expanded={open}
        className="flex items-center justify-center rounded p-1 text-ink-3 hover:bg-raised pointer-coarse:min-h-(--tap)"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <ItemIcon icon={icon} fallback={fallback} size={size} />
      </button>
      {open && (
        <IconPicker
          value={icon}
          onChange={(next) => {
            change.mutate(next);
          }}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
      {change.error && (
        <p role="alert" className="text-meta text-out">
          {change.error.message}
        </p>
      )}
    </div>
  );
}
