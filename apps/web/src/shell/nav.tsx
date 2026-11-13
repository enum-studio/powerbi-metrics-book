import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
  Activity,
  House,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import {
  ACCOUNT_NAV,
  ACCOUNT_SECTION,
  ADMIN_NAV,
  ADMIN_SECTIONS,
  SETTINGS_HOME,
} from "../admin/layout/nav";
import { signOut } from "../api/client";
import type { Me } from "../api/me";
import { CatalogSearch } from "../catalog/search/search";
import { CatalogTree } from "../catalog/tree/tree";
import { FoldMark, useFold } from "./fold";
import { LaneEdge, useLaneSize } from "./lane-edge";
import { isLaneShortcut, LANE_SHORTCUT } from "./lane-size";
import { useDemo } from "./demo";
import { BrandIdentity } from "./mark";
import {
  ARROW_PLACE,
  FOLD_LINK,
  FOLD_ROW,
  FOLD_ROW_CURRENT,
  indent,
  inSettingsPage,
  NAV_LABEL,
  NAV_ROW,
  showCurrentRow,
  STANDS_FOR_PAGE,
} from "./nav-row";
import { browserThemeHost, shownTheme, toggleTheme } from "./theme";

const ICON_BUTTON =
  "grid size-7 shrink-0 place-items-center rounded text-ink-2 hover:bg-raised hover:text-ink disabled:text-ink-3 pointer-coarse:size-(--tap)";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

const SEARCH_LABEL = "Search the catalog";
const HIDE_LABEL = "Hide the sidebar";
const SHOW_LABEL = "Show the sidebar";

export function ThemeToggle({ personId }: { personId: string | null }) {
  const [theme, setTheme] = useState(() => shownTheme(browserThemeHost()));
  const other = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      aria-label={`Switch to the ${other} theme`}
      title={`Switch to the ${other} theme`}
      className={ICON_BUTTON}
      onClick={() => {
        setTheme(toggleTheme(browserThemeHost(), personId));
      }}
    >
      <Icon {...ICON} />
    </button>
  );
}

export function useSignOut() {
  const leave = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      // A new page load, so nothing of this person's stays in memory. `/` is
      // public and sends someone signed out on to sign in.
      window.location.assign("/");
    },
  });
  if (leave.error !== null) throw leave.error;
  return leave;
}

/** Settings' pages in their sections: the second lane's rows or, in the drawer, what folds out under Settings. */
function SettingsPages({ me, nested = false }: { me: Me; nested?: boolean }) {
  const sections = [
    { name: ACCOUNT_SECTION, items: ACCOUNT_NAV },
    ...(me.may_admin
      ? ADMIN_SECTIONS.map((section) => ({
          name: section,
          items: ADMIN_NAV.filter((item) => item.section === section),
        }))
      : []),
  ];
  return sections.map(({ name, items }) => (
    <div key={name} className="flex flex-col gap-0.5">
      <p className={`${NAV_LABEL} ${nested ? "pt-2 pl-8" : ""}`}>{name}</p>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: true }}
          className={`${NAV_ROW} ${nested ? "pl-8" : ""}`}
        >
          {!nested && <item.icon {...ICON} />}
          {item.label}
        </Link>
      ))}
    </div>
  ));
}

/** The button that hides the first lane beside the page, where the lane has one. */
type LaneHide = {
  onClick: () => void;
  button: RefObject<HTMLButtonElement | null>;
  controls: string;
};

