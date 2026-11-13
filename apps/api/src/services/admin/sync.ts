import { desc } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { type SYNC_KINDS, syncRun } from "../../db/schema/mirror.js";
import { enqueueUnlessActive } from "../jobs/queue.js";
import { audited, requireAdmin } from "./guard.js";

/**
 * Starts a sync by hand, audited. While one waits or runs it starts none and
 * answers that one, so callers at the same moment queue one sync.
 */
export async function startSync(
  context: ServiceContext,
  kind: (typeof SYNC_KINDS)[number],
): Promise<{ job_id: string; queued: boolean }> {
  await requireAdmin(context, "run_sync");
  // Any sync stands for this one, but a request to draft one dataset is no sync.
  const { id, queued } = await enqueueUnlessActive(
    context.db,
    {
      job: "sync",
      runner: "worker",
      args: { kind },
      trigger: "manual",
      requested_by: context.principal.id,
    },
    { holdingArg: "kind" },
  );
  if (queued)
    await audited(context, "sync.start", { kind: "job", id }, { kind });
  return { job_id: id, queued };
}

/** The newest runs first, with their counts and the error a failed one stored. */
export async function listSyncRuns(context: ServiceContext, limit: number) {
  await requireAdmin(context, "run_sync");
  return context.db
    .select()
    .from(syncRun)
    .orderBy(desc(syncRun.started_at))
    .limit(limit);
}
