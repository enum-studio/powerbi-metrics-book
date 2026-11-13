import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createRoute,
  Navigate,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { meQuery } from "../api/me";
import { openSetupSession, setupQuery } from "../setup/api";
import { AgentScreen } from "../setup/agent";
import { Microsoft } from "../setup/microsoft";
import { Done } from "../setup/done";
import { PeopleScreen } from "../setup/people";
import {
  capScreen,
  currentScreen,
  SCREENS,
  STEP_COUNT,
} from "../setup/screens";
import { isStepId } from "../setup/guide";
import { SetupLinkCommand } from "../setup/setup";
import { LINK } from "../setup/parts";
import { Rail } from "../setup/rail";
import { SignInScreen } from "../setup/sign-in-screen";
import { Sync } from "../setup/sync";
import { StepPanel } from "../setup/step";
import { EmptyState } from "../shell/states";
import { rootRoute } from "./root";

/**
 * The first run's guide, opened from the setup link (`/setup#token=...`)
 * before anyone can sign in, and by an admin afterwards. Which step shows
 * is in the address, so a reload or the back button keeps it.
 */
export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  staticData: { focused: true },
  path: "/setup",
  validateSearch: (
    search: Record<string, unknown>,
  ): { step?: string; link?: "spent" } => ({
    ...(typeof search.step === "string" ? { step: search.step } : {}),
    ...(search.link === "spent" ? { link: "spent" as const } : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const opening = openSetupSession();
    if (opening === null) return;
    const opened = await opening;
    // A session just opened changes what the setup API answers this browser.
    // Reset rather than removed: a screen already showing the old answer (the
    // link opened on /setup itself) keeps its observer, which then gets the new one.
    await context.queryClient.resetQueries({ queryKey: setupQuery.queryKey });
    redirect({
      to: "/setup",
      search: opened ? { step: search.step } : { link: "spent" },
      replace: true,
      throw: true,
    });
  },
  loader: ({ context }) => context.queryClient.query(setupQuery),
  component: SetupScreen,
});

function SetupScreen() {
  const { data: setup } = useSuspenseQuery(setupQuery);
  const { data: me } = useSuspenseQuery(meQuery);
  const { step: asked, link } = setupRoute.useSearch();
  if (setup === null) return <NoSetup spent={link === "spent"} />;
  const current =
    SCREENS.find((screen) => screen.id === asked)?.id ?? currentScreen(setup);
  const id =
    capScreen(setup, current) === current ? current : currentScreen(setup);
  if (
    id === "microsoft" &&
    !setup.steps.some((step) => step.id === "address" && step.passed)
  )
    return <Navigate to="/setup" search={{ step: "address" }} replace />;
  const screen = SCREENS.find((screen) => screen.id === id);
  if (screen === undefined) throw new Error(`Unknown setup screen ${id}`);
  if (asked !== id)
    return <Navigate to="/setup" search={{ step: id }} replace />;
  return (
    <div className="grid gap-8 xl:grid-cols-[var(--rail-width)_minmax(0,1fr)] [body:has(&)]:[--page-max:calc(var(--read-max)+var(--assistant-width))] [&_code]:w-0 [&_code]:overflow-x-auto [&_code]:break-normal [&_code]:whitespace-nowrap">
      <Rail setup={setup} current={id} />
      <div className="flex min-w-0 flex-col gap-8">
        {id === "address" && (
          <header className="flex flex-col gap-1">
            <h1 className="text-title font-semibold text-ink">
              {screen.title}
            </h1>
            <p className="text-meta text-ink-3">
              Step {SCREENS.indexOf(screen) + 1} of {STEP_COUNT}
            </p>
          </header>
        )}
        {id === "done" ? (
          <Done setup={setup} />
        ) : id === "people" ? (
          <PeopleScreen setup={setup} />
        ) : id === "agent" ? (
          <AgentScreen setup={setup} />
        ) : id === "microsoft" ? (
          <Microsoft setup={setup} />
        ) : id === "sign-in" ? (
          <SignInScreen setup={setup} signedIn={me !== null} />
        ) : id === "sync" ? (
          <Sync setup={setup} />
        ) : (
          screen.steps.map((stepId) => {
            const step = setup.steps.find((step) => step.id === stepId);
            if (step === undefined || !isStepId(step.id))
              throw new Error(`The setup API omitted ${stepId}.`);
            return (
              <StepPanel
                key={`${id}:${stepId}`}
                setup={setup}
                step={step}
                id={stepId}
                screen={id}
                signedIn={me !== null}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function NoSetup({ spent }: { spent: boolean }) {
  const router = useRouter();
  // A link pasted into this tab changes the fragment alone, which the router does not load.
  useEffect(() => {
    const load = () => {
      void router.invalidate();
    };
    window.addEventListener("hashchange", load);
    return () => {
      window.removeEventListener("hashchange", load);
    };
  }, [router]);
  return (
    <EmptyState
      title={
        spent ? "This setup link does not work" : "Open the setup from its link"
      }
    >
      <div className="flex flex-col gap-4">
        <p>
          {spent
            ? "A setup link works once, for 24 hours, and a newer one ends it. Print a new one on the server, then open it in this browser."
            : "The server does not log the link. Print one on the server, then open it in this browser:"}
        </p>
        <SetupLinkCommand />
        <p>
          Once an admin exists there is no link: the setup is in the admin
          section.{" "}
          <a className={LINK} href="/sign-in">
            Sign in
          </a>
        </p>
      </div>
    </EmptyState>
  );
}
