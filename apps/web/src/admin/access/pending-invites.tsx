import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../layout/ui";
import { CopyBlock } from "../../shell/copy-button";
import { invitesQuery, resendInvite, revokeInvite } from "./api";
import { CELL, DataTable, Problem, stamp, useGuarded } from "./parts";
import { roleLabel } from "./roles";

export function PendingInvites() {
  const { invites } = useSuspenseQuery(invitesQuery).data;
  const { busy, problem, run } = useGuarded();
  const [links, setLinks] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const resend = (id: string) =>
    run(async () => {
      await resendInvite(id);
    });
  /** A link invite's new token ends the old one, so the first click warns and the second makes and copies it. */
  const newLink = (id: string) =>
    run(async () => {
      setConfirming(null);
      const { link } = await resendInvite(id);
      // The api answers a link invite's resend with its new link, always.
      if (link === null) throw new Error("The api sent no new link.");
      setLinks((before) => ({ ...before, [id]: link }));
      await navigator.clipboard.writeText(link);
    });
  return (
    <>
      {invites.length === 0 ? (
        <p className="text-ui text-ink-2">No pending invites.</p>
      ) : (
        <DataTable
          label="Pending invites"
          stack
          min="min-w-[40rem]"
          head={[
            "Email",
            "Role",
            "Invited by",
            "Last sent",
            "Expires",
            "Actions",
          ]}
        >
          {invites.map((invite) => (
            <tr key={invite.id}>
              <td className={CELL} data-label="Email">
                {invite.email}
              </td>
              <td className={CELL} data-label="Role">
                {roleLabel(invite.role)}
              </td>
              <td className={CELL} data-label="Invited by">
                {invite.inviter_name}
              </td>
              <td className={CELL} data-label="Last sent">
                {stamp(invite.last_sent_at)}
              </td>
              <td className={CELL} data-label="Expires">
                {invite.expired ? (
                  <span className="rounded border border-line px-2 py-1 text-meta">
                    Expired
                  </span>
                ) : (
                  stamp(invite.expires_at)
                )}
              </td>
              <td className={CELL}>
                <div className="flex flex-wrap gap-2">
                  {invite.delivery === "link" ? (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (confirming === invite.id) void newLink(invite.id);
                        else setConfirming(invite.id);
                      }}
                    >
                      {confirming === invite.id ? "Copy new link" : "New link"}
                    </Button>
                  ) : (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void resend(invite.id);
                      }}
                    >
                      Resend
                    </Button>
                  )}
                  {confirming === invite.id && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void run(() => revokeInvite(invite.id));
                    }}
                  >
                    Revoke
                  </Button>
                </div>
                {confirming === invite.id && (
                  <p className="text-ui text-ink-2">
                    The link you already shared stops working.
                  </p>
                )}
                {links[invite.id] !== undefined && (
                  <CopyBlock
                    label={`New invite link for ${invite.email}`}
                    value={links[invite.id] ?? ""}
                  />
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <Problem sentence={problem} />
    </>
  );
}
