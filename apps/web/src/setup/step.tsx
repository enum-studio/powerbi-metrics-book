import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  type SetupState,
  type StepAnswer,
  type StepId,
  type StepInput,
  type StepState,
  follow,
  runStep,
} from "./api";
import { type Draft, draftOf } from "./fields";
import { GUIDES } from "./guide";
import { SCREENS, standing, type ScreenId } from "./screens";
import { CopyValue } from "../shell/copy-button";
import { BUTTON, LABEL, LINK, NeedHelp, Outcome } from "./parts";

const POLL_MS = 3000;
export const LIMITED_MS = 10_000;

export function useSetupStep({
  setup,
  step,
  id,
  signedIn,
  screen,
  credentials = false,
}: {
  setup: SetupState;
  step: StepState;
  id: StepId;
  signedIn: boolean;
  screen: ScreenId;
  /** The scanner step's second check: every request carries credentials_only, and step.credentials holds its result. */
  credentials?: boolean;
}) {
  const guide = GUIDES[id];
  const queryClient = useQueryClient();
  const index = SCREENS.findIndex((item) => item.id === screen);
  const next = SCREENS[index + 1];
  const waitsForAdmin =
    setup.holder === "setup_link" &&
    !SCREENS.slice(
      0,
      SCREENS.findIndex((screen) => screen.id === "sign-in"),
    )
      .flatMap((screen) => screen.steps)
      .includes(id);
  const [draft, setDraft] = useState<Draft>(() => draftOf(step.fields));
  const [answer, setAnswer] = useState<StepAnswer | null>(null);

  // Only the latest request's answer is shown: a look sent as the step
  // opens may come back after the check the button started.
  const latest = useRef(0);
  const run = useMutation({
    mutationFn: async (body: StepInput) => {
      latest.current += 1;
      const ticket = latest.current;
      const sent = credentials ? { ...body, credentials_only: true } : body;
      return { result: await runStep(id, sent as StepInput), ticket };
    },
    onSuccess: async ({ result, ticket }, body) => {
      if (ticket !== latest.current) return;
      setAnswer(result);
      // A secret is sent once, and its field empties: what is saved is never
      // shown again. A secret typed since, while a look was out, stays.
      const sent = Object.keys(body.secrets ?? {});
      if (sent.length > 0)
        setDraft((before) => ({
          ...before,
          secrets: Object.fromEntries(
            Object.entries(before.secrets).filter(
              ([name]) => !sent.includes(name),
            ),
          ),
        }));
      // A poll that is still pending changed nothing the rail shows; the
      // setup API counts every request against its rate limit.
      const poll = Object.keys(body).length === 0;
      if (!(poll && result.pending === true))
        await queryClient.invalidateQueries({ queryKey: ["setup"] });
      // Confirming made this person the first admin.
      if (body.confirm_email !== undefined)
        await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const leave = useMutation({ mutationFn: follow });

  // Past the setup API's rate limit, a poll waits longer and asks again rather than stopping.
  const limited =
    run.error instanceof ApiError && run.error.kind === "rate_limited";
  // Any other error ends the polling, so the check is no longer followed: its last pending answer says nothing now.
  const stopped = run.error !== null && !limited;
  const underWay = answer?.pending === true && !stopped;
  const { mutate, isPending } = run;
  // Polls send nothing. Buttons and opening screen 4 start checks; Start begins the sync.
  // A poll waits while a request is out: it would replace that request's callbacks.
  useEffect(() => {
    if (!underWay || isPending) return;
    const again = setTimeout(
      () => {
        mutate({});
      },
      limited ? LIMITED_MS : POLL_MS,
    );
    return () => {
      clearTimeout(again);
    };
  }, [underWay, isPending, answer, limited, mutate]);

  // Back from Microsoft's sign-in with the setup's session: ask whom to confirm as the first admin.
  // Opening screen 4 starts its workspace check; other worker steps read their current status.
  const returning =
    id === "app_registration" && setup.holder === "setup_link" && signedIn;
  // A stored result that leads nowhere may be out of date: a release has changed the rule,
  // or the daily run passed the check without marking the step. Asked once, as the screen opens.
  const [outdated] = useState(
    () =>
      id === "app_registration" &&
      !step.passed &&
      step.check !== null &&
      step.action === null,
  );
  const look =
    returning || outdated || (guide.starts !== undefined && !waitsForAdmin);
  useEffect(() => {
    if (look) mutate(id === "what_to_sync" ? { start_check: true } : {});
  }, [look, mutate, id]);

  const stored = credentials ? (step.credentials?.check ?? null) : step.check;
  const shown =
    (answer?.pending === true && stopped ? null : answer) ??
    (stored === null
      ? null
      : {
          ...stored,
          confirm: undefined,
          action: step.action ?? undefined,
          next: null,
        });
  return {
    draft,
    setDraft,
    shown,
    run,
    leave,
    underWay,
    limited,
    waitsForAdmin,
    guide,
    index,
    next,
  };
}

export function StepPanel(props: Parameters<typeof useSetupStep>[0]) {
  const { setup, step, screen } = props;
  const { shown, run, underWay, limited, guide, index, next } =
    useSetupStep(props);
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_13rem]">
      <section
        aria-label={`Step ${String(index + 1)}: ${step.title}`}
        className="flex min-w-0 flex-col gap-6"
      >
        <h2 className="text-heading font-semibold text-ink">{step.title}</h2>
        <div className="flex max-w-(--measure) flex-col gap-3 text-body text-ink-2">
          <p>{guide.why}</p>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5">
            {guide.todo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
        {guide.copy(window.location.origin).length > 0 && (
          <div className="flex flex-col gap-3">
            <h2 className={LABEL}>Values to copy</h2>
            {guide.copy(window.location.origin).map((value) => (
              <CopyValue key={value.value} {...value} />
            ))}
          </div>
        )}
        <form
          className="flex flex-col gap-6"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            run.mutate({});
          }}
        >
          <div>
            <button
              type="submit"
              className={BUTTON}
              disabled={run.isPending || underWay}
            >
              {guide.button}
            </button>
          </div>
        </form>
        {run.isPending && !underWay ? (
          <Outcome state="running" />
        ) : run.error !== null && !(limited && underWay) ? (
          <Outcome state="failing">
            <p>
              {run.error instanceof ApiError
                ? run.error.message
                : "The check stopped because of a fault in this page. Reload it and run the check again."}
            </p>
          </Outcome>
        ) : underWay ? (
          <Outcome state="running">
            <p>{shown?.message}</p>
            <p className="text-meta text-ink-3">
              This page checks again every few seconds.
            </p>
          </Outcome>
        ) : shown !== null ? (
          <Outcome state={shown.status === "passing" ? "passed" : "failing"}>
            {shown.message !== null && <p>{shown.message}</p>}
            {shown.status === "failing" && (
              <a className={LINK} href={step.docs_path}>
                What this means and what to change
              </a>
            )}
            {next !== undefined && standing(setup, screen) === "done" && (
              <Link to="/setup" search={{ step: next.id }} className={LINK}>
                {next.title}
              </Link>
            )}
          </Outcome>
        ) : null}
      </section>
      <NeedHelp docs={step.docs_path} failure={setup.failure_docs_path} />
    </div>
  );
}