/** The first lane, in Secoda's order: the name and, beside the page, the search and hide buttons at the top; Home, then Metrics, Terms and Datasets; Status and Settings pinned below; who is signed in at the foot. In the drawer, where no second lane fits, Settings' pages fold out under it, and it folds as a whole row. */
function FirstLane({
  me,
  hide,
  onSearch,
  nested = false,
}: {
  me: Me;
  hide?: LaneHide;
  onSearch?: () => void;
  nested?: boolean;
}) {
  const path = useLocation({ select: (location) => location.pathname });
  const inSettings = inSettingsPage(path);
  const [settingsOpen, setSettingsOpen] = useFold(inSettings);
  const pagesShown = nested && settingsOpen;
  const leave = useSignOut();
  const demo = useDemo();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex shrink-0 items-center gap-2 bg-bg pr-2 pl-4 ${nested ? "rounded-tr-sheet border-b border-line pt-(--safe-top)" : "pt-[calc(var(--space-2)+var(--safe-top))] pb-2"}`}
      >
        <Link
          to="/"
          className={`inline-flex min-w-0 flex-1 items-center gap-2 text-ui font-semibold whitespace-nowrap text-ink ${nested ? "min-h-(--tap) focus-visible:-outline-offset-2" : ""}`}
        >
          <BrandIdentity size={16} />
        </Link>
        {onSearch !== undefined && (
          <button
            type="button"
            aria-label={SEARCH_LABEL}
            title={`${SEARCH_LABEL} (/)`}
            className={`${ICON_BUTTON} hidden lg:grid`}
            onClick={onSearch}
          >
            <Search {...ICON} />
          </button>
        )}
        {hide !== undefined && (
          <button
            ref={hide.button}
            type="button"
            aria-label={HIDE_LABEL}
            aria-controls={hide.controls}
            aria-expanded={true}
            title={`${HIDE_LABEL} (${LANE_SHORTCUT})`}
            className={`${ICON_BUTTON} hidden lg:grid`}
            onClick={hide.onClick}
          >
            <PanelLeftClose {...ICON} />
          </button>
        )}
      </div>
      <nav
        aria-label="Main"
        className={`${ARROW_PLACE} flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pt-1`}
      >
        <div className="flex flex-col gap-0.5 px-2">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className={NAV_ROW}
            style={indent(0, false)}
          >
            <House {...ICON} />
            Home
          </Link>
        </div>
        {/* Metrics, Terms and Datasets scroll by themselves, so Status and Settings stay put. With no room for that, on a landscape phone or with Settings' pages open in the drawer, the whole lane scrolls. */}
        <div
          className={`mt-0.5 ${pagesShown ? "flex-auto shrink-0" : "min-h-0 flex-1 overflow-y-auto [@media(max-height:35rem)]:flex-none [@media(max-height:35rem)]:overflow-visible"}`}
        >
          <CatalogTree />
        </div>
        <div className="flex flex-col gap-0.5 px-2 pt-3 pb-2">
          {me.may_admin && !demo && (
            <Link
              to="/admin"
              activeOptions={{ exact: true }}
              className={NAV_ROW}
              style={indent(0, false)}
            >
              <Activity {...ICON} />
              Status
            </Link>
          )}
          {demo ? null : nested ? (
            <button
              type="button"
              aria-expanded={settingsOpen}
              className={`${FOLD_ROW} ${FOLD_ROW_CURRENT} text-left`}
              onClick={() => {
                setSettingsOpen(!settingsOpen);
              }}
            >
              <FoldMark open={settingsOpen} />
              <span
                className={FOLD_LINK}
                {...(inSettings && !settingsOpen ? STANDS_FOR_PAGE : {})}
              >
                <Settings {...ICON} />
                Settings
              </span>
            </button>
          ) : (
            <Link
              to={SETTINGS_HOME}
              className={NAV_ROW}
              style={indent(0, false)}
              {...(inSettings ? STANDS_FOR_PAGE : {})}
            >
              <Settings {...ICON} />
              Settings
            </Link>
          )}
          {pagesShown && !demo && (
            <nav aria-label="Settings pages" className="flex flex-col gap-0.5">
              <SettingsPages me={me} nested />
            </nav>
          )}
        </div>
      </nav>
      <section
        aria-label="Your account"
        className="flex shrink-0 items-center gap-1 border-t border-line py-2 pr-2 pb-[calc(var(--space-2)+var(--safe-bottom))] pl-4"
      >
        <span
          className="min-w-0 flex-1 truncate text-meta text-ink-2"
          title={me.email ?? me.name ?? undefined}
        >
          {me.email ?? me.name}
        </span>
        <ThemeToggle personId={me.id} />
        {!demo && (
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            disabled={leave.isPending}
            className={ICON_BUTTON}
            onClick={() => {
              leave.mutate();
            }}
          >
            <LogOut {...ICON} />
          </button>
        )}
      </section>
    </div>
  );
}

/** The second lane, wherever the first lane is shown: from 1024px. A wide table scrolls inside the page rather than moving the lane. */
function SecondLane({ me }: { me: Me }) {
  const nav = useRef<HTMLElement>(null);
  const path = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    showCurrentRow(nav.current);
  }, [path]);
  return (
    <nav
      ref={nav}
      aria-label="Settings pages"
      className="sticky top-0 hidden h-dvh w-(--rail-width) shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-bg px-2 py-2 lg:flex"
    >
      <p className="px-2 pt-1 text-ui font-semibold text-ink">Settings</p>
      <SettingsPages me={me} />
    </nav>
  );
}

/** Below 1024px the first lane is a drawer: a modal dialog, so focus stays inside it and Escape closes it. Taking a link in it, or tapping beside it, closes it too. */
function Drawer({ me, onSearch }: { me: Me; onSearch: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  // Mounted at the first opening and kept, so what the reader folded stays folded.
  const [opened, setOpened] = useState(false);
  const href = useLocation({ select: (location) => location.href });
  useEffect(() => {
    setOpen(false);
  }, [href]);
  // Focus goes on the drawer itself: showModal alone puts it on the first link, with a ring as soon as the drawer opens. The next Tab reaches that link, with its ring.
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      dialog.current?.focus();
      showCurrentRow(dialog.current);
    } else dialog.current?.close();
  }, [open]);
  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg px-2 pt-(--safe-top) lg:hidden">
        <button
          type="button"
          aria-label="Open the menu"
          aria-expanded={open}
          className="grid size-(--tap) shrink-0 place-items-center rounded text-ink hover:bg-raised"
          onClick={() => {
            setOpened(true);
            setOpen(true);
          }}
        >
          <Menu size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <Link
          to="/"
          className="inline-flex min-w-0 flex-1 items-center gap-2 self-stretch text-ui font-semibold whitespace-nowrap text-ink"
        >
          <BrandIdentity size={16} />
        </Link>
        <button
          type="button"
          aria-label={SEARCH_LABEL}
          className="grid size-(--tap) shrink-0 place-items-center rounded text-ink hover:bg-raised"
          onClick={onSearch}
        >
          <Search size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>
      <dialog
        ref={dialog}
        aria-label="Menu"
        tabIndex={-1}
        className="m-0 h-dvh max-h-dvh w-screen max-w-none bg-scrim outline-none open:flex"
        onClose={() => {
          setOpen(false);
        }}
      >
        {/* A link to the page already open changes no address, and still closes the drawer. */}
        <div
          role="presentation"
          className="h-full w-[min(var(--tree-width-max),calc(100vw-3rem))] shrink-0 rounded-r-sheet bg-bg"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("a"))
              setOpen(false);
          }}
        >
          {opened && <FirstLane me={me} nested />}
        </div>
        <button
          type="button"
          aria-label="Close the menu"
          className="min-w-0 flex-1"
          onClick={() => {
            setOpen(false);
          }}
        />
      </dialog>
    </>
  );
}

/** Whether the window is wide enough for the lanes: from 1024px, where the first lane stops being a drawer. */
const lanesShown = () => matchMedia("(width >= 64rem)").matches;

/** The signed-in app: the first lane, the second while in the settings, and the page; flat, with a line between them. From 1024px the first lane can be dragged wider or narrower, and hidden with its button, `[` or a drag past its narrowest; this browser keeps both. */
export function AppFrame({
  me,
  band,
  children,
}: {
  me: Me;
  band: ReactNode;
  children: ReactNode;
}) {
  const secondLane = useLocation({
    select: (location) => inSettingsPage(location.pathname),
  });
  const [searching, setSearching] = useState(false);
  const onSearch = () => {
    setSearching(true);
  };
  const lane = useLaneSize(secondLane);
  const laneId = useId();
  const aside = useRef<HTMLElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  // Set as the lane hides or shows from a control that is about to vanish, so focus moves to the one that takes its place.
  const focusAfter = useRef<"show" | "hide" | null>(null);
  const toggle = () => {
    const focused = document.activeElement;
    if (lane.hidden) {
      if (focused === showButton.current) focusAfter.current = "hide";
    } else if (aside.current?.contains(focused) === true)
      focusAfter.current = "show";
    lane.toggle();
  };
  useEffect(() => {
    const target =
      focusAfter.current === "show" ? showButton.current : hideButton.current;
    if (focusAfter.current !== null) target?.focus();
    focusAfter.current = null;
  }, [lane.hidden]);
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      !isLaneShortcut(event) ||
      !lanesShown() ||
      document.querySelector("dialog[open]") !== null
    )
      return;
    event.preventDefault();
    toggle();
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      onKey(event);
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <div className="min-h-dvh bg-surface lg:flex">
      <Drawer me={me} onSearch={onSearch} />
      {/* Above the settings lane, which comes later in the page, so that lane never covers the edge's strip. */}
      <aside
        ref={aside}
        id={laneId}
        aria-label="Sidebar"
        style={{ width: lane.width }}
        className={`hidden shrink-0 border-r border-line bg-bg lg:sticky lg:top-0 lg:z-10 lg:h-dvh ${lane.hidden ? "" : "lg:block"}`}
      >
        <FirstLane
          me={me}
          onSearch={onSearch}
          hide={{ onClick: toggle, button: hideButton, controls: laneId }}
        />
        <LaneEdge
          lane={aside}
          controls={laneId}
          width={lane.width}
          chosen={lane.chosen}
          bounds={lane.bounds}
          onChange={lane.change}
        />
      </aside>
      <div className="min-w-0 flex-1 lg:flex">
        {secondLane && <SecondLane me={me} />}
        <div className="flex min-h-[calc(100dvh-var(--tap))] min-w-0 flex-1 flex-col lg:min-h-dvh">
          {lane.hidden && (
            // A strip of no height that sticks to the top, so the button stays at the page's corner as it scrolls, as Secoda's does.
            <div className="sticky top-0 z-10 hidden h-0 lg:block">
              <button
                ref={showButton}
                type="button"
                aria-label={SHOW_LABEL}
                aria-controls={laneId}
                aria-expanded={false}
                title={`${SHOW_LABEL} (${LANE_SHORTCUT})`}
                className={`${ICON_BUTTON} absolute top-2 left-2`}
                onClick={toggle}
              >
                <PanelLeftOpen {...ICON} />
              </button>
            </div>
          )}
          {band}
          <main className="mx-auto w-full max-w-(--page-max) flex-1 px-(--page-pad) py-8">
            {children}
          </main>
        </div>
      </div>
      <CatalogSearch
        open={searching}
        onOpen={onSearch}
        onClose={() => {
          setSearching(false);
        }}
      />
    </div>
  );
}
