import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Check, Circle, CircleAlert, Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, read } from "../api/client";
import { CopyValue } from "../shell/copy-button";
import type { SetupState, StepId } from "./api";
import { CONTROL, inputOf, SecretField, SettingField } from "./fields";
import { GuideColumn, PortalLink } from "./guide-column";
import { item, ITEMS, redirectValues, type ItemId } from "./items";
import { appPage } from "./links";
import { BUTTON, CHOSEN, LABEL, Note, Problem, QUIET } from "./parts";
import { checkedAddress, SCREENS, STEP_COUNT } from "./screens";
import { LIMITED_MS, useSetupStep } from "./step";

type Way = "have" | "make";
const MINUTE = 60_000;
/** The check behind each section: the scanner app's is only its credentials, and the group and the tenant settings share the full one. */
type CheckId = "app_registration" | "credentials" | "scanner";
const checkOf = (key: ItemId): CheckId =>
  key === "tenant" || key === "sign_in_app"
    ? "app_registration"
    : key === "scanner_app"
      ? "credentials"
      : "scanner";
const stepOf = (check: CheckId) =>
  check === "app_registration" ? check : "scanner";
/** Whose fields a check goes by: the scanner's are entered on the scanner app's section. */
const editedBy = (check: CheckId) =>
  check === "app_registration" ? check : "credentials";
