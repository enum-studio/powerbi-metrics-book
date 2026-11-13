import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, Circle } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Grant } from "../access/api";
import { ConnectAgent, useConnectedAgents } from "../access/connect-agent";
import { type Person, peopleQuery } from "../admin/access/api";
import { type Setting, settingQuery, statusQuery } from "../admin/settings/api";
import type { Me } from "../api/me";
import { bookSummaryQuery } from "../catalog/queries";
import { BUTTON, LINK, QUIET } from "../setup/parts";
import { inviteMessage } from "../setup/people";
import { CopyBlock, CopyValue } from "../shell/copy-button";
import { plural } from "../shell/plural";

export type Item = {
  id: string;
  title: string;
  status: string;
  state: "done" | "open";
  body: ReactNode;
};

const MARKS = {
  done: (
    <Check
      size={16}
      strokeWidth={2.5}
      aria-hidden="true"
      className="shrink-0 text-accent"
    />
  ),
  open: <Circle size={16} aria-hidden="true" className="shrink-0 text-ink-3" />,
};

/** One thing to do, folded when it is done; the first still open starts unfolded. */
function Row({ item, open }: { item: Item; open: boolean }) {
  return (
    <li className="border-t border-line first:border-t-0">
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 py-3 pointer-coarse:min-h-(--tap) [&::-webkit-details-marker]:hidden">
          {MARKS[item.state]}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-ui font-semibold text-ink">{item.title}</span>
            <span className="text-meta text-ink-3">{item.status}</span>
          </span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className="shrink-0 text-ink-3 group-open:rotate-180"
          />
        </summary>
        <div className="flex flex-col gap-4 pb-5 text-ui text-ink-2 sm:pl-7">
          {item.body}
        </div>
      </details>
    </li>
  );
}

const DRAFTS_GUIDE = "/docs/use/for-curators-drafts/";
const SKILLS_GUIDE = "/docs/set-up/agents/#skills";

type BookSummary = Awaited<
  ReturnType<NonNullable<typeof bookSummaryQuery.queryFn>>
>;

export function setupSteps({
  me,
  summary,
  agents,
  people,
  role,
}: {
  me: Me;
  summary: BookSummary;
  agents: Grant[];
  people: Person[] | undefined;
  role: Setting | undefined;
}): Item[] {
  const admin = me.may_admin;
  const curates = admin || me.roles.includes("curator");
  const { draft, agent_verified, human_verified } = summary.metrics;
  const verified = agent_verified + human_verified;
  const total = draft + verified;
  const connected = me.powerbi_connection === "connected";
  const asked = agents.some((agent) => agent.last_used_at !== null);
  const items: Item[] = [
    {
      id: "powerbi",
      title: connected ? "Power BI is connected" : "Connect Power BI",
      status:
        me.powerbi_connection === "needs_reconnect"
          ? "Your connection has ended."
          : "Your agent queries it with your own rights.",
      state: connected ? "done" : "open",
      body: connected ? (
        <p>
          <Link to="/settings/connections" className={LINK}>
            Your connections
          </Link>{" "}
          show it, and let you disconnect it.
        </p>
      ) : (
        <>
          <p className="max-w-(--measure)">
            Sign in to Power BI once. Nobody else's rights are ever used for
            your questions.
          </p>
          <a
            className={BUTTON}
            href={`/api/v1/powerbi/connect?next=${encodeURIComponent("/")}`}
          >
            Connect Power BI
          </a>
        </>
      ),
    },
    {
      id: "agent",
      title:
        agents.length > 0 ? "Your agent is connected" : "Connect your agent",
      status: "It reads the book and answers as you.",
      state: agents.length > 0 ? "done" : "open",
      body: <ConnectAgent origin={window.location.origin} />,
    },
    {
      id: "ask",
      title: "Ask your agent",
      status: asked
        ? "Your agent has reached the book. Here is more to ask it."
        : total === 0
          ? "Your agent can answer once the sync has run."
          : agents.length > 0
            ? "Your agent is connected and has not asked anything yet."
            : "It answers from the book first, then from Power BI.",
      state: asked ? "done" : "open",
      // Fixed words, never a metric's name: a name is Power BI's text, and this is a person's own prompt.
      body: (
        <>
          <CopyValue
            label="What there is"
            value="Which metrics do we have, and which datasets are they in?"
          />
          <CopyValue
            label="What a number means"
            value="Which of our metrics is the most widely used? What does it mean?"
          />
          <CopyValue
            label="What it came to"
            value="What did that metric come to last month, compared with the month before?"
          />
        </>
      ),
    },
  ];
  if (curates && total > 0)
    items.push({
      id: "drafts",
      title:
        verified >= 1
          ? "You have started structuring your drafts"
          : "Start structuring your drafts",
      status:
        draft > 0
          ? `${plural(draft, "draft")} from the sync, ${plural(verified, "verified metric")}`
          : plural(verified, "verified metric"),
      state: verified >= 1 ? "done" : "open",
      body: (
        <>
          <p className="max-w-(--measure)">
            The sync made a draft from each calculation it found. Your agent
            does the typing: it reads the DAX, merges what is the same and
            writes the definitions. You decide what the numbers mean. It uses
            the command line and our skills for this:{" "}
            <a className={LINK} href={SKILLS_GUIDE}>
              how to get them
            </a>
            .
          </p>
          <CopyBlock
            label="Ask your agent"
            value="Run pbmb curate and follow what it prints."
          />
          <CopyValue
            label="Or see them yourself"
            value="pbmb drafts next --limit 5"
          />
          <a className={LINK} href={DRAFTS_GUIDE}>
            Read the guide to drafts
          </a>
        </>
      ),
    });
  if (admin)
    items.push({
      id: "people",
      title: "Invite your colleagues",
      status:
        role === undefined
          ? "The default role could not be read. Reload the page."
          : role.value === "none"
            ? "Only people with a role get in."
            : `Everyone in your tenant gets in, as a ${String(role.value)}.`,
      state:
        people !== undefined && role !== undefined && people.length > 1
          ? "done"
          : "open",
      body: (
        <>
          <CopyBlock
            label="A message to send them"
            value={inviteMessage(window.location.origin)}
          />
          <Link to="/admin/people" className={LINK}>
            Users and roles
          </Link>
        </>
      ),
    });
  return items;
}

