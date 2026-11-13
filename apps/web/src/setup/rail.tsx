import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { grantsQuery } from "../access/api";
import type { SetupState } from "./api";
import {
  SCREENS,
  standing,
  STEP_COUNT,
  type ScreenId,
  type Standing,
} from "./screens";
import { LABEL } from "./parts";

const WORDS: Record<Standing, string> = {
  to_do: "To do",
  skipped: "Skipped",
  you: "Waiting for you",
  waiting: "Waiting for Microsoft",
  done: "Done",
  failed: "Failed",
};

function Marker({ state, number }: { state: Standing; number: number }) {
  const ring = "grid size-6 shrink-0 place-items-center rounded-full text-meta";
  if (state === "done")
    return (
      <span className={`${ring} bg-accent text-on-accent`}>
        <Check size={14} strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  if (state === "failed")
    return (
      <CircleAlert
        size={24}
        strokeWidth={1.75}
        aria-hidden="true"
        className="shrink-0 text-out"
      />
    );
  if (state === "waiting" || state === "you")
    return (
      <span className={`${ring} border border-line text-ink-3`}>
        {state === "waiting" ? (
          <Clock size={12} aria-hidden="true" />
        ) : (
          <UserRound size={12} aria-hidden="true" />
        )}
      </span>
    );
  return (
    <span
      className={`${ring} border border-line-control font-medium text-ink-2`}
    >
      {number}
    </span>
  );
}

/**
 * As Mixpanel's setup guide: the steps in order, each with its state in a
 * word beside its mark, the current one on the accent's wash and in bold. On
 * a phone, the step count opens the same list.
 */
export function Rail({
  setup,
  current,
}: {
  setup: SetupState;
  current: ScreenId;
}) {
  const [open, setOpen] = useState(false);
  const screens = SCREENS.filter((screen) => screen.id !== "done");
  const reached = SCREENS.findIndex((screen) => screen.id === current);
  const { data: connected } = useQuery({
    ...grantsQuery,
    enabled: setup.holder !== "setup_link",
  });
  const finished = setup.steps.some(
    (step) => step.id === "first_sync" && step.passed,
  );
  // Nothing records these two. A grant says an agent connected, and a person
  // has passed the agent by only from a screen after it: a sync that ends while
  // they are on Who gets in skips nothing.
  const stateOf = (id: ScreenId, index: number): Standing => {
    if (id === "agent" && connected !== undefined) {
      if (connected.grants.length > 0) return "done";
      if (index < reached) return "skipped";
    }
    if (id === "people" && id !== current && (finished || index < reached))
      return "done";
    return standing(setup, id);
  };
  const passed = screens.filter(
    (screen, index) => stateOf(screen.id, index) === "done",
  ).length;
  const list = (
    <ol className="flex flex-col gap-0.5">
      {screens.map((step, index) => {
        const here = step.id === current;
        const state = stateOf(step.id, index);
        return (
          <li key={step.id}>
            <Link
              to="/setup"
              search={{ step: step.id }}
              aria-current={here ? "step" : undefined}
              onClick={() => {
                setOpen(false);
              }}
              className={`flex items-center gap-3 rounded px-2.5 py-2 ${here ? "bg-accent-soft" : "hover:bg-raised"}`}
            >
              <Marker state={state} number={index + 1} />
              <span className="flex min-w-0 flex-col">
                <span
                  className={`text-ui ${here ? "font-semibold text-ink" : "text-ink-2"}`}
                >
                  {step.title}
                </span>
                <span
                  className={`text-meta ${state === "failed" ? "text-out" : "text-ink-3"}`}
                >
                  {state === "waiting" && step.id === "sync"
                    ? "Waiting for the worker"
                    : WORDS[state]}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
  const progress = `${String(passed)} of ${String(STEP_COUNT)} steps done`;
  return (
    <nav aria-label="Setup steps">
      <div className="hidden flex-col gap-4 xl:flex">
        <div className="flex flex-col gap-1 px-2.5">
          <p className={LABEL}>Setup</p>
          <p className="text-meta text-ink-3">{progress}</p>
        </div>
        {list}
      </div>
      <div className="rounded border border-line bg-surface xl:hidden">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left pointer-coarse:min-h-(--tap)"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-ui font-semibold text-ink">Setup steps</span>
            <span className="text-meta text-ink-3">{progress}</span>
          </span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`shrink-0 text-ink-3 ${open ? "rotate-180" : ""}`}
          />
        </button>
        {open && <div className="border-t border-line p-1.5">{list}</div>}
      </div>
    </nav>
  );
}
