import type { AppDeps, Container } from "../../context.js";
import type { JobTrigger } from "../../db/schema/jobs.js";
import type { JobName } from "./queue.js";

/** The job request's args, and its own trigger, so the args never repeat it. */
export type JobHandler = (
  deps: AppDeps,
  parameters: Record<string, unknown>,
  trigger: JobTrigger,
) => Promise<void>;

export type RegisteredJob = {
  runner: Container;
  handler: JobHandler;
  /** How long a taken job waits for another run of its kind to finish before it is skipped. */
  max_wait_ms: number;
};

const TEN_MINUTES = 10 * 60 * 1000;

/** One name may have a handler in each container: the check job does. */
const registered = new Map<`${Container} ${JobName}`, RegisteredJob>();

/**
 * Called once per job, at the top level of the module that does the work.
 * services/jobs/all.ts, which the first such module creates, imports every
 * one of them, so both entries see every job.
 */
export function registerJob(
  name: JobName,
  runner: Container,
  handler: JobHandler,
  options: { max_wait_ms?: number } = {},
): void {
  if (registered.has(`${runner} ${name}`))
    throw new Error(`the job ${name} is registered twice in the ${runner}`);
  registered.set(`${runner} ${name}`, {
    runner,
    handler,
    max_wait_ms: options.max_wait_ms ?? TEN_MINUTES,
  });
}

export function handlerFor(
  name: JobName,
  runner: Container,
): RegisteredJob | undefined {
  return registered.get(`${runner} ${name}`);
}
