import { Assignments } from "../../admin/access/assignments";
import { PeopleTable, WhoGetsIn } from "../../admin/access/people-table";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { peopleQuery, invitesQuery } from "../../admin/access/api";
import { AccessDialog } from "../../admin/access/parts";
import { InvitePerson } from "../../admin/access/invite-person";
import { PendingInvites } from "../../admin/access/pending-invites";
import { roleLabel } from "../../admin/access/roles";
import { settingQuery } from "../../admin/settings/api";
import { Button, Segmented } from "../../admin/layout/ui";
import type { FieldSpec } from "../../admin/settings/fields";
import { Section } from "../../admin/settings/section";

const DEFAULT_ROLE: FieldSpec[] = [
  {
    key: "access.default_role",
    label: "Role of everyone in the tenant",
    kind: "choice",
    options: [
      { value: "none", label: "Only people I invite" },
      { value: "viewer", label: "Everyone at the company as Viewer" },
      { value: "curator", label: "Everyone at the company as Curator" },
    ],
    hint: "What anyone in the tenant with no assignment of their own can do. Never admin.",
  },
];

export function PeoplePage() {
  const { data: people } = useSuspenseQuery(peopleQuery);
  const { data: invites } = useSuspenseQuery(invitesQuery);
  const { data: role } = useSuspenseQuery(settingQuery("access.default_role"));
  const [tab, setTab] = useState<"users" | "invites" | "groups">("users");
  const [dialog, setDialog] = useState<"invite" | "default" | null>(null);
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-ink">Users and roles</h1>
        <Button
          primary
          onClick={() => {
            setDialog("invite");
          }}
        >
          Invite people
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-3 text-ui text-ink-2">
        <p>
          Who can sign in:{" "}
          {role.value === "none"
            ? "only people you invite."
            : `everyone in your Microsoft tenant as ${roleLabel(String(role.value))}.`}
        </p>
        <Button
          onClick={() => {
            setDialog("default");
          }}
        >
          Change
        </Button>
      </div>
      <Segmented
        label="People views"
        value={tab}
        onChange={setTab}
        options={[
          { value: "users", label: `Users (${String(people.length)})` },
          {
            value: "invites",
            label: `Pending invites (${String(invites.invites.length)})`,
          },
          { value: "groups", label: "Groups and domains" },
        ]}
      />
      {tab === "users" ? (
        <PeopleTable />
      ) : tab === "invites" ? (
        <PendingInvites />
      ) : (
        <>
          <Assignments />
          <WhoGetsIn />
        </>
      )}
      {dialog !== null && (
        <AccessDialog
          title={dialog === "invite" ? "Invite people" : "Who can sign in"}
          close={() => {
            setDialog(null);
          }}
        >
          {dialog === "invite" ? (
            <InvitePerson />
          ) : (
            <Section
              title="Default role"
              fields={DEFAULT_ROLE}
              checkName="who_gets_in"
            />
          )}
        </AccessDialog>
      )}
    </div>
  );
}
