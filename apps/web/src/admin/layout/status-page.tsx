import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { EmptyState } from "../../shell/states";
import { formatTime } from "../../shell/time";
import {
  ADMIN_KEY,
  runsQuery,
  type SyncRun,
  startSync,
  statusQuery,
} from "../settings/api";
import { Link } from "@tanstack/react-router";
import { FailingChecks } from "./failing";
import { syncCounts, TRIGGER_WORDS } from "./sync-words";
import { Button, LINK, PageFrame, SectionBox } from "./ui";

function lasted(run: Pick<SyncRun, "started_at" | "finished_at">): string {
  if (run.finished_at === null) return "still running";
  const seconds = Math.round(
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) /
      1000,
  );
  return seconds < 90
    ? `${String(seconds)} seconds`
    : `${String(Math.round(seconds / 60))} minutes`;
}

const RESULT: Record<SyncRun["status"], string> = {
  running: "is running",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "was skipped",
};

function LastSync({ run }: { run: SyncRun | undefined }) {
  if (run === undefined)
    return (
      <p className="text-ui text-ink-2">
        No sync has run yet. Run one now to read the tenant.
      </p>
    );
  return (
    <div className="flex flex-col gap-1 text-ui text-ink-2">
      <p>
        The last {run.kind} sync {RESULT[run.status]}.
        <span className="text-ink"> Started {formatTime(run.started_at)}</span>,{" "}
        {TRIGGER_WORDS[run.trigger]}, took {lasted(run)}.
      </p>
      <p>
        Read {String(run.workspaces_scanned)}{" "}
        {run.workspaces_scanned === 1 ? "workspace" : "workspaces"}.{" "}
        {syncCounts(run.counts)
          .map((clause) => `${clause}.`)
          .join(" ")}
      </p>
      {run.error !== null && (
        <p
          role={run.status === "failed" ? "alert" : undefined}
          className={run.status === "failed" ? "text-out" : undefined}
        >
          {run.error}
        </p>
      )}
    </div>
  );
}

function RunNow() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const { queued } = await startSync();
      setSaid(
        queued
          ? "A sync is queued."
          : "A sync already waits or runs, so none was added.",
      );
      await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setSaid(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        primary
        disabled={busy}
        onClick={() => {
          void run();
        }}
      >
        Run a sync now
      </Button>
      {said !== null && (
        <span role="status" className="text-ui text-ink-2">
          {said}
        </span>
      )}
    </div>
  );
}

export function StatusPage() {
  const { data: status } = useSuspenseQuery(statusQuery);
  const { data: runs } = useSuspenseQuery(runsQuery);
  const calm =
    status.failing_checks.length === 0 &&
    status.secrets_expiring.length === 0 &&
    status.connections_needing_reconnect === 0;
  return (
    <PageFrame
      title="Status"
      lede="Whether the sync is running, and what needs an admin."
    >
      <SectionBox title="Last sync">
        <LastSync run={runs[0]} />
        <RunNow />
      </SectionBox>

      <SectionBox title="Needs attention">
        {calm && (
          <p className="text-ui text-ink-2">
            Every check passes, no secret expires within 30 days, and every
            Power BI connection is live.
          </p>
        )}
        <FailingChecks checks={status.failing_checks} />
        {status.secrets_expiring.length > 0 && (
          <ul className="flex flex-col gap-2">
            {status.secrets_expiring.map((secret) => (
              <li
                key={secret.name}
                className={`text-ui ${secret.urgent === true ? "font-semibold text-out" : "text-ink-2"}`}
              >
                {secret.warning ?? `${secret.name} expires soon.`}{" "}
                <Link to="/admin/secrets" className={LINK}>
                  Open Secrets
                </Link>
              </li>
            ))}
          </ul>
        )}
        {status.connections_needing_reconnect > 0 && (
          <p className="text-ui text-ink-2">
            {String(status.connections_needing_reconnect)}{" "}
            {status.connections_needing_reconnect === 1
              ? "person needs"
              : "people need"}{" "}
            to reconnect Power BI
            {status.people_to_reconnect !== undefined &&
              `: ${status.people_to_reconnect.map((p) => p.email).join(", ")}`}
            .
          </p>
        )}
      </SectionBox>

      <SectionBox title="Recent syncs">
        {runs.length === 0 ? (
          <EmptyState title="No syncs yet">
            The first one shows here when it starts.
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap gap-x-4 gap-y-0.5 py-2 text-ui text-ink-2 first:pt-0 last:pb-0"
              >
                <span className="text-ink">{formatTime(run.started_at)}</span>
                <span>
                  {run.kind}, {run.status}
                </span>
                <span>{lasted(run)}</span>
                {run.error !== null && (
                  <span
                    className={`basis-full ${run.status === "failed" ? "text-out" : "text-ink-3"}`}
                  >
                    {run.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionBox>

      <p className="text-meta text-ink-3">
        Version {status.version}, build{" "}
        <code className="font-mono">{status.git_sha}</code>
      </p>
    </PageFrame>
  );
}
