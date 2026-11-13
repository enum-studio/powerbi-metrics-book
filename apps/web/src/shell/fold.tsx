import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

/** Something that folds: it opens when the reader comes to a page or address in it, and stays as they leave it until then. */
export function useFold(holdsPage: boolean) {
  const [open, setOpen] = useState(holdsPage);
  useEffect(() => {
    if (holdsPage) setOpen(true);
  }, [holdsPage]);
  return [open, setOpen] as const;
}

/** The arrow alone, for a row that folds as a whole and is itself the button. */
export function FoldMark({
  open,
  className = "",
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <span
      className={`grid size-5 shrink-0 place-items-center text-ink-3 pointer-coarse:size-(--tap) ${className}`}
    >
      <ChevronRight
        size={14}
        strokeWidth={1.5}
        aria-hidden="true"
        className={open ? "rotate-90" : ""}
      />
    </span>
  );
}

export function FoldArrow({
  open,
  label,
  className = "",
  onClick,
}: {
  open: boolean;
  label: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      className={`grid size-5 shrink-0 place-items-center rounded text-ink-3 hover:bg-line hover:text-ink pointer-coarse:size-(--tap) ${className}`}
      onClick={onClick}
    >
      <ChevronRight
        size={14}
        strokeWidth={1.5}
        aria-hidden="true"
        className={open ? "rotate-90" : ""}
      />
    </button>
  );
}
