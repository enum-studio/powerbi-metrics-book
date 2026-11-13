import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { SetupState } from "./api";
import { useSetupStep } from "./step";

const WORKER_SLOW_MS = 120_000;

/** Where the first sync stands, asked again until it ends, for whichever screen the person is on. */
export function useFirstSync(setup: SetupState) {
  const step = setup.steps.find((step) => step.id === "first_sync");
  if (step === undefined) throw new Error("The setup API omitted first_sync.");
  const { shown, run, underWay } = useSetupStep({
    setup,
    step,
    id: "first_sync",
    screen: "done",
    signedIn: true,
  });
  const queued =
    (underWay || step.pending) &&
    shown?.message?.startsWith("The first sync waits for the worker") === true;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (!queued) return;
    const timer = setTimeout(() => {
      setWaited(true);
    }, WORKER_SLOW_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [queued]);
  const sentence = queued
    ? `Waiting for the worker to start the first sync.${waited ? " Check that the worker container is running." : ""}`
    : (shown?.message ?? "Waiting for the worker");
  const state: "done" | "failed" | "running" =
    shown?.status === "passing"
      ? "done"
      : shown?.status === "failing" && !underWay && !step.pending
        ? "failed"
        : "running";
  return { state, sentence, error: run.error };
}

/** One sync's word beside its mark: the same mark on every screen that follows it. */
export function SyncMark({ state }: { state: "done" | "failed" | "running" }) {
  if (state === "done")
    return (
      <Check
        size={16}
        strokeWidth={2.5}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-accent"
      />
    );
  if (state === "failed")
    return (
      <CircleAlert
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-out"
      />
    );
  return (
    <LoaderCircle
      size={16}
      aria-hidden="true"
      className="mt-0.5 shrink-0 animate-spin text-ink-3"
    />
  );
}

/** The sync goes on behind the screens that follow Start, so each says how far it has come. */
export function FirstSyncLine({ setup }: { setup: SetupState }) {
  const { state, sentence, error } = useFirstSync(setup);
  return (
    <p
      role="status"
      className={`flex gap-2 text-ui ${state === "failed" ? "text-out" : "text-ink-2"}`}
    >
      <SyncMark state={state} />
      <span>{error?.message ?? sentence}</span>
    </p>
  );
}
