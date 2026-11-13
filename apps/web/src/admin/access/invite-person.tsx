import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, INPUT, Label, LINK } from "../layout/ui";
import { CopyBlock } from "../../shell/copy-button";
import { invitePeople, invitesQuery } from "./api";
import { Problem, useGuarded } from "./parts";
import { SHIPPED_ROLES } from "./roles";

export function InvitePerson() {
  const [entry, setEntry] = useState("");
  const [role, setRole] = useState("viewer");
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof invitePeople>
  > | null>(null);
  const { busy, problem, run } = useGuarded();
  const emailReady = useSuspenseQuery(invitesQuery).data.email_ready;
  const emails = [...new Set(entry.split(/[,\s]+/).filter(Boolean))];
  const valid =
    emails.length > 0 &&
    emails.length <= 50 &&
    emails.every((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));
  function send(delivery: "email" | "link") {
    setResult(null);
    void run(async () => {
      setResult(await invitePeople({ emails, role, delivery }));
    });
  }
  return (
    <form
      aria-label="Invite people"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        send(emailReady ? "email" : "link");
      }}
    >
      <div>
        <Label htmlFor="invite-email">Emails</Label>
        <input
          id="invite-email"
          className={INPUT}
          value={entry}
          onChange={(event) => {
            setEntry(event.target.value);
          }}
          aria-describedby="invite-hint"
        />
        <p id="invite-hint" className="text-meta text-ink-3">
          Separate up to 50 emails with commas or spaces.
        </p>
        <ul aria-label="Email addresses" className="mt-2 flex flex-wrap gap-2">
          {emails.map((email) => (
            <li
              key={email}
              className="rounded border border-line px-2 py-1 text-ui text-ink"
            >
              {email}
              <button
                type="button"
                aria-label={`Remove ${email}`}
                className="ml-2 text-ink-3"
                onClick={() => {
                  setEntry(emails.filter((each) => each !== email).join(", "));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-ui font-medium text-ink">Role</legend>
        {SHIPPED_ROLES.map((each) => (
          <label
            key={each.value}
            className="flex gap-3 rounded border border-line p-3 text-ui text-ink"
          >
            <input
              type="radio"
              name="invite-role"
              value={each.value}
              checked={role === each.value}
              onChange={() => {
                setRole(each.value);
              }}
            />
            <span>
              {each.label}
              <span className="block text-ink-2">{each.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {!emailReady && (
        <p className="text-ui text-ink-2">
          Email is not set up, so you send the link yourself. Set up email in{" "}
          <Link to="/admin/sign-in" className={LINK}>
            Authentication
          </Link>
          .
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {emailReady && (
          <Button primary type="submit" disabled={busy || !valid}>
            Send invites
          </Button>
        )}
        <Button
          primary={!emailReady}
          disabled={busy || !valid || emails.length !== 1}
          onClick={() => {
            send("link");
          }}
        >
          {emailReady ? "Create invite link instead" : "Create invite link"}
        </Button>
      </div>
      {result !== null && (
        <div role="status" className="grid gap-2 text-ui text-ink">
          {result.invites.some((invite) => invite.link !== null)
            ? result.invites.map(
                (invite) =>
                  invite.link !== null && (
                    <CopyBlock
                      key={invite.id}
                      label={`Invite link for ${invite.email}`}
                      value={invite.link}
                    />
                  ),
              )
            : "Invites sent."}
        </div>
      )}
      <Problem sentence={problem} />
    </form>
  );
}
