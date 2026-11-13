import { lt } from "drizzle-orm";
import { request, searchLog } from "../../db/schema/usage.js";
import { registerJob } from "../jobs/registry.js";

// Deletes requests and searches older than the configured usage retention.
registerJob("expire_usage", "worker", async (deps) => {
  const days = await deps.settings.get("usage.retention_days");
  const cutoff = new Date(deps.clock().getTime() - days * 86_400_000);
  const requests = await deps.db.delete(request).where(lt(request.at, cutoff));
  const searches = await deps.db
    .delete(searchLog)
    .where(lt(searchLog.at, cutoff));
  deps.logger.info("old requests and searches deleted", {
    requests: requests.rowCount,
    searches: searches.rowCount,
  });
});
