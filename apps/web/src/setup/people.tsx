import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { invitePeople, invitesQuery } from "../admin/access/api";
import { type PersonRole, SHIPPED_ROLES } from "../admin/access/roles";
import { Button, INPUT, Label } from "../admin/layout/ui";
import { putSetting, settingQuery } from "../admin/settings/api";
import { CopyBlock } from "../shell/copy-button";
import type { SetupState } from "./api";
import { FirstSyncLine } from "./first-sync";
import { BUTTON, LABEL } from "./parts";
import { checkedAddress, SCREENS, STEP_COUNT } from "./screens";

const DEFAULT_ROLE = "access.default_role";
const DEFAULT_ROLES = [
  {
    value: "none",
    label: "Only people I invite",
    hint: "Only the people you add below get in.",
  },
  {
    value: "viewer",
    label: "Everyone at the company as Viewer",
    hint: "Reads the book, and queries Power BI with their own rights.",
  },
  {
    value: "curator",
    label: "Everyone at the company as Curator",
    hint: "A viewer who can also change the book.",
  },
];

/** The message an admin sends: what it is, where to go, and that the app shows the rest. */
export const inviteMessage = (origin: string) =>
  `Our Power BI metrics are now in Power BI Metrics Book. Your AI agent can look up what a number means and query it with your own Power BI rights.\n\nSign in with your work account at ${origin}. The first page shows you how to connect your agent.`;

/** One decision and a message to send, as Pin's invite step: anyone in the company at one role, and the few who need more. */
export function PeopleScreen({ setup }: { setup: SetupState }) {
  const id = useId();
  const queryClient = useQueryClient();
  const { data: role } = useSuspenseQuery(settingQuery(DEFAULT_ROLE));
  // Unknown until the api answers, and the invite waits for it, so it never goes by link when email works.
  const invites = useQuery(invitesQuery);
  const emailReady = invites.data?.email_ready;
  const [link, setLink] = useState<string | null>(null);
  const navigate = useNavigate();
  const fixed = role.source === "environment" || role.environment_only;
  // Null until a person changes the select, so it shows what is saved now and never writes an older value back.
  const [held, setHeld] = useState<string | null>(null);
  const saved = String(role.value);
  const chosen = held ?? saved;
  // Saved by the button and not by the select: an arrow key on it must not change who gets in.
  const proceed = useMutation({
    mutationFn: async () => {
      if (chosen !== saved)
        queryClient.setQueryData(
          settingQuery(DEFAULT_ROLE).queryKey,
          await putSetting(DEFAULT_ROLE, chosen, false),
        );
      await navigate({ to: "/setup", search: { step: "agent" } });
    },
  });
  const [email, setEmail] = useState("");
  const [given, setGiven] = useState<PersonRole>("viewer");
  const add = useMutation({
    mutationFn: async () => {
      const result = await invitePeople({
        emails: [email],
        role: given,
        delivery: emailReady ? "email" : "link",
      });
      setLink(result.invites[0]?.link ?? null);
    },
    onSuccess: () => {
      setEmail("");
    },
  });
  const shown = DEFAULT_ROLES.find((each) => each.value === chosen);
  const position = SCREENS.findIndex((screen) => screen.id === "people") + 1;
  return (
    <section className="flex max-w-(--measure) flex-col gap-6">
      <div className="grid gap-2">
        <p className={LABEL}>
          Step {position} of {STEP_COUNT}
        </p>
        <h1 className="text-title font-semibold text-ink">Who gets in</h1>
      </div>
      <FirstSyncLine setup={setup} />
      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor={`${id}-default`}
          hint={
            fixed
              ? `Set by the environment (${role.environment_variable}).`
              : shown?.hint
          }
        >
          Everyone in your tenant signs in as
        </Label>
        <select
          id={`${id}-default`}
          className={INPUT}
          value={chosen}
          disabled={fixed || proceed.isPending}
          onChange={(event) => {
            setHeld(event.target.value);
          }}
        >
          {DEFAULT_ROLES.map((each) => (
            <option key={each.value} value={each.value}>
              {each.label}
            </option>
          ))}
        </select>
        {chosen !== saved && (
          <p className="text-meta text-ink-3">
            Not saved yet. Continue saves it.
          </p>
        )}
      </div>
      <form
        className="flex flex-col gap-3"
        aria-label="Invite someone"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate();
        }}
      >
        <h2 className="font-semibold text-ink">Who needs more</h2>
        <p className="text-ui text-ink-2">
          Curators shape the book with their agents. Admins also run this stack.
        </p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-email`}>Email</Label>
            <input
              id={`${id}-email`}
              type="email"
              required
              className={INPUT}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-role`}>Role</Label>
            <select
              id={`${id}-role`}
              className={INPUT}
              value={given}
              onChange={(event) => {
                setGiven(
                  SHIPPED_ROLES.find(
                    (each) => each.value === event.target.value,
                  )?.value ?? "viewer",
                );
              }}
            >
              {SHIPPED_ROLES.map((each) => (
                <option key={each.value} value={each.value}>
                  {each.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="submit"
            disabled={add.isPending || emailReady === undefined}
          >
            Invite
          </Button>
        </div>
        {link !== null && <CopyBlock label="Invite link" value={link} />}
        {add.isSuccess && link === null && <p role="status">Invite sent.</p>}
        {add.error !== null && <p role="alert">{add.error.message}</p>}
        {invites.error instanceof Error && (
          <p role="alert">{invites.error.message}</p>
        )}
      </form>
      <div className="flex flex-col gap-3">
        <h2 className="font-semibold text-ink">Tell your colleagues</h2>
        <CopyBlock
          label="A message to send them"
          value={inviteMessage(checkedAddress(setup))}
        />
      </div>
      {proceed.error !== null && <p role="alert">{proceed.error.message}</p>}
      <button
        type="button"
        className={BUTTON}
        disabled={proceed.isPending}
        onClick={() => {
          proceed.mutate();
        }}
      >
        Continue: connect your agent
      </button>
    </section>
  );
}
