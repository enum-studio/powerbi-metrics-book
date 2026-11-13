import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { runStep, setupQuery, type SetupState } from "./api";
import { MICROSOFT_LINKS } from "./links";
import { BUTTON, CHECKBOX, LABEL, LINK, Note } from "./parts";
import { STEP_COUNT } from "./screens";
import { useSetupStep } from "./step";

export function Sync({ setup }: { setup: SetupState }) {
  const step = setup.steps.find((step) => step.id === "what_to_sync");
  if (step === undefined)
    throw new Error("The setup API omitted what_to_sync.");
  const { shown, run, underWay } = useSetupStep({
    setup,
    step,
    id: "what_to_sync",
    screen: "sync",
    signedIn: true,
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [personal, setPersonal] = useState(() =>
    step.fields.some(
      (field) =>
        field.kind === "setting" &&
        field.key === "powerbi.sync.workspaces.personal" &&
        field.value === true,
    ),
  );
  const [excluded, setExcluded] = useState(new Set<string>());
  const details = shown?.details;
  if (shown?.status === "passing" && (!details || !("workspaces" in details)))
    throw new Error("The workspace check omitted its workspaces.");
  const workspaces =
    details && "workspaces" in details ? details.workspaces : [];
  const personalCount =
    details && "personal_count" in details ? details.personal_count : 0;
  const checked = (workspace: (typeof workspaces)[number]) =>
    !excluded.has(workspace.id) && (!workspace.personal || personal);
  const start = useMutation({
    mutationFn: async () => {
      await run.mutateAsync({
        settings: {
          "powerbi.sync.workspaces.include": "all",
          "powerbi.sync.workspaces.exclude": workspaces
            .filter(
              (workspace) =>
                (personal || !workspace.personal) && excluded.has(workspace.id),
            )
            .map(({ id }) => id),
          "powerbi.sync.workspaces.personal": personal,
        },
      });
      const result = await runStep("first_sync", { start_sync: true });
      if (result.status === "failing" && !result.pending)
        throw new Error(result.message ?? "The first sync did not start.");
      // The next screen opens only once the setup state says the sync started.
      await queryClient.invalidateQueries({ queryKey: setupQuery.queryKey });
      await navigate({ to: "/setup", search: { step: "people" } });
    },
  });
  const waiting = run.isPending || underWay;
  const error = start.error ?? run.error;
  // Signing in passes straight on to this screen, so what the check named is shown here.
  const appCheck = setup.steps.find(
    (step) => step.id === "app_registration",
  )?.check;
  const appNote = appCheck?.status === "passing" ? appCheck.message : null;
  const sync = setup.steps.find((step) => step.id === "first_sync");
  return (
    <section className="grid gap-4 text-ui text-ink-2">
      <p className={LABEL}>Step 4 of {STEP_COUNT}</p>
      <h1 className="text-title font-semibold text-ink">What to sync</h1>
      {appNote != null && (
        <Note>The sign-in app passed its check. {appNote}</Note>
      )}
      {waiting && !start.isPending ? (
        <p role="status">Waiting for the worker</p>
      ) : workspaces.length > 0 || personalCount > 0 ? (
        <>
          <p>
            The scanner can see these workspaces. Untick any you want left out.
          </p>
          <fieldset className="grid gap-3">
            <legend className="mb-3 font-semibold text-ink">Workspaces</legend>
            {workspaces.map((workspace) => (
              <label className="flex items-center gap-2" key={workspace.id}>
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={checked(workspace)}
                  disabled={
                    start.isPending || (workspace.personal && !personal)
                  }
                  onChange={(event) => {
                    const next = new Set(excluded);
                    if (event.target.checked) next.delete(workspace.id);
                    else next.add(workspace.id);
                    setExcluded(next);
                  }}
                />
                {workspace.name}
                {workspace.personal && (
                  <span className="text-meta text-ink-3"> Personal</span>
                )}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-1.5 border-t border-line pt-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className={CHECKBOX}
                aria-describedby={
                  !personal && personalCount > 0
                    ? "personal-workspaces-hint"
                    : undefined
                }
                checked={personal}
                disabled={start.isPending}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setPersonal(enabled);
                  run.mutate({
                    settings: { "powerbi.sync.workspaces.personal": enabled },
                    start_check: true,
                  });
                }}
              />
              Personal workspaces
            </label>
            {!personal && personalCount > 0 && (
              <p id="personal-workspaces-hint" className="text-meta text-ink-3">
                {details && "truncated" in details && details.truncated
                  ? "At least "
                  : ""}
                {personalCount} personal workspace
                {personalCount === 1 ? "" : "s"}, not synced
              </p>
            )}
          </div>
          {details && "truncated" in details && details.truncated && (
            <p>
              Showing the first 1,000 workspaces. Other workspaces remain
              included.
            </p>
          )}
          <p>The default schedule runs at the start of every hour.</p>
          <button
            type="button"
            className={BUTTON}
            disabled={start.isPending || !workspaces.some(checked)}
            onClick={() => {
              start.mutate();
            }}
          >
            Start
          </button>
        </>
      ) : null}
      {error && <p role="alert">{error.message}</p>}
      {!start.isPending &&
        sync?.pending === false &&
        sync.check?.status === "failing" && (
          <p role="alert">{sync.check.message}</p>
        )}
      {!waiting && shown?.status === "failing" && (
        <div role="status" className="grid gap-2">
          <p>{shown.message}</p>
          <a
            className={LINK}
            href={MICROSOFT_LINKS.powerBiTenantSettings.href}
            target="_blank"
            rel="noopener"
          >
            Open Tenant settings in Power BI
          </a>
        </div>
      )}
    </section>
  );
}
