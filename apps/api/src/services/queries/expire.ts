import { deleteOldEvents } from "../events/feed.js";
import { registerJob } from "../jobs/registry.js";
import { deleteStaleCounts } from "../rate-limit.js";
import { createResultStore } from "./store.js";

/*
 * Every 15 minutes, from the worker's schedule: deletes the results past
 * their expiry, trims the change feed to its 90 days, and drops rate-limit
 * counts a day old.
 */
registerJob("expire_results", "worker", async (deps) => {
  const now = deps.clock();
  const results = await createResultStore(deps).deleteExpired(now);
  const events = await deleteOldEvents(deps.db, now);
  const counts = await deleteStaleCounts(deps.db, now);
  deps.logger.info("expired results, old events and stale counts deleted", {
    results,
    events,
    counts,
  });
});
