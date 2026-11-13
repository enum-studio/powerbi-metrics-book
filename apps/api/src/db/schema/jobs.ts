import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Container } from "../../context.js";
import { declareGrants } from "../grants.js";

export const JOB_NAMES = [
  "sync",
  "expire_results",
  "expire_usage",
  "embed",
  "rekey_tokens",
  "refresh_idle_connections",
  "check",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const JOB_RUNNERS = ["worker", "api"] as const satisfies Container[];
export const JOB_TRIGGERS = ["schedule", "manual", "deploy"] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];
export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The values are this module's own constants, never input, so they are written into the DDL as literals. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}

/** The queue both containers take their work from; the runner column says which one. */
export const jobRequest = pgTable(
  "job_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").$type<JobName>().notNull(),
    runner: text("runner").$type<Container>().notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
    trigger: text("trigger").$type<JobTrigger>().notNull(),
    requested_by: text("requested_by"),
    requested_at: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    taken_at: timestamp("taken_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    error: text("error"),
  },
  (table) => [
    check("job_request_job", oneOf(table.job, JOB_NAMES)),
    check("job_request_runner", oneOf(table.runner, JOB_RUNNERS)),
    check("job_request_trigger", oneOf(table.trigger, JOB_TRIGGERS)),
    check("job_request_status", oneOf(table.status, JOB_STATUSES)),
    // take() reads the oldest queued request for one runner.
    index("job_request_queued")
      .on(table.runner, table.requested_at)
      .where(sql`${table.status} = 'queued'`),
  ],
);

declareGrants({
  job_request: {
    api_rw: ["select", "insert", "update"],
    worker_rw: ["select", "insert", "update"],
    audit_writer: [],
  },
});
