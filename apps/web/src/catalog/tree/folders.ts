/** A display folder of a table's measures, with the folders and measures inside it. */
export type Folder<T> = {
  name: string;
  /** The folders from the table down to this one, joined with a backslash as Power BI writes them. */
  path: string;
  folders: Folder<T>[];
  items: T[];
  /** The measures in this folder and every folder below it, each once. */
  count: number;
};

/** The folder tree of a table's measures: their display folders, and the measures in no folder, which come after them. */
export type FolderTree<T> = { folders: Folder<T>[]; loose: T[] };

export const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });

/**
 * The folders a display folder names. Power BI nests folders with a
 * backslash and puts a measure in more than one folder with a semicolon, so
 * `Sales\Margin;KPIs` is the folder Margin inside Sales, and KPIs.
 */
export function folderPaths(displayFolder: string | null): string[][] {
  if (displayFolder === null) return [];
  return displayFolder
    .split(";")
    .map((one) =>
      one
        .split("\\")
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    )
    .filter((parts) => parts.length > 0);
}

/** Groups a table's measures by display folder, folders and measures A to Z at every level. */
export function folderTree<T extends { name: string; folder: string | null }>(
  measures: readonly T[],
): FolderTree<T> {
  type Building = {
    name: string;
    path: string;
    folders: Map<string, Building>;
    items: T[];
    members: Set<T>;
  };
  const root: Building = {
    name: "",
    path: "",
    folders: new Map(),
    items: [],
    members: new Set(),
  };
  const loose: T[] = [];
  for (const measure of measures) {
    const paths = folderPaths(measure.folder);
    if (paths.length === 0) loose.push(measure);
    for (const parts of paths) {
      let at = root;
      for (const part of parts) {
        let next = at.folders.get(part);
        if (next === undefined) {
          next = {
            name: part,
            path: at.path === "" ? part : `${at.path}\\${part}`,
            folders: new Map(),
            items: [],
            members: new Set(),
          };
          at.folders.set(part, next);
        }
        next.members.add(measure);
        at = next;
      }
      if (!at.items.includes(measure)) at.items.push(measure);
    }
  }
  const finish = (folder: Building): Folder<T> => ({
    name: folder.name,
    path: folder.path,
    folders: [...folder.folders.values()].map(finish).sort(byName),
    items: [...folder.items].sort(byName),
    count: folder.members.size,
  });
  return {
    folders: [...root.folders.values()].map(finish).sort(byName),
    loose: [...loose].sort(byName),
  };
}

/** The folders from the top down to a path, so each can be opened on the way to it. */
export function folderTrail(path: string): string[] {
  const parts = path.split("\\");
  return parts.map((_, index) => parts.slice(0, index + 1).join("\\"));
}

/** The folder page's one path segment: the levels joined with a backslash. The router escapes it, so a slash in a level stays inside the segment. */
export function folderParam(levels: readonly string[]): string {
  return levels.join("\\");
}

export function folderLevels(param: string): string[] {
  // Power BI never names a level empty, so a stray or trailing separator is not one.
  return param.split("\\").filter((level) => level !== "");
}

/**
 * Whether a name in an address is `.` or `..`. A browser resolves such a
 * segment as a step up, so a link holding one could land on another page of
 * the app; build no link for it and show the name as text.
 */
export function hasDotName(...names: readonly string[]): boolean {
  return names.some((name) => name === "." || name === "..");
}
