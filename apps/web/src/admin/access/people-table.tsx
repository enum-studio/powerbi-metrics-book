import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ClientName, clientLabel } from "../../shell/client-name";
import { EmptyState } from "../../shell/states";
import { Button, CheckLine, INPUT, SectionBox } from "../layout/ui";
import { runCheck, type Check } from "../settings/api";
import {
  type Person,
  type RoleAssignment,
  peopleQuery,
  revokeGrant,
  setPersonRole,
  setPersonTitle,
  setPersonPii,
  deactivatePerson,
  reactivatePerson,
  deletePerson,
  signOutPerson,
} from "./api";
import { subjectInWords } from "./assignments";
import {
  AccessDialog,
  CELL,
  ConfirmButton,
  DataTable,
  Problem,
  stamp,
  useGuarded,
} from "./parts";
import { roleLabel, SHIPPED_ROLES } from "./roles";

const POWERBI: Record<Person["powerbi_connection"], string> = {
  connected: "Connected",
  needs_reconnect: "Needs to reconnect",
  disconnected: "Disconnected",
  not_connected: "Not connected",
};

const METHODS: Record<string, string> = {
  dev: "Development sign-in",
  microsoft: "Microsoft",
  passkey: "Passkey",
  credential: "Email and password",
};

const assignmentSource = (source: RoleAssignment) =>
  source.subject_kind === "group"
    ? `group ${source.subject ?? ""}`
    : subjectInWords(source);

/** Each role a person holds and where it comes from: the default, or the assignments that reach them. */
function RoleSources({ roles }: { roles: Person["roles"] }) {
  if (roles.length === 0)
    return <span className="text-out">No role: turned away at sign-in</span>;
  return (
    <ul className="flex flex-col gap-1">
      {roles.map((each) => (
        <li key={each.role}>
          <span className="font-medium text-ink">{roleLabel(each.role)}</span>
          {" from "}
          {each.by_default
            ? "the default role"
            : each.assignments.map(assignmentSource).join(", ")}
        </li>
      ))}
    </ul>
  );
}

