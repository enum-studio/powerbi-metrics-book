import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { formatTime } from "../../shell/time";
import { ADMIN_KEY } from "../settings/api";
import { Button, TABLE_BOX, TABLE_HEAD, TABLE_HEADING } from "../layout/ui";

/** A moment in the viewer's local time, or the sentence for none. */
export const stamp = (iso: string | null, none = "Never") =>
  iso === null ? none : formatTime(iso);

const STACKED =
  "max-sm:block max-sm:min-w-0 max-sm:[&_thead]:sr-only max-sm:[&_tbody]:block max-sm:[&_tr]:block max-sm:[&_tr]:py-3 max-sm:[&_td]:block max-sm:[&_td]:before:mr-3 max-sm:[&_td]:before:text-ink-3 max-sm:[&_td]:before:content-[attr(data-label)]";

/**
 * A table in a box. It keeps `min` as its least width, so on a phone the
 * whole table scrolls sideways as one unit instead of squeezing its columns;
 * with `stack` it shows one card per row there instead, each cell labelled
 * by its `data-label`.
 */
export function DataTable({
  label,
  head,
  min,
  stack = false,
  children,
}: {
  label: string;
  head: readonly string[];
  /** A Tailwind min-width class, written out whole so the build finds it. */
  min: string;
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={TABLE_BOX}>
      <table
        aria-label={label}
        className={`w-full text-left text-ui ${min} ${stack ? STACKED : ""}`}
      >
        <thead className={TABLE_HEAD}>
          <tr>
            {head.map((name) => (
              <th key={name} scope="col" className={TABLE_HEADING}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export const CELL = "px-3 py-2 align-top text-ink-2";

/**
 * Runs a write, then refetches everything under the admin's key so every
 * table agrees. The api's refusal becomes the sentence in `problem`; any
 * other failure is a fault in the page and is thrown.
 */
export function useGuarded() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function run(work: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setProblem(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, problem, run };
}

export function Problem({ sentence }: { sentence: string | null }) {
  if (sentence === null) return null;
  return (
    <p role="alert" className="text-ui text-out">
      {sentence}
    </p>
  );
}

/** A destructive action asks once, in the page, with what it will take with it. */
export function ConfirmButton({
  label,
  question,
  confirm,
  disabled,
  onConfirm,
}: {
  label: string;
  question: string;
  confirm: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button
        disabled={disabled}
        onClick={() => {
          setAsking(true);
        }}
      >
        {label}
      </Button>
    );
  return (
    <span className="flex flex-col items-start gap-2">
      <span className="max-w-(--measure) text-ui text-ink">{question}</span>
      <span className="flex gap-2">
        <Button
          primary
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirm}
        </Button>
        <Button
          onClick={() => {
            setAsking(false);
          }}
        >
          Keep it
        </Button>
      </span>
    </span>
  );
}

export function AccessDialog({
  title,
  close,
  children,
  side = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  side?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={close}
      onClose={close}
      className={`fixed max-h-full w-full max-w-(--measure) overflow-y-auto rounded border border-line bg-surface p-6 text-ink ${side ? "inset-y-0 right-0 left-auto m-0" : "m-auto"}`}
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-ui font-semibold">{title}</h2>
        <Button onClick={close}>Close</Button>
      </div>
      {children}
    </dialog>
  );
}