export function SetupNotice({ me }: { me: Me }) {
  const { data: summary } = useSuspenseQuery(bookSummaryQuery);
  const agents = useConnectedAgents();
  const admin = me.may_admin;
  const { data: people, isPending: peoplePending } = useQuery({
    ...peopleQuery,
    enabled: admin,
  });
  const { data: role, isPending: rolePending } = useQuery({
    ...settingQuery("access.default_role"),
    enabled: admin,
  });
  const items = setupSteps({ me, summary, agents, people, role });
  const next = items.find((item) => item.state === "open")?.id;
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const close = () => {
      setOpen(false);
      button.current?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const outside = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        close();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("click", outside);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("click", outside);
    };
  }, [open]);
  if (admin && (peoplePending || rolePending)) return null;
  if (next === undefined) return null;
  const done = items.filter((item) => item.state === "done").length;
  return (
    <div ref={container} className="relative ml-auto">
      <button
        ref={button}
        type="button"
        className={QUIET}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(!open);
          if (open) button.current?.focus();
        }}
      >
        Finish setup {done} of {items.length}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label="Finish setup"
          tabIndex={-1}
          className="absolute right-0 top-full z-20 mt-2 flex max-h-[calc(100dvh-var(--bar-height)-var(--space-8))] w-[min(var(--measure),calc(100vw-var(--space-8)))] flex-col gap-4 overflow-y-auto rounded border border-line bg-surface p-4 shadow"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("a")) {
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <ul className="flex flex-col">
            {items.map((item) => (
              <Row key={item.id} item={item} open={item.id === next} />
            ))}
          </ul>
          {admin && (
            <div className="flex flex-col gap-2 border-t border-line pt-4 text-ui text-ink-2">
              <h2 className="font-semibold text-ink">When you want more</h2>
              <ul className="flex max-w-(--measure) flex-col gap-1.5">
                <li>
                  <Link to="/admin/sign-in" className={LINK}>
                    Authentication
                  </Link>
                  : Google or another single sign-on, passkeys, and the Resend
                  key that invites by email and passwords need.
                </li>
                <li>
                  <Link to="/admin/search" className={LINK}>
                    Search
                  </Link>
                  : an embedding key, for search by meaning.
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChecksLine({ me }: { me: Me }) {
  const status = useQuery({ ...statusQuery, enabled: me.may_admin });
  if (!me.may_admin) return null;
  if (status.isError)
    return (
      <p className="text-ui text-ink-2">
        The checks could not be read. Reload the page. If it stays, the api's
        log has the reason.{" "}
        <Link to="/admin" className={LINK}>
          Open Status
        </Link>
      </p>
    );
  if (status.data === undefined) return null;
  const count =
    status.data.failing_checks.length + status.data.secrets_expiring.length;
  return count > 0 ? (
    <p className="text-ui text-ink-2">
      <Link to="/admin" className={LINK}>
        {plural(count, "thing")} to look at
      </Link>
    </p>
  ) : null;
}