/** A person's MCP and CLI connections, each of which the admin may end. */
function Grants({
  person,
  busy,
  onRevoke,
}: {
  person: Person;
  busy: boolean;
  onRevoke: (id: string) => void;
}) {
  if (person.grants.length === 0) return <span>None</span>;
  return (
    <ul className="flex flex-col gap-2">
      {person.grants.map((grant) => (
        <li key={grant.id} className="flex flex-col items-start gap-1">
          <ClientName client={grant} />
          <span className="text-meta text-ink-3">
            {grant.via === "cli" ? "CLI" : "MCP"}, since{" "}
            {stamp(grant.granted_at)}
          </span>
          <Button
            disabled={busy}
            aria-label={`Revoke ${clientLabel(grant)} for ${person.email}`}
            onClick={() => {
              onRevoke(grant.id);
            }}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

function RoleSelect({
  person,
  busy,
  run,
}: {
  person: Person;
  busy: boolean;
  run: ReturnType<typeof useGuarded>["run"];
}) {
  return (
    <select
      aria-label={`Role for ${person.email}`}
      className={INPUT}
      value={person.direct_role ?? ""}
      disabled={busy}
      onChange={(event) => {
        const role = SHIPPED_ROLES.find(
          (each) => each.value === event.target.value,
        )?.value;
        if (role) void run(() => setPersonRole(person.id, role));
      }}
    >
      <option value="" disabled>
        Choose role
      </option>
      {SHIPPED_ROLES.map((each) => (
        <option key={each.value} value={each.value}>
          {each.label}
        </option>
      ))}
    </select>
  );
}

export function PeopleTable() {
  const { data: people } = useSuspenseQuery(peopleQuery);
  const [selected, select] = useState<string | null>(null);
  const [changing, change] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Person | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const { busy, problem, run } = useGuarded();
  const person = people.find((each) => each.id === selected);
  return (
    <>
      {people.length === 0 ? (
        <EmptyState title="Nobody has signed in yet">
          A person appears here the first time they sign in.
        </EmptyState>
      ) : (
        <DataTable
          label="Users"
          stack
          min="min-w-[40rem]"
          head={[
            "Name and email",
            "Role",
            "Status",
            "Signs in with",
            "Last seen",
            "Actions",
          ]}
        >
          {people.map((person) => (
            <tr
              key={person.id}
              onClick={(event) => {
                if (
                  event.target instanceof HTMLElement &&
                  !event.target.closest("button, select, input, details")
                )
                  select(person.id);
              }}
            >
              <td className={CELL} data-label="Name and email">
                <button
                  className="text-left text-ink hover:underline"
                  onClick={() => {
                    select(person.id);
                  }}
                >
                  {person.name}
                  {person.title ? `, ${person.title}` : ""}
                  <span className="block text-meta text-ink-3">
                    {person.email}
                  </span>
                </button>
              </td>
              <td className={CELL} data-label="Role">
                {person.status === "active" &&
                (person.direct_role !== null || changing === person.id) ? (
                  <RoleSelect person={person} busy={busy} run={run} />
                ) : (
                  <RoleSources roles={person.roles} />
                )}
              </td>
              <td className={CELL} data-label="Status">
                {person.status === "active" ? "Active" : "Deactivated"}
              </td>
              <td className={CELL} data-label="Signs in with">
                {person.sign_in_method === null
                  ? "Unknown"
                  : (METHODS[person.sign_in_method] ?? person.sign_in_method)}
              </td>
              <td className={CELL} data-label="Last seen">
                {stamp(person.last_seen_at)}
              </td>
              <td className={CELL}>
                <details>
                  <summary
                    className="cursor-pointer"
                    aria-label={`Actions for ${person.email}`}
                  >
                    Actions
                  </summary>
                  <div className="mt-2 grid gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        change(person.id);
                      }}
                    >
                      Change role
                    </Button>
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={person.pii_reader.source !== "none"}
                        disabled={
                          busy || person.pii_reader.source === "inherited"
                        }
                        onChange={(event) => {
                          void run(() =>
                            setPersonPii(person.id, event.target.checked),
                          );
                        }}
                      />
                      Can read PII
                    </label>
                    {person.pii_reader.source === "inherited" && (
                      <p className="text-meta text-ink-3">
                        From{" "}
                        {person.pii_reader.assignments
                          .map(assignmentSource)
                          .join(", ")}
                      </p>
                    )}
                    {person.status === "active" && (
                      <ConfirmButton
                        label="Sign out"
                        question={`Sign out ${person.name} everywhere? This ends their sessions and their MCP and CLI access. Their roles and Power BI connection stay.`}
                        confirm="Sign out"
                        disabled={busy}
                        onConfirm={() => {
                          void run(() => signOutPerson(person.id));
                        }}
                      />
                    )}
                    {person.status === "active" ? (
                      <ConfirmButton
                        label="Deactivate"
                        question={`Deactivate ${person.name}? This ends their sessions and disconnects Power BI, MCP and CLI.`}
                        confirm="Deactivate"
                        disabled={busy}
                        onConfirm={() => {
                          void run(() => deactivatePerson(person.id));
                        }}
                      />
                    ) : (
                      <>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            void run(() => reactivatePerson(person.id));
                          }}
                        >
                          Reactivate
                        </Button>
                        <Button
                          onClick={() => {
                            setDeleting(person);
                            setConfirmation("");
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </details>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <Problem sentence={problem} />
      {person && (
        <AccessDialog
          title={person.name}
          side
          close={() => {
            select(null);
          }}
        >
          <p className="mb-4 text-ui text-ink-2">{person.email}</p>
          <SectionBox title="Title">
            <form
              className="flex gap-2"
              key={person.id}
              onSubmit={(event) => {
                event.preventDefault();
                const field = event.currentTarget.elements.namedItem("title");
                if (field instanceof HTMLInputElement) {
                  const value = field.value;
                  void run(() => setPersonTitle(person.id, value));
                }
              }}
            >
              <input
                aria-label="Title"
                name="title"
                defaultValue={person.title}
                maxLength={500}
                className={INPUT}
              />
              <Button disabled={busy}>Save title</Button>
            </form>
          </SectionBox>
          <SectionBox title="Roles and sources">
            <RoleSources roles={person.roles} />
          </SectionBox>
          <SectionBox title="Power BI connection">
            {POWERBI[person.powerbi_connection]}
          </SectionBox>
          <SectionBox title="MCP and CLI connections">
            <Grants
              person={person}
              busy={busy}
              onRevoke={(id) => {
                void run(() => revokeGrant(id));
              }}
            />
          </SectionBox>
          <Problem sentence={problem} />
        </AccessDialog>
      )}
      {deleting && (
        <AccessDialog
          title={`Delete ${deleting.name}`}
          close={() => {
            setDeleting(null);
          }}
        >
          <p className="mb-3 text-ui">
            If a group, domain or the default role still reaches this email,
            they can sign in again as a new user. Type {deleting.email} to
            delete.
          </p>
          <input
            aria-label="Confirm email"
            className={INPUT}
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
          />
          <Button
            disabled={
              busy ||
              confirmation.trim().toLowerCase() !== deleting.email.toLowerCase()
            }
            onClick={() => {
              void run(async () => {
                await deletePerson(deleting.id);
                setDeleting(null);
              });
            }}
          >
            Delete
          </Button>
          <Problem sentence={problem} />
        </AccessDialog>
      )}
    </>
  );
}

/** The setup's "who would get in", run again on what is stored now, with the people it would turn away. */
export function WhoGetsIn() {
  const { data: people } = useSuspenseQuery(peopleQuery);
  const [result, setResult] = useState<Check | null>(null);
  const { busy, problem, run } = useGuarded();
  const turnedAway = people.filter(
    (person) => person.status === "active" && person.roles.length === 0,
  );
  const deactivated = people.filter(
    (person) => person.status === "deactivated",
  );
  return (
    <SectionBox title="Who would get in">
      <div className="flex flex-col gap-2">
        <div>
          <Button
            disabled={busy}
            onClick={() => {
              void run(async () => {
                setResult(await runCheck("who_gets_in"));
              });
            }}
          >
            Check who gets in
          </Button>
        </div>
        {result !== null && (
          <CheckLine status={result.status} message={result.message} />
        )}
        <Problem sentence={problem} />
      </div>
      <p className="text-ui text-ink-2">
        {turnedAway.length === 0
          ? "Every active person who has signed in holds a role."
          : `Turned away at sign-in: ${turnedAway.map((p) => p.email).join(", ")}.`}
      </p>
      {deactivated.length > 0 && (
        <p className="text-ui text-ink-2">
          Deactivated: {deactivated.map((p) => p.email).join(", ")}.
        </p>
      )}
    </SectionBox>
  );
}