export function Microsoft({ setup }: { setup: SetupState }) {
  const screen = SCREENS.find((screen) => screen.id === "microsoft");
  if (screen === undefined)
    throw new Error("The Microsoft setup screen is missing.");
  const step = (id: StepId) => {
    const found = setup.steps.find((step) => step.id === id);
    if (found === undefined) throw new Error(`The setup API omitted ${id}.`);
    return {
      setup,
      step: found,
      id,
      screen: screen.id,
      signedIn: false,
    };
  };
  const app = useSetupStep(step("app_registration"));
  const credentials = useSetupStep({ ...step("scanner"), credentials: true });
  const scanner = useSetupStep(step("scanner"));
  const controls = { app_registration: app, credentials, scanner };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const clientId = text(app.draft.settings["powerbi.app_client_id"]);
  const scannerId = text(
    credentials.draft.settings["powerbi.scanner_client_id"],
  );
  const tenantId = text(app.draft.settings["powerbi.tenant_id"]);
  const sameApp =
    clientId !== "" && clientId.toLowerCase() === scannerId.toLowerCase();
  const [choice, setChoice] = useState<Way | null>(clientId ? "have" : null);
  const [ways, setWays] = useState<Partial<Record<ItemId, Way>>>({});
  const [edited, setEdited] = useState({
    app_registration: false,
    credentials: false,
  });
  // The checks that ran: this session's, and those that failed before it. A stored failure
  // of a check that waits again says nothing yet, and "not run yet" is no failure at all.
  const [checked, setChecked] = useState(() => {
    const scannerStep = step("scanner").step;
    const appStep = step("app_registration").step;
    return {
      app_registration: appStep.check?.status === "failing",
      credentials:
        scannerStep.credentials?.pending === false &&
        scannerStep.credentials.check?.status === "failing",
      scanner: !scannerStep.pending && scannerStep.check?.status === "failing",
    };
  });
  const scanWorks =
    !edited.credentials && !sameApp && scanner.shown?.status === "passing";
  const details = scanner.shown?.details;
  const reason =
    !edited.credentials && details && "reason" in details
      ? details.reason
      : undefined;
  const done: Record<ItemId, boolean> = {
    tenant: /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(tenantId),
    sign_in_app:
      !edited.app_registration &&
      (app.shown?.status === "passing" ||
        app.shown?.action === "sign_in" ||
        app.shown?.action === "connect"),
    // Whoever passed the full check before the two were split has no credentials job.
    scanner_app:
      scanWorks ||
      (!edited.credentials &&
        !sameApp &&
        credentials.shown?.status === "passing"),
    scanner_group: scanWorks,
    tenant_settings: scanWorks,
  };
  const [open, setOpen] = useState<ItemId>(
    () => ITEMS.find((id) => !done[id]) ?? "tenant_settings",
  );
  // The check the person ran on the open section: once it passes, the next section opens.
  // Choosing a section by hand ends the wait, so a reopened one stays open, and so does
  // a check that comes back after the person left, even if they came back to its section.
  const [advancing, setAdvancing] = useState(false);
  const started = useRef<ItemId | null>(null);
  const choose = (key: ItemId) => {
    started.current = null;
    setAdvancing(false);
    setOpen(key);
  };
  const check = checkOf(open);
  const id = stepOf(check);
  const control = controls[check];
  const [email, setEmail] = useState("");
  const setting = (key: string) => (value: unknown) => {
    control.setDraft((before) => ({
      ...before,
      settings: { ...before.settings, [key]: value },
    }));
    setEdited((before) => ({ ...before, [editedBy(check)]: true }));
  };
  const lookup = useMutation({
    mutationFn: (email: string) =>
      read(api.POST("/api/setup/tenant", { body: { email } })),
    onSuccess: (found) => {
      app.setDraft((before) => ({
        ...before,
        settings: { ...before.settings, "powerbi.tenant_id": found.tenant_id },
      }));
      setEdited((before) => ({ ...before, app_registration: true }));
    },
  });
  const findTenant = () => {
    if (email === lookup.variables && !lookup.isError) return;
    lookup.mutate(email);
  };
  const [retry, setRetry] = useState<{ first: number; next: number } | null>(
    null,
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (reason === "tenant_settings")
      setRetry((before) => ({
        first: before?.first ?? Date.now(),
        next: Date.now() + MINUTE,
      }));
  }, [reason, scanner.run.data]);
  const waiting =
    retry !== null &&
    now - retry.first < 15 * MINUTE &&
    (reason === "tenant_settings" || scanner.underWay);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [waiting]);
  const { mutate } = scanner.run;
  useEffect(() => {
    if (
      !waiting ||
      scanner.underWay ||
      scanner.run.isPending ||
      (scanner.run.error && !scanner.limited)
    )
      return;
    const timer = setTimeout(
      () => {
        if (Date.now() - retry.first < 15 * MINUTE) {
          setChecked((before) => ({ ...before, scanner: true }));
          mutate({ start_check: true });
        }
      },
      scanner.limited ? LIMITED_MS : Math.max(0, retry.next - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [
    waiting,
    retry,
    scanner.underWay,
    scanner.run.isPending,
    scanner.run.error,
    scanner.limited,
    mutate,
  ]);
  const seconds = Math.max(0, Math.ceil(((retry?.next ?? now) - now) / 1000));
  const waitLine = `Waiting for Microsoft. A change in Power BI's tenant settings can take up to 15 minutes. Next try in ${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}; you can leave this page.`;
  const origin = checkedAddress(setup);
  const content = item(
    open,
    origin,
    open === "scanner_app" ? scannerId : clientId,
  );
  const way = ways[open] ?? choice ?? "have";
  const tenantLine =
    lookup.error?.message ??
    (lookup.data
      ? `Found: tenant ${lookup.data.tenant_id}, from ${lookup.data.domain}. Check it against Tenant ID on the Overview page in Entra.`
      : done.tenant
        ? "Tenant ID entered. Check it against Overview in Entra."
        : "Waiting for your work email");
  const live =
    open === "tenant"
      ? tenantLine
      : open === "tenant_settings" && waiting
        ? waitLine
        : done[open]
          ? {
              sign_in_app:
                "Checked: this app signs in, with this secret, in your tenant.",
              scanner_app:
                "Checked: the scanner signs in with its own registration.",
              scanner_group: "Checked: the scanner can access the admin APIs.",
              tenant_settings:
                scanner.shown?.message ??
                "Checked: the scanner read tables, measures and DAX.",
            }[open]
          : edited[editedBy(check)]
            ? "Waiting for you"
            : (control.shown?.message ?? "Waiting for you");
  /** A check that ran and failed: not one under way, one never run, or one whose fields have changed since. */
  const failed = (name: CheckId) =>
    checked[name] &&
    controls[name].shown?.status === "failing" &&
    !controls[name].underWay &&
    !controls[name].run.isPending &&
    !edited[editedBy(name)];
  const failing = open !== "tenant" && !done[open] && failed(check);
  const allDone = ITEMS.every((id) => done[id]);
  const next = ITEMS[ITEMS.indexOf(open) + 1];
  const busy = (
    check === "app_registration" ? [app] : [credentials, scanner]
  ).some(({ run, underWay }) => run.isPending || underWay);
  const passed = done[open];
  // A passing check speaks only to name what the sign-in app holds beyond the minimum.
  const appNote =
    open === "sign_in_app" &&
    !edited.app_registration &&
    app.shown?.status === "passing"
      ? app.shown.message
      : null;
  useEffect(() => {
    if (!advancing || !passed || busy) return;
    setAdvancing(false);
    if (next !== undefined) setOpen(next);
  }, [advancing, passed, busy, next]);
  const fields = step(id).step.fields.filter((field) =>
    field.kind === "setting" && field.key === "powerbi.tenant_id"
      ? open === "tenant"
      : open === "sign_in_app" || open === "scanner_app",
  );
  const body = (
    <div className="grid gap-4 p-4 pt-0">
      <p>Why: {content.why}</p>
      {content.never && <p>It can never: {content.never}</p>}
      {content.ways && (
        <Ways
          options={content.ways}
          selected={way}
          role="tab"
          onChange={(way) => {
            setWays({ ...ways, [open]: way });
          }}
        />
      )}
      <p>
        {open === "tenant"
          ? "Type your work email. We look up your tenant from its domain at Microsoft, and show what we found for you to confirm."
          : open === "scanner_group"
            ? "Nothing to enter: the stack does not need the group's ID. Checking the scanner, on the next item, proves the group works."
            : open === "tenant_settings"
              ? "When all three are on, check the scanner. It lists the workspaces it can see."
              : way === "have"
                ? "Paste the values from your existing app. The guide on the right links to the page where each one is shown."
                : "Make it with the guide on the right, then fill in the fields here."}
      </p>
      <form
        className="grid gap-4"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (open === "tenant") {
            findTenant();
            return;
          }
          const input =
            open === "tenant_settings"
              ? {}
              : {
                  ...inputOf(step(id).step.fields, control.draft),
                  settings: control.draft.settings,
                };
          setChecked((before) => ({ ...before, [check]: true }));
          const from = open;
          started.current = from;
          const replaced = check === "credentials" && edited.credentials;
          control.run.mutate(
            { ...input, ...(id === "scanner" ? { start_check: true } : {}) },
            {
              onSuccess: () => {
                if (check !== "scanner")
                  setEdited((before) => ({
                    ...before,
                    [editedBy(check)]: false,
                  }));
                // New credentials ended what the full check proved: ask where it stands now.
                if (replaced) {
                  setChecked((before) => ({ ...before, scanner: false }));
                  scanner.run.mutate({});
                }
                if (started.current === from) setAdvancing(true);
              },
            },
          );
        }}
      >
        {open === "tenant" && (
          <>
            <label className="grid gap-1.5">
              Your work email
              <input
                type="email"
                className={CONTROL}
                value={email}
                disabled={lookup.isPending}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    event.currentTarget.form?.requestSubmit();
                }}
                onBlur={(event) => {
                  if (email && event.currentTarget.validity.valid) findTenant();
                }}
              />
            </label>
            {lookup.error && <Problem>{lookup.error.message}</Problem>}
            {lookup.data && <p role="status">{tenantLine}</p>}
          </>
        )}
        {fields.map((field) =>
          field.kind === "setting" ? (
            <div key={field.key}>
              <SettingField
                field={field}
                value={control.draft.settings[field.key]}
                disabled={busy}
                onChange={setting(field.key)}
              />
              {open === "scanner_app" && sameApp && (
                <Problem>
                  These are the same app. The scanner needs its own
                  registration.
                </Problem>
              )}
            </div>
          ) : (
            <SecretField
              key={field.name}
              field={field}
              draft={control.draft.secrets[field.name]}
              disabled={busy}
              onChange={(value) => {
                control.setDraft((before) => ({
                  ...before,
                  secrets: { ...before.secrets, [field.name]: value },
                }));
                setEdited((before) => ({ ...before, [editedBy(check)]: true }));
              }}
            />
          ),
        )}
        {open !== "tenant" && open !== "scanner_group" && (
          <button
            type="submit"
            className={QUIET}
            disabled={busy || (open === "scanner_app" && sameApp)}
          >
            {busy
              ? "Checking..."
              : open === "sign_in_app"
                ? "Check the sign-in app"
                : open === "scanner_app"
                  ? "Check the scanner app"
                  : "Check the scanner"}
          </button>
        )}
        {failing && control.shown?.message != null && (
          <Problem>{control.shown.message}</Problem>
        )}
        {control.run.error && !control.limited && (
          <Problem>{control.run.error.message}</Problem>
        )}
        {open === "tenant_settings" && (
          <p className="text-meta">
            {waiting
              ? "Checking again each minute."
              : "Runs in the background; takes up to a minute."}
          </p>
        )}
        {open !== "tenant" && (!failing || live === waitLine) && (
          <p role="status">{live}</p>
        )}
        {appNote !== null && <Note>{appNote}</Note>}
        {done[open] && next && (
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              choose(next);
            }}
          >
            Next: {item(next, origin, clientId).name}
          </button>
        )}
      </form>
    </div>
  );
  return (
    <div className="grid gap-6 text-ui text-ink-2">
      <header className="grid gap-2">
        <p className={LABEL}>Step 2 of {STEP_COUNT}</p>
        <h1 className="text-title font-semibold text-ink">{screen.title}</h1>
        <p>
          Five things in Entra and Power BI. Open each one: if you already have
          it, paste its values; if not, the guide on the right walks you through
          making it, with a link to every page.
        </p>
      </header>
      {allDone && (
        <div role="status">
          <h2 className="font-semibold text-ink">Your tenant is connected</h2>
          <p>All five checked.</p>
        </div>
      )}
      <section className="grid gap-3" aria-label="Set up before">
        <h2 className="font-semibold text-ink">
          Have you set these up before, for this or another tool?
        </h2>
        <Ways
          options={{ have: "Yes, I have the apps", make: "No, starting fresh" }}
          selected={choice}
          role="radio"
          onChange={(way) => {
            setChoice(way);
            setWays({});
          }}
        />
        <p className="text-meta text-ink-3">
          This only picks where each item starts. Any item can switch on its
          own.
        </p>
      </section>
      <ul className="grid gap-y-2 lg:grid-cols-[minmax(0,1fr)_var(--assistant-width)] lg:grid-rows-[repeat(4,auto)_1fr] lg:items-start lg:gap-x-6">
        {ITEMS.map((key) => {
          const current = item(key, origin, clientId);
          const keyCheck = checkOf(key);
          const result = key === "tenant" ? null : controls[keyCheck];
          let state = "To do";
          if (result !== null && failed(keyCheck)) state = "Needs a fix";
          // A check that waits or runs has not failed, whatever it was before.
          if (result?.underWay || result?.run.isPending) state = "Checking";
          if (checked.scanner && waiting && key === "tenant_settings")
            state = "Waiting for Microsoft";
          if (done[key]) state = "Checked";
          const Mark =
            state === "Checked"
              ? Check
              : state === "Needs a fix"
                ? CircleAlert
                : state === "To do"
                  ? Circle
                  : Clock;
          return (
            <li key={key} className="lg:contents">
              <section className="rounded border border-line bg-surface lg:col-start-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 p-4 text-left"
                  aria-expanded={key === open}
                  onClick={() => {
                    choose(key);
                  }}
                >
                  <Mark size={18} aria-hidden="true" />
                  <span className="grid flex-1 gap-1">
                    <span className="font-semibold text-ink">
                      {current.name}
                    </span>
                    <span className="text-meta">
                      {current.summary(new URL(origin).host)}
                    </span>
                  </span>
                  <span className="text-meta">{state}</span>
                </button>
                {key === open && body}
              </section>
              {key === open && (
                <GuideColumn
                  item={content}
                  way={way}
                  docs={step(id).step.docs_path}
                  live={live}
                  complete={allDone}
                  clientId={clientId}
                />
              )}
            </li>
          );
        })}
      </ul>
      {allDone && (
        <section className="grid gap-3 rounded border border-line bg-surface p-4">
          <h2 className="font-semibold text-ink">
            One check before you sign in
          </h2>
          <p>
            The sign-in app must list both of these under Authentication. If one
            is missing, Microsoft shows AADSTS50011 on its own page; if the
            client ID is wrong, AADSTS500113. Either way, come back here.
          </p>
          {redirectValues(origin).map((value) => (
            <CopyValue key={value.label} {...value} />
          ))}
          <PortalLink
            href={appPage("Authentication", clientId)}
            label="Open the sign-in app's Authentication page in Entra"
          />
          <Link to="/setup" search={{ step: "sign-in" }} className={BUTTON}>
            Continue: sign in with Microsoft
          </Link>
        </section>
      )}
    </div>
  );
}

function Ways({
  options,
  selected,
  role,
  onChange,
}: {
  options: Record<Way, string>;
  selected: Way | null;
  role: "radio" | "tab";
  onChange: (way: Way) => void;
}) {
  return (
    <div
      role={role === "radio" ? "radiogroup" : "tablist"}
      aria-label="Choose how to set this up"
      className="flex flex-wrap gap-2"
    >
      {(["have", "make"] as const).map((way) => (
        <button
          key={way}
          type="button"
          role={role}
          aria-checked={role === "radio" ? selected === way : undefined}
          aria-selected={role === "tab" ? selected === way : undefined}
          className={selected === way ? CHOSEN : QUIET}
          onClick={() => {
            onChange(way);
          }}
        >
          {options[way]}
        </button>
      ))}
    </div>
  );
}
