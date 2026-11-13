import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { TABLE_BOX, TABLE_HEAD, TABLE_HEADING } from "../admin/layout/ui";
import { ApiError, api } from "../api/client";
import { ClientName, clientLabel } from "../shell/client-name";
import {
  authCall,
  connectionQuery,
  type Grant,
  grantsQuery,
  sent,
  signInConfigQuery,
} from "./api";
import { formatTime } from "../shell/time";
import { ConnectAgent } from "./connect-agent";
import { Problem, SECONDARY_INLINE as SMALL } from "./parts";
import { addPasskey } from "./passkey";

const TABS = [
  { id: "powerbi", label: "Power BI" },
  { id: "agents", label: "Agents and the CLI" },
  { id: "passkeys", label: "Passkeys" },
  { id: "sessions", label: "Sessions" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const failed = (error: Error) =>
  error instanceof ApiError
    ? error.message
    : "This page stopped because of a fault in its own code. Reload it and try again.";

/** A person's connections: their Power BI grant, and each agent's and the CLI's, one tab each as Exa keeps two kinds of key apart. */
export function Connections() {
  const { data: config } = useSuspenseQuery(signInConfigQuery);
  const [tab, setTab] = useState<Tab>("powerbi");
  const tabs = TABS.filter((t) => t.id !== "passkeys" || config.passkeys);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title leading-tight font-semibold text-ink">
        Connections
      </h1>
      <div
        role="tablist"
        aria-label="Kinds of connection"
        className="flex gap-5 overflow-x-auto border-b border-line"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => {
              setTab(t.id);
            }}
            className={`border-b-2 py-2 text-ui whitespace-nowrap pointer-coarse:min-h-(--tap) ${tab === t.id ? "border-accent font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "powerbi" && <PowerBi />}
        {tab === "agents" && <Agents />}
        {tab === "passkeys" && <Passkeys />}
        {tab === "sessions" && <Sessions />}
      </section>
    </div>
  );
}

const CONNECT = `/api/v1/powerbi/connect?next=${encodeURIComponent("/settings/connections")}`;

const STATUS = {
  connected: "Connected",
  needs_reconnect: "Needs a reconnect",
  disconnected: "Not connected",
  not_connected: "Not connected",
} as const;

function PowerBi() {
  const { data: connection } = useSuspenseQuery(connectionQuery);
  const queryClient = useQueryClient();
  const disconnect = useMutation({
    mutationFn: () => sent(api.DELETE("/api/v1/powerbi/connection")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });
  const connected = connection.status === "connected";
  return (
    <div className="flex max-w-(--measure) flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-ui">
        <Row term="Status">
          <span data-testid="powerbi-status" className="font-medium text-ink">
            {STATUS[connection.status]}
          </span>
        </Row>
        {connection.account !== null &&
          connection.status !== "disconnected" && (
            <Row term="As">
              <span className="break-all">{connection.account}</span>
            </Row>
          )}
        {connected && connection.connected_at !== null && (
          <Row term="Connected">{formatTime(connection.connected_at)}</Row>
        )}
        {connected && (
          <Row term="Last used">
            {connection.last_used_at === null
              ? "Not yet"
              : formatTime(connection.last_used_at)}
          </Row>
        )}
      </dl>
      {connection.status === "needs_reconnect" &&
        connection.reason !== null && <Problem>{connection.reason}</Problem>}
      {connected && (
        <p className="text-ui text-ink-2">
          Queries run as the account connected last.
        </p>
      )}
      {!connected && connection.status !== "needs_reconnect" && (
        <p className="text-ui text-ink-2">
          Queries run in Power BI as you, with your own access. Connect your
          Microsoft account once to run them.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {connected && (
          <a href={CONNECT} className={SMALL}>
            Connect another account
          </a>
        )}
        {connected ? (
          <button
            type="button"
            className={SMALL}
            disabled={disconnect.isPending}
            onClick={() => {
              disconnect.mutate();
            }}
          >
            Disconnect
          </button>
        ) : (
          <a href={CONNECT} className={SMALL}>
            {connection.status === "needs_reconnect"
              ? "Reconnect"
              : "Connect Power BI"}
          </a>
        )}
      </div>
      {disconnect.error !== null && (
        <Problem>{failed(disconnect.error)}</Problem>
      )}
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{term}</dt>
      <dd className="min-w-0 text-ink-2">{children}</dd>
    </>
  );
}

function Agents() {
  const { data } = useSuspenseQuery(grantsQuery);
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) =>
      sent(api.DELETE("/api/v1/me/grants/{id}", { params: { path: { id } } })),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: grantsQuery.queryKey }),
  });
  if (data.grants.length === 0)
    return <ConnectAgent origin={window.location.origin} />;
  return (
    <div className="flex flex-col gap-3">
      <div className={TABLE_BOX}>
        <table className="w-full text-left text-ui">
          <thead className={TABLE_HEAD}>
            <tr>
              <th className={TABLE_HEADING}>Client</th>
              <th className={`${TABLE_HEADING} hidden sm:table-cell`}>Kind</th>
              <th className={TABLE_HEADING}>Granted</th>
              <th className={TABLE_HEADING}>
                <span className="sr-only">Revoke</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.grants.map((grant) => (
              <GrantRow
                key={grant.id}
                grant={grant}
                busy={revoke.isPending}
                onRevoke={() => {
                  revoke.mutate(grant.id);
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      {revoke.error !== null && <Problem>{failed(revoke.error)}</Problem>}
    </div>
  );
}

function GrantRow({
  grant,
  busy,
  onRevoke,
}: {
  grant: Grant;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <tr className="align-top">
      <td className="px-3 py-2.5">
        <ClientName client={grant} />
      </td>
      <td className="hidden px-3 py-2.5 text-ink-2 sm:table-cell">
        {grant.via === "cli" ? "Command line" : "MCP"}
      </td>
      <td className="px-3 py-2.5 text-ink-2">{formatTime(grant.granted_at)}</td>
      <td className="px-3 py-2.5 text-right">
        <button
          type="button"
          disabled={busy}
          aria-label={`Revoke ${clientLabel(grant)}`}
          onClick={onRevoke}
          className="text-ui text-out underline-offset-4 hover:underline disabled:opacity-60 pointer-coarse:min-h-(--tap)"
        >
          Revoke
        </button>
      </td>
    </tr>
  );
}

function Passkeys() {
  const add = useMutation({ mutationFn: addPasskey });
  return (
    <div className="flex max-w-(--measure) flex-col items-start gap-3">
      <p className="text-ui text-ink-2">
        A passkey signs you in with this device&apos;s PIN, fingerprint or face,
        without a provider.
      </p>
      <button
        type="button"
        className={SMALL}
        disabled={add.isPending}
        onClick={() => {
          add.mutate();
        }}
      >
        Add a passkey
      </button>
      {add.isSuccess && (
        <p role="status" className="text-ui text-ink">
          Passkey added. Next time, choose Sign in with a passkey.
        </p>
      )}
      {add.error !== null && <Problem>{failed(add.error)}</Problem>}
    </div>
  );
}

/** Ends every other browser session of the person, through Better Auth; this one stays. */
export function Sessions() {
  const signOut = useMutation({
    mutationFn: () =>
      authCall("/revoke-other-sessions", { method: "POST", body: {} }),
  });
  return (
    <div className="flex max-w-(--measure) flex-col items-start gap-3">
      <p className="text-ui text-ink-2">
        A sign-in lasts 7 days in each browser. If you lost a device, or signed
        in on one you share, sign out of every other browser here. Agents and
        the CLI stay connected; revoke them under Agents and the CLI.
      </p>
      <button
        type="button"
        className={SMALL}
        disabled={signOut.isPending}
        onClick={() => {
          signOut.mutate();
        }}
      >
        Sign out of all other sessions
      </button>
      {signOut.isSuccess && (
        <p role="status" className="text-ui text-ink">
          Signed out of every other session. You are still signed in here.
        </p>
      )}
      {signOut.error !== null && <Problem>{failed(signOut.error)}</Problem>}
    </div>
  );
}
