import { useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { EmptyState } from "../../shell/states";
import { Button, INPUT, Label, SectionBox } from "../layout/ui";
import {
  assignRole,
  peopleQuery,
  type NewAssignment,
  type RoleAssignment,
  revokeRole,
  rolesQuery,
} from "./api";
import { CELL, DataTable, Problem, stamp, useGuarded } from "./parts";

export const ROLES = ["viewer", "curator", "admin", "pii_reader"] as const;
type Kind = "person" | "email_domain" | "group";
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "person", label: "A person", hint: "Their email address." },
  {
    value: "email_domain",
    label: "An email domain",
    hint: "The part after the @, for everyone who signs in with an address there.",
  },
  {
    value: "group",
    label: "A group",
    hint: "The group's id at the sign-in provider that holds it.",
  },
];

/** Who an assignment reaches, in words. */
export function subjectInWords(a: RoleAssignment): string {
  switch (a.subject_kind) {
    case "person":
      return a.subject ?? "";
    case "email_domain":
      return `Everyone at ${a.subject ?? ""}`;
    case "group":
      return `Group ${a.subject ?? ""} at ${a.provider ?? "its provider"}`;
    case "everyone_in_tenant":
      return "Everyone in the tenant";
  }
}

function AddAssignment() {
  const id = useId();
  const { busy, problem, run } = useGuarded();
  const [role, setRole] = useState<(typeof ROLES)[number]>("curator");
  const [kind, setKind] = useState<Kind>("person");
  const [subject, setSubject] = useState("");
  const [provider, setProvider] = useState("");
  const shown = KINDS.find((k) => k.value === kind);

  const body = (): NewAssignment =>
    kind === "group"
      ? { role, subject_kind: kind, provider, subject }
      : { role, subject_kind: kind, subject };

  return (
    <form
      aria-label="Add a role assignment"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await assignRole(body());
          setSubject("");
        });
      }}
    >
      <div className="grid gap-4 @lg:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-role`}>Role</Label>
          <select
            id={`${id}-role`}
            className={INPUT}
            value={role}
            onChange={(event) => {
              setRole(ROLES.find((r) => r === event.target.value) ?? role);
            }}
          >
            {ROLES.map((each) => (
              <option key={each}>{each}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-kind`}>Given to</Label>
          <select
            id={`${id}-kind`}
            className={INPUT}
            value={kind}
            onChange={(event) => {
              setKind(
                KINDS.find((k) => k.value === event.target.value)?.value ??
                  kind,
              );
            }}
          >
            {KINDS.map((each) => (
              <option key={each.value} value={each.value}>
                {each.label}
              </option>
            ))}
          </select>
        </div>
        {kind === "group" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-provider`}>Sign-in provider</Label>
            <input
              id={`${id}-provider`}
              className={INPUT}
              value={provider}
              required
              onChange={(event) => {
                setProvider(event.target.value);
              }}
            />
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-subject`} hint={shown?.hint}>
            {kind === "person"
              ? "Email"
              : kind === "email_domain"
                ? "Domain"
                : "Group id"}
          </Label>
          <input
            id={`${id}-subject`}
            className={INPUT}
            value={subject}
            required
            onChange={(event) => {
              setSubject(event.target.value);
            }}
          />
        </div>
      </div>
      <div>
        <Button type="submit" primary disabled={busy}>
          Add assignment
        </Button>
      </div>
      <Problem sentence={problem} />
    </form>
  );
}

function AssignmentRow({
  assignment,
  lastAdmin,
  madeBy,
  onRevoke,
  busy,
}: {
  assignment: RoleAssignment;
  lastAdmin: boolean;
  madeBy: string;
  onRevoke: () => void;
  busy: boolean;
}) {
  return (
    <tr>
      <td className={`${CELL} text-ink`}>{assignment.role}</td>
      <td className={CELL}>
        {subjectInWords(assignment)}
        {lastAdmin && (
          <p className="mt-1 max-w-(--measure) text-meta text-ink-3">
            The last admin. It cannot be revoked until another person is made
            admin, so someone can always administer.
          </p>
        )}
      </td>
      <td className={`${CELL} break-words`}>{madeBy}</td>
      <td className={`${CELL} whitespace-nowrap`}>
        {stamp(assignment.granted_at)}
      </td>
      <td className={CELL}>
        <Button
          disabled={busy}
          aria-label={`Revoke ${assignment.role} from ${subjectInWords(assignment)}`}
          onClick={onRevoke}
        >
          Revoke
        </Button>
      </td>
    </tr>
  );
}

export function Assignments() {
  const { data: assignments } = useSuspenseQuery(rolesQuery);
  const { data: people } = useSuspenseQuery(peopleQuery);
  const { busy, problem, run } = useGuarded();
  const admins = assignments.filter(
    (a) => a.role === "admin" && a.subject_kind === "person",
  );
  return (
    <SectionBox title="Role assignments">
      <p className="max-w-(--measure) text-ui text-ink-2">
        A role is given to a person, to everyone at an email domain, or to a
        group at a sign-in provider. A person holds every role that reaches
        them.
      </p>
      {assignments.length === 0 ? (
        <EmptyState title="No assignments yet">
          Everyone in the tenant gets the default role. Add an assignment below
          to make someone a curator or an admin.
        </EmptyState>
      ) : (
        <DataTable
          label="Role assignments"
          min="min-w-[40rem]"
          head={["Role", "Given to", "Made by", "Made on", ""]}
        >
          {assignments.map((assignment) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              lastAdmin={admins.length === 1 && admins[0]?.id === assignment.id}
              madeBy={
                people.find((p) => p.id === assignment.granted_by)?.email ??
                assignment.granted_by
              }
              busy={busy}
              onRevoke={() => {
                void run(() => revokeRole(assignment.id));
              }}
            />
          ))}
        </DataTable>
      )}
      <Problem sentence={problem} />
      <AddAssignment />
    </SectionBox>
  );
}
