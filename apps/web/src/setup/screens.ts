import type { SetupState, StepId } from "./api";

export type ScreenId =
  "address" | "microsoft" | "sign-in" | "sync" | "people" | "agent" | "done";
export const SCREENS: readonly {
  id: ScreenId;
  title: string;
  steps: readonly StepId[];
}[] = [
  { id: "address", title: "Address", steps: ["address"] },
  {
    id: "microsoft",
    title: "Connect your Microsoft tenant",
    steps: ["app_registration", "scanner"],
  },
  { id: "sign-in", title: "Sign in", steps: ["app_registration"] },
  { id: "sync", title: "What to sync", steps: ["what_to_sync", "first_sync"] },
  { id: "people", title: "Who gets in", steps: [] },
  { id: "agent", title: "Connect your agent", steps: [] },
  { id: "done", title: "Done", steps: [] },
];
/** The screens the rail counts: every one but Done. */
export const STEP_COUNT = SCREENS.length - 1;
/** Asked while the first sync runs. Nothing waits on them, so a person may pass them by. */
const WHILE_IT_SYNCS: readonly ScreenId[] = ["people", "agent"];
export const isWhileItSyncs = (screen: ScreenId) =>
  WHILE_IT_SYNCS.includes(screen);
export type Standing =
  "to_do" | "skipped" | "you" | "waiting" | "done" | "failed";

/** The address the first screen checked: what agents and colleagues are given, whichever way this page was reached. */
export function checkedAddress(setup: SetupState): string {
  const details = setup.steps.find((step) => step.id === "address")?.check
    ?.details;
  if (!details || !("public_base_url" in details))
    throw new Error("The setup API omitted the checked public address.");
  return details.public_base_url;
}

export function standing(setup: SetupState, screen: ScreenId): Standing {
  const step = (id: StepId) => {
    const found = setup.steps.find((step) => step.id === id);
    if (found === undefined) throw new Error(`The setup API omitted ${id}.`);
    return found;
  };
  const failed = (step: SetupState["steps"][number]) =>
    step.check?.status === "failing";
  // A sync that ended with nobody watching passed all the same: Done's look records it.
  const syncPassed = () =>
    step("first_sync").passed ||
    (step("what_to_sync").passed &&
      step("first_sync").check?.status === "passing");
  if (screen === "done") return setup.completed_at !== null ? "done" : "to_do";
  if (isWhileItSyncs(screen))
    return step("first_sync").pending || syncPassed() ? "you" : "to_do";
  const address = step("address");
  if (screen === "address")
    return address.passed ? "done" : failed(address) ? "failed" : "you";
  const app = step("app_registration");
  const scanner = step("scanner");
  const appWorks =
    app.check?.status === "passing" || (failed(app) && app.action !== null);
  const microsoft: Standing =
    scanner.passed && appWorks
      ? "done"
      : scanner.pending || scanner.credentials?.pending === true
        ? "waiting"
        : failed(scanner) ||
            scanner.credentials?.check?.status === "failing" ||
            (failed(app) && !appWorks)
          ? "failed"
          : address.passed
            ? "you"
            : "to_do";
  if (screen === "microsoft") return microsoft;
  if (screen === "sign-in")
    return app.passed ? "done" : microsoft === "done" ? "you" : "to_do";
  const workspaces = step("what_to_sync");
  const sync = step("first_sync");
  return syncPassed()
    ? "done"
    : workspaces.pending || sync.pending
      ? "waiting"
      : failed(workspaces) || failed(sync)
        ? "failed"
        : app.passed
          ? "you"
          : "to_do";
}

/** Whether the first sync has been started: the setup API answers no check for one nobody started. The screens after What to sync follow it, so they wait for it. */
function syncStarted(setup: SetupState): boolean {
  return setup.steps.some(
    (step) =>
      step.id === "first_sync" &&
      (step.pending || step.passed || step.check !== null),
  );
}

export function currentScreen(setup: SetupState): ScreenId {
  const first =
    SCREENS.find(
      (screen) =>
        !isWhileItSyncs(screen.id) && standing(setup, screen.id) !== "done",
    )?.id ?? "done";
  const passed = (id: StepId) =>
    setup.steps.some((step) => step.id === id && step.passed);
  // A sync started some other way before anyone chose the workspaces stays on What to sync.
  const syncing =
    passed("what_to_sync") &&
    setup.steps.some((step) => step.id === "first_sync" && step.pending);
  return capScreen(setup, first === "sync" && syncing ? "people" : first);
}

/**
 * The furthest a person may go. Only an admin sets who gets in and what comes
 * after, so a setup link stops at signing in, and nothing past What to sync
 * opens before its Start.
 */
export function capScreen(setup: SetupState, current: ScreenId): ScreenId {
  const afterStart = current === "done" || isWhileItSyncs(current);
  if (setup.holder === "setup_link" && (current === "sync" || afterStart))
    return "sign-in";
  return afterStart && !syncStarted(setup) ? "sync" : current;
}
