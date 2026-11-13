import { useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { plural } from "../../shell/plural";
import { EmptyState } from "../../shell/states";
import { Button, INPUT, Label, SectionBox } from "../layout/ui";
import {
  createServiceAccount,
  deleteServiceAccount,
  type ServiceAccount,
  serviceAccountsQuery,
  setDisabled,
} from "./api";
import { Keys } from "./keys";
import {
  CELL,
  ConfirmButton,
  DataTable,
  Problem,
  stamp,
  useGuarded,
} from "./parts";

const ROLES = ["viewer", "curator"] as const;

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

function Reach({ account }: { account: ServiceAccount }) {
  const { workspace_ids, app_ids } = account;
  if (workspace_ids.length === 0 && app_ids.length === 0)
    return <span>Nothing yet</span>;
  return (
    <details>
      <summary className="cursor-pointer">
        {plural(workspace_ids.length, "workspace")},{" "}
        {plural(app_ids.length, "app")}
      </summary>
      <ul className="mt-1 break-all font-mono text-meta">
        {[...workspace_ids, ...app_ids].map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
    </details>
  );
}

function AddAccount() {
  const id = useId();
  const { busy, problem, run } = useGuarded();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("viewer");
  const [workspaces, setWorkspaces] = useState("");
  const [apps, setApps] = useState("");
  const [days, setDays] = useState("30");
  return (
    <form
      aria-label="Create a service account"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await createServiceAccount({
            name,
            owner_email: owner,
            roles: [role],
            workspace_ids: lines(workspaces),
            app_ids: lines(apps),
            max_key_age_days: Number(days),
          });
          setName("");
        });
      }}
    >
      <div className="grid gap-4 @lg:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label
            htmlFor={`${id}-name`}
            hint="2 to 40 lower-case letters, numbers and underscores, starting with a letter."
          >
            Name
          </Label>
          <input
            id={`${id}-name`}
            className={INPUT}
            required
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label
            htmlFor={`${id}-owner`}
            hint="The person answerable for this account."
          >
            Owner email
          </Label>
          <input
            id={`${id}-owner`}
            type="email"
            className={INPUT}
            required
            value={owner}
            onChange={(event) => {
              setOwner(event.target.value);
            }}
          />
        </div>
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
          <Label
            htmlFor={`${id}-days`}
            hint="No key of this account lives longer. At most 90."
          >
            Key age limit (days)
          </Label>
          <input
            id={`${id}-days`}
            type="number"
            min={1}
            max={90}
            required
            className={INPUT}
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label
            htmlFor={`${id}-workspaces`}
            hint="Workspace ids, one per line. The account reaches no others."
          >
            Workspaces
          </Label>
          <textarea
            id={`${id}-workspaces`}
            rows={3}
            className={`${INPUT} font-mono`}
            value={workspaces}
            onChange={(event) => {
              setWorkspaces(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label
            htmlFor={`${id}-apps`}
            hint="App ids, one per line. The account reaches no others."
          >
            Apps
          </Label>
          <textarea
            id={`${id}-apps`}
            rows={3}
            className={`${INPUT} font-mono`}
            value={apps}
            onChange={(event) => {
              setApps(event.target.value);
            }}
          />
        </div>
      </div>
      <div>
        <Button type="submit" primary disabled={busy}>
          Create service account
        </Button>
      </div>
      <Problem sentence={problem} />
    </form>
  );
}

export function ServiceAccounts() {
  const { data: accounts } = useSuspenseQuery(serviceAccountsQuery);
  const { busy, problem, run } = useGuarded();
  const [open, setOpen] = useState<string | null>(null);
  const opened = accounts.find((account) => account.name === open);
  return (
    <>
      <SectionBox title="Service accounts">
        <p className="max-w-(--measure) text-ui text-ink-2">
          A service account is a caller that is not a person: a script, a
          pipeline or an agent. It signs in with a key, holds one role, and
          reaches only the workspaces and apps listed here.
        </p>
        {accounts.length === 0 ? (
          <EmptyState title="No service accounts yet">
            Create one below, then make a key for it.
          </EmptyState>
        ) : (
          <DataTable
            label="Service accounts"
            min="min-w-[40rem]"
            head={["Account", "Role and reach", "Key age limit", "Status", ""]}
          >
            {accounts.map((account) => (
              <tr key={account.name}>
                <td className={CELL}>
                  <p className="break-words text-ink">{account.name}</p>
                  <p className="break-words text-meta text-ink-3">
                    Owned by {account.owner_email}
                  </p>
                </td>
                <td className={CELL}>
                  <p>{account.roles.join(", ")}</p>
                  <Reach account={account} />
                </td>
                <td className={`${CELL} whitespace-nowrap`}>
                  {plural(account.max_key_age_days, "day")}
                </td>
                <td className={CELL}>
                  {account.disabled_at === null ? (
                    "Active"
                  ) : (
                    <>
                      <p>Disabled</p>
                      <p className="text-meta text-ink-3">
                        {stamp(account.disabled_at)}
                      </p>
                    </>
                  )}
                </td>
                <td className={CELL}>
                  <div className="flex flex-wrap items-start gap-2">
                    <Button
                      aria-label={`API keys for ${account.name}`}
                      onClick={() => {
                        setOpen(account.name);
                      }}
                    >
                      Keys
                    </Button>
                    <Button
                      disabled={busy}
                      aria-label={`${account.disabled_at === null ? "Disable" : "Enable"} ${account.name}`}
                      onClick={() => {
                        void run(async () => {
                          await setDisabled(
                            account.name,
                            account.disabled_at === null,
                          );
                        });
                      }}
                    >
                      {account.disabled_at === null ? "Disable" : "Enable"}
                    </Button>
                    <ConfirmButton
                      label="Delete"
                      question={`Delete ${account.name} with its keys and stored results? This cannot be undone.`}
                      confirm="Delete account"
                      disabled={busy}
                      onConfirm={() => {
                        void run(() => deleteServiceAccount(account.name));
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        <Problem sentence={problem} />
        <AddAccount />
      </SectionBox>
      {opened !== undefined && <Keys key={opened.name} account={opened} />}
    </>
  );
}
