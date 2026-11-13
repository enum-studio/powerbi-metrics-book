import { useEffect, useState } from "react";

/** The rows a person opened and closed by hand, by key. */
export type Handled = { opened: readonly string[]; closed: readonly string[] };

export const NOTHING_HANDLED: Handled = { opened: [], closed: [] };

/** The open rows: those on the way to the page on screen, unless closed by hand, and those opened by hand. */
export function openRows(
  trail: readonly string[],
  handled: Handled,
): Set<string> {
  return new Set([
    ...trail.filter((row) => !handled.closed.includes(row)),
    ...handled.opened,
  ]);
}

/** A row opened or closed by hand, which holds as the person moves around. */
export function toggleRow(
  row: string,
  open: ReadonlySet<string>,
  handled: Handled,
): Handled {
  const without = (rows: readonly string[]) => rows.filter((r) => r !== row);
  return open.has(row)
    ? {
        opened: without(handled.opened),
        closed: [...without(handled.closed), row],
      }
    : {
        opened: [...without(handled.opened), row],
        closed: without(handled.closed),
      };
}

/** Coming to a page opens the way to it again, even through a row closed by hand. */
export function reopenTrail(
  trail: readonly string[],
  handled: Handled,
): Handled {
  return {
    ...handled,
    closed: handled.closed.filter((row) => !trail.includes(row)),
  };
}

const SEPARATOR = "\u0000";

/**
 * Which rows of a tree are open. `page` changes with every page, so the way
 * to it opens again; until `ready`, while the trail is still loading, rows
 * closed by hand stay closed.
 */
export function useOpenRows(
  trail: readonly string[],
  page: string,
  ready = true,
) {
  const [handled, setHandled] = useState<Handled>(NOTHING_HANDLED);
  const trailKey = trail.join(SEPARATOR);
  useEffect(() => {
    if (!ready) return;
    setHandled((now) => reopenTrail(trailKey.split(SEPARATOR), now));
  }, [page, trailKey, ready]);
  const open = openRows(trail, handled);
  return {
    open,
    toggle: (row: string) => {
      setHandled((now) => toggleRow(row, openRows(trail, now), now));
    },
  };
}
