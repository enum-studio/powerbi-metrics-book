import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Circle } from "lucide-react";
import type { ReactNode } from "react";
import { useConnectedAgents } from "../access/connect-agent";
import { settingQuery } from "../admin/settings/api";
import { ClientName } from "../shell/client-name";
import type { SetupState } from "./api";
import { SyncMark, useFirstSync } from "./first-sync";
import { BUTTON, LINK } from "./parts";

function Row({
  mark,
  title,
  children,
}: {
  mark: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-t border-line py-3 first:border-t-0">
      {mark}
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-ui font-semibold text-ink">{title}</h2>
        <div className="text-ui text-ink-2">{children}</div>
      </div>
    </li>
  );
}

const HEADINGS = {
  done: "The setup is done",
  running: "The first sync is running",
  failed: "The first sync failed",
};

/** As Cursor's "Finish setting up": what is in place, in a word each, and one button into the app. */
export function Done({ setup }: { setup: SetupState }) {
  const { state, sentence, error } = useFirstSync(setup);
  const { data: role } = useSuspenseQuery(settingQuery("access.default_role"));
  const agents = useConnectedAgents();
  if (
    role.value !== "none" &&
    role.value !== "viewer" &&
    role.value !== "curator"
  )
    throw new Error("The API returned an unknown default role.");
  return (
    <section
      aria-labelledby="setup-done"
      className="flex max-w-(--measure) flex-col gap-4"
    >
      <h1 id="setup-done" className="text-title font-semibold text-ink">
        {HEADINGS[state]}
      </h1>
      <ul className="flex flex-col">
        <Row mark={<SyncMark state={state} />} title="First sync">
          <span role="status">{sentence}</span>
        </Row>
        <Row mark={<SyncMark state="done" />} title="Who gets in">
          {role.value === "none"
            ? "Only the people you gave a role."
            : `Everyone in your tenant, as a ${role.value}.`}{" "}
          <Link to="/setup" search={{ step: "people" }} className={LINK}>
            Change
          </Link>
        </Row>
        <Row
          mark={
            agents.length > 0 ? (
              <SyncMark state="done" />
            ) : (
              <Circle
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-ink-3"
              />
            )
          }
          title="Your agent"
        >
          {agents.length > 0 ? (
            agents.map((agent) => (
              <p key={agent.id}>
                Connected: <ClientName client={agent} />
              </p>
            ))
          ) : (
            <>
              Not connected yet.{" "}
              <Link to="/setup" search={{ step: "agent" }} className={LINK}>
                Connect it
              </Link>
            </>
          )}
        </Row>
      </ul>
      {error !== null && <p role="alert">{error.message}</p>}
      {state === "failed" ? (
        <Link to="/setup" search={{ step: "sync" }} className={BUTTON}>
          Back to What to sync
        </Link>
      ) : state === "done" ? (
        <a className={BUTTON} href="/">
          Start using the app
        </a>
      ) : (
        <button type="button" className={BUTTON} disabled>
          Start using the app
        </button>
      )}
    </section>
  );
}
