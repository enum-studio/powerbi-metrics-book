// Imported by both entries (main.ts, worker.ts), so a job runs in whichever
// container registerJob names. A module that registers a job adds one import
// line here, and no other change.
import "../sync/run.js";
import "../connection/jobs.js";
import "../queries/expire.js";
import "../usage/expire.js";
import "../admin/checks.js";
import "../setup/worker-checks.js";
import "../search/embed-job.js";

export {};
