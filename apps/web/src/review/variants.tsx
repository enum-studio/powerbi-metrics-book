import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef } from "react";
import { Network } from "lucide-react";
import { FoldMark, useFold } from "../shell/fold";
import { CodePanel } from "./code-panel";
import { formatShift, humanize } from "./format";
import { type VariantAnchor, variantQuery } from "./queries";

/**
 * Each live measure, folded to its name, dataset and shift; opening one loads
 * its DAX. The variant in the address opens by itself.
 */
export function Variants({
  variants,
  currentVariant,
}: {
  variants: VariantAnchor[];
  currentVariant?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>("[data-current-variant]")
      ?.scrollIntoView({ block: "center" });
  }, [currentVariant, variants]);
  if (variants.length === 0)
    return (
      <p className="text-ui text-ink-3">
        No measure is filed under this metric yet, or none that you may see.
      </p>
    );
  return (
    <ul ref={list} className="flex flex-col divide-y divide-line">
      {variants.map((variant) => (
        <li
          key={variant.id}
          data-current-variant={
            variant.id === currentVariant ? variant.id : undefined
          }
          className={
            variant.id === currentVariant
              ? "-mx-3 rounded bg-accent-soft px-3 py-3"
              : "py-3 first:pt-0 last:pb-0"
          }
        >
          <VariantCard
            variant={variant}
            current={variant.id === currentVariant}
          />
        </li>
      ))}
    </ul>
  );
}

function VariantCard({
  variant,
  current,
}: {
  variant: VariantAnchor;
  current: boolean;
}) {
  const [open, setOpen] = useFold(current);
  const body = useId();
  const shift = variant.shift;
  const details = [
    formatShift(shift),
    shift.shift_note,
    ...Object.entries(shift.custom_axes).map(
      ([key, value]) =>
        `${humanize(key)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
  ].filter((value): value is string => value !== null && value !== "");
  return (
    <article
      aria-label={`Variant ${variant.measure_reference} in ${variant.dataset.name}`}
      className="flex flex-col gap-3"
    >
      <header className="flex flex-col gap-0.5">
        <h3>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? body : undefined}
            onClick={() => {
              setOpen(!open);
            }}
            className="-ml-1 flex w-full items-start gap-1 rounded pr-1 text-left hover:bg-raised"
          >
            <FoldMark open={open} />
            <span className="min-w-0 py-px font-mono text-ui font-medium break-words text-ink">
              {variant.measure_reference}
            </span>
          </button>
        </h3>
        <p className="pl-5 text-meta text-ink-3 pointer-coarse:pl-(--tap)">
          <Link
            to="/catalog/datasets/$id"
            params={{ id: variant.dataset.id }}
            search={{ tab: "diagram", table: undefined }}
            className="text-ink-2 underline underline-offset-4 hover:text-accent"
          >
            {variant.dataset.name}
          </Link>
          {details.length > 0 && ` · ${details.join(" · ")}`}
        </p>
      </header>
      {open && (
        <div id={body} className="flex flex-col gap-3">
          <VariantDetails variant={variant} />
        </div>
      )}
    </article>
  );
}

function VariantDetails({ variant }: { variant: VariantAnchor }) {
  const { data, error, isPending } = useQuery(variantQuery(variant.id));
  if (isPending) return <p className="text-ui text-ink-3">Loading the DAX</p>;
  if (error !== null)
    return (
      <p role="alert" className="text-ui text-ink-2">
        The DAX could not be loaded: {error.message}
      </p>
    );
  return (
    <>
      {data.expression === null ? (
        <p className="text-ui text-ink-2">
          Power BI does not let you read this measure's DAX. Ask a workspace
          Member or Admin for access to see it.
        </p>
      ) : (
        <CodePanel heading="DAX" label="DAX" code={data.expression} />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/catalog/datasets/$id"
          params={{ id: variant.dataset.id }}
          search={{ tab: "diagram", table: data.table.name }}
          className="inline-flex items-center gap-1.5 text-meta text-ink-2 underline underline-offset-4 hover:text-accent"
        >
          <Network size={13} aria-hidden="true" />
          Show {data.table.name} in the diagram
        </Link>
      </div>
    </>
  );
}
