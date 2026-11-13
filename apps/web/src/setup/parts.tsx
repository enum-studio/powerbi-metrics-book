import { Check, CircleAlert, LoaderCircle, UserRound } from "lucide-react";
import type { ReactNode } from "react";

export const BUTTON =
  "inline-flex w-fit items-center justify-center gap-2 rounded bg-accent px-3.5 py-2 text-ui font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60 pointer-coarse:min-h-(--tap)";
export const CHECKBOX = "size-4 accent-accent pointer-coarse:size-6";
const OUTLINED =
  "inline-flex items-center justify-center gap-2 rounded border border-line-control px-3.5 py-2 text-ui pointer-coarse:min-h-(--tap)";
export const QUIET = `${OUTLINED} bg-surface text-ink hover:bg-raised`;
/** QUIET's shape in the admin section's selected look: the choice a person made among quiet buttons. */
export const CHOSEN = `${OUTLINED} bg-accent font-semibold text-on-accent`;
export const LINK =
  "text-accent underline underline-offset-4 hover:text-accent-hover";
export const LABEL =
  "font-mono text-label font-medium tracking-[0.13em] text-ink-3 uppercase";

/** The result under a step's button: a check that runs, passed, the check's sentence, or a question for the person. */
export function Outcome({
  state,
  children,
}: {
  state: "running" | "passed" | "failing" | "ask";
  children?: ReactNode;
}) {
  const { Icon, headline, tone } = {
    running: {
      Icon: LoaderCircle,
      headline: "Checking",
      tone: "animate-spin text-ink-3",
    },
    passed: { Icon: Check, headline: "Passed", tone: "text-accent" },
    failing: {
      Icon: CircleAlert,
      headline: "The check did not pass",
      tone: "text-out",
    },
    ask: {
      Icon: UserRound,
      headline: "Confirm the first admin",
      tone: "text-accent",
    },
  }[state];
  return (
    <div
      role="status"
      className="flex gap-3 rounded border border-line bg-surface p-4"
    >
      <Icon
        size={18}
        aria-hidden="true"
        className={`mt-0.5 shrink-0 ${tone}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-ui text-ink-2">
        <p
          className={`font-semibold ${state === "failing" ? "text-out" : "text-ink"}`}
        >
          {headline}
        </p>
        {children}
      </div>
    </div>
  );
}

/** What went wrong, where the person is looking: the one colour kept for it, on the surface its contrast is measured against. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded border border-out bg-raised p-3 text-ui font-medium text-out"
    >
      <CircleAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}

/** What a passing check found that asks nothing of the person: quiet information, never the error box. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="text-meta text-ink-3">
      {children}
    </p>
  );
}

/** Beside the form, as Retool's help panel: the step's guide and the page of every check's fixes, both as the API names them. */
export function NeedHelp({ docs, failure }: { docs: string; failure: string }) {
  return (
    <aside
      aria-labelledby="need-help"
      className="flex flex-col gap-3 border-t border-line pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
    >
      <h2 id="need-help" className="text-ui font-semibold text-ink">
        Need help?
      </h2>
      <ul className="flex flex-col gap-2 text-ui">
        <li>
          <a className={LINK} href={docs}>
            This step in the setup guide
          </a>
        </li>
        <li>
          <a className={LINK} href={failure}>
            When a check fails
          </a>
        </li>
      </ul>
      <p className="text-meta text-ink-3">
        The guide follows these steps in the same words, with every click in
        Entra and Power BI.
      </p>
    </aside>
  );
}
