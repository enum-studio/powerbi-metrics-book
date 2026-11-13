import { type RefObject, useEffect, useRef, useState } from "react";
import {
  clampWidth,
  draggedTo,
  keepLane,
  keyedTo,
  type LaneBounds,
  type LaneChoice,
  laneBounds,
  readLaneTokens,
  restoreLane,
} from "./lane-size";
import type { StorageHost } from "./storage";

const browserStorage: StorageHost = { storage: () => localStorage };

/**
 * The first lane's width and whether it is hidden, as this browser last had
 * them. The width shown is the one chosen, held inside what this window can
 * give: a narrower window narrows the lane without forgetting the choice.
 */
export function useLaneSize(secondLane: boolean) {
  const [tokens] = useState(() =>
    readLaneTokens(getComputedStyle(document.documentElement)),
  );
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const resized = () => {
      setViewport(window.innerWidth);
    };
    window.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("resize", resized);
    };
  }, []);
  const [choice, setChoice] = useState(() => restoreLane(browserStorage));
  const bounds = laneBounds(tokens, viewport, secondLane);
  /** Shows the choice; `keep` saves it, which a drag does only as it ends. */
  const change = (next: LaneChoice, keep: boolean) => {
    setChoice(next);
    if (keep) keepLane(browserStorage, next);
  };
  return {
    width: clampWidth(choice.width ?? tokens.width, bounds),
    /** The width chosen in this browser, which a narrow window may show narrower; null for the token's own. */
    chosen: choice.width,
    hidden: choice.hidden,
    bounds,
    change,
    /** Hides or shows the lane, keeping the width chosen rather than the one this window narrowed it to. */
    toggle: () => {
      change({ width: choice.width, hidden: !choice.hidden }, true);
    },
  };
}

/**
 * The lane's right edge, as Secoda's: a 12px strip over the line that a
 * pointer drags, and a window splitter a keyboard moves with the arrow keys,
 * Home and End. Let go under half the narrowest width and the lane hides,
 * keeping the width chosen. A press that does not move keeps everything as it
 * was, so a click on the edge never saves the width a narrow window shows.
 */
export function LaneEdge({
  lane,
  controls,
  width,
  chosen,
  bounds,
  onChange,
}: {
  lane: RefObject<HTMLElement | null>;
  controls: string;
  width: number;
  chosen: number | null;
  bounds: LaneBounds;
  onChange: (choice: LaneChoice, keep: boolean) => void;
}) {
  // The drag under way: where it started, the choice to go back to, and whether the pointer has moved.
  const drag = useRef<{
    x: number;
    chosen: number | null;
    moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointedWidth = (clientX: number) =>
    clientX - (lane.current?.getBoundingClientRect().left ?? 0);
  const stop = () => {
    drag.current = null;
    setDragging(false);
  };
  return (
    <hr
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      className="absolute inset-y-0 -right-1.5 z-10 m-0 h-full w-3 cursor-col-resize border-0 touch-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 hover:before:bg-line-strong focus-visible:before:bg-accent data-dragging:before:bg-accent"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // No text is selected as the pointer crosses the page.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, chosen, moved: false };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current === null || event.clientX === drag.current.x) return;
        drag.current.moved = true;
        const to = draggedTo(pointedWidth(event.clientX), bounds);
        onChange(
          { width: to.hidden ? bounds.min : to.width, hidden: false },
          false,
        );
      }}
      onPointerUp={(event) => {
        if (drag.current === null) return;
        if (drag.current.moved) {
          const to = draggedTo(pointedWidth(event.clientX), bounds);
          onChange(
            to.hidden
              ? { width: drag.current.chosen, hidden: true }
              : { width: to.width, hidden: false },
            true,
          );
        }
        stop();
      }}
      onPointerCancel={() => {
        if (drag.current === null) return;
        if (drag.current.moved)
          onChange({ width: drag.current.chosen, hidden: false }, false);
        stop();
      }}
      onKeyDown={(event) => {
        const to = keyedTo(event.key, width, bounds);
        if (to === null) return;
        event.preventDefault();
        onChange({ width: to, hidden: false }, true);
      }}
    />
  );
}
