import { Navigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import type { SetupState, StepInput } from "./api";
import { BUTTON, LABEL, Outcome } from "./parts";
import { STEP_COUNT } from "./screens";
import { useSetupStep } from "./step";

const CONNECT_PENDING = "pbmb.setup.powerbi_connect_pending";
function connectionPending(consume = false): boolean {
  try {
    if (!consume) {
      sessionStorage.setItem(CONNECT_PENDING, "1");
      return true;
    }
    const pending = sessionStorage.getItem(CONNECT_PENDING) === "1";
    sessionStorage.removeItem(CONNECT_PENDING);
    return pending;
  } catch {
    return false;
  }
}

export function SignInScreen({
  setup,
  signedIn,
}: {
  setup: SetupState;
  signedIn: boolean;
}) {
  const step = setup.steps.find((step) => step.id === "app_registration");
  if (step === undefined)
    throw new Error("The setup API omitted app_registration.");
  const { shown, run, leave } = useSetupStep({
    setup,
    step,
    id: "app_registration",
    screen: "sign-in",
    signedIn,
  });
  const attempted = useRef(false);
  const connect = step.action === "connect" || shown?.action === "connect";
  const { mutate } = run;
  const { mutate: follow } = leave;
  const begin = useCallback(
    (body: StepInput = {}, automatic = false) => {
      attempted.current = true;
      if (!automatic && (!connect || body.confirm_email !== undefined))
        connectionPending();
      mutate(body, {
        onSuccess: ({ result }) => {
          const allowed = !automatic || connectionPending(true);
          if (result.next !== null && allowed) {
            if (body.confirm_email !== undefined && !connectionPending(true))
              return;
            follow(result.next);
          }
        },
      });
    },
    [connect, mutate, follow],
  );
  // Only this tab's sign-in or confirmation can continue automatically.
  useEffect(() => {
    if (connect && !attempted.current) begin({}, true);
  }, [connect, begin]);
  if (step.passed || shown?.status === "passing")
    return <Navigate to="/setup" search={{ step: "sync" }} replace />;
  const error = run.error ?? leave.error;
  const confirm = shown?.confirm;
  return (
    <section className="grid gap-4 text-ui text-ink-2">
      <p className={LABEL}>Step 3 of {STEP_COUNT}</p>
      <h1 className="text-title font-semibold text-ink">
        Sign in with Microsoft
      </h1>
      <p>
        You become the first admin. Your own Power BI connects in the same go.
      </p>
      {confirm ? (
        <Outcome state="ask">
          <p>
            Signed in as {confirm.name}, {confirm.email}. Confirm to make this
            person the first admin. The setup link then ends, and the setup goes
            on in this browser.
          </p>
          <button
            type="button"
            className={BUTTON}
            disabled={run.isPending || leave.isPending}
            onClick={() => {
              begin({ confirm_email: confirm.email });
            }}
          >
            Make me the admin
          </button>
        </Outcome>
      ) : (
        <button
          type="button"
          className={BUTTON}
          disabled={run.isPending || leave.isPending}
          onClick={() => {
            begin();
          }}
        >
          {connect ? "Connect Power BI" : "Sign in with Microsoft"}
        </button>
      )}
      {error && <p role="alert">{error.message}</p>}
      {!error &&
        shown?.status === "failing" &&
        shown.action !== "sign_in" &&
        !confirm && <p role="status">{shown.message}</p>}
    </section>
  );
}
