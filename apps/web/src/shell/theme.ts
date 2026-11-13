import { type StorageHost, unlessRefused } from "./storage";

export type Theme = "light" | "dark";

/**
 * What the theme reads and changes. With no data-theme on the root, the
 * tokens follow the system's setting; the toggle sets one.
 */
export type ThemeHost = StorageHost & {
  root: Pick<Element, "getAttribute" | "setAttribute">;
  prefersDark: () => boolean;
};

export function browserThemeHost(): ThemeHost {
  return {
    root: document.documentElement,
    prefersDark: () => matchMedia("(prefers-color-scheme: dark)").matches,
    storage: () => localStorage,
  };
}

const keyFor = (personId: string) => `pbmb.theme.${personId}`;
const isTheme = (value: string | null): value is Theme =>
  value === "light" || value === "dark";

/** Sets the person's saved choice, if they made one; otherwise the system's setting holds. */
export function restoreTheme(host: ThemeHost, personId: string): void {
  const saved = unlessRefused(() => host.storage().getItem(keyFor(personId)));
  if (isTheme(saved)) host.root.setAttribute("data-theme", saved);
}

export function shownTheme(host: ThemeHost): Theme {
  const set = host.root.getAttribute("data-theme");
  if (isTheme(set)) return set;
  return host.prefersDark() ? "dark" : "light";
}

/** Shows the other theme and keeps it as the person's choice; someone not signed in keeps it for this page only. */
export function toggleTheme(host: ThemeHost, personId: string | null): Theme {
  const next = shownTheme(host) === "dark" ? "light" : "dark";
  host.root.setAttribute("data-theme", next);
  if (personId !== null)
    unlessRefused(() => {
      host.storage().setItem(keyFor(personId), next);
    });
  return next;
}
