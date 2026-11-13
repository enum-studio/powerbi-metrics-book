import { Cron } from "croner";
import type { AppDeps, Container, SettingKey } from "../../context.js";
import { enqueue, type JobName } from "./queue.js";

// How often the cron lines kept in settings are read again, so a schedule
// saved in the admin section takes effect without a restart.
const RELOAD_MS = 60_000;

/** The settings whose value is a cron line. */
export type CronSetting = Extract<SettingKey, `${string}schedule`>;

export type ScheduleEntry = {
  job: JobName;
  runner: Container;
  args?: Record<string, unknown>;
  /** A cron line, or the setting that holds one, read again every minute. */
  cron: string | { setting: CronSetting };
};

export type Schedule = { stop(): void };

type ScheduleDeps = Pick<AppDeps, "db" | "settings" | "logger">;

type Scheduled = {
  entry: ScheduleEntry;
  line: string;
  cron: Cron;
  /** The last line read from the setting that did not parse, logged once. */
  refused: string | null;
};

/**
 * Enqueues each entry's job, with trigger schedule, every time its cron line
 * fires. Fails before any entry fires when a line does not parse, naming the
 * setting it came from. Afterwards a setting's new line replaces its old one
 * within a minute; one that does not parse is logged, and the old one stays.
 */
export async function startSchedule(
  deps: ScheduleDeps,
  entries: readonly ScheduleEntry[],
): Promise<Schedule> {
  const scheduled: Scheduled[] = [];
  const stopCrons = (): void => {
    for (const { cron } of scheduled) cron.stop();
  };
  for (const entry of entries) {
    const [line, source] =
      typeof entry.cron === "string"
        ? [entry.cron, `the schedule of ${entry.job}`]
        : [
            await deps.settings.get(entry.cron.setting),
            `the setting ${entry.cron.setting}`,
          ];
    try {
      scheduled.push({
        entry,
        line,
        cron: startCron(deps, entry, line),
        refused: null,
      });
    } catch (error) {
      stopCrons();
      throw new Error(
        `${source} is "${line}", which is not a cron line: ${message(error)}`,
      );
    }
  }

  let stopped = false;
  let reloading = false;
  const reload = async (): Promise<void> => {
    for (const each of scheduled) {
      if (typeof each.entry.cron === "string") continue;
      const { setting } = each.entry.cron;
      const line = await deps.settings.get(setting);
      if (stopped) return;
      if (line === each.line) {
        each.refused = null;
        continue;
      }
      if (line === each.refused) continue;
      try {
        const cron = startCron(deps, each.entry, line);
        each.cron.stop();
        each.cron = cron;
        each.line = line;
        each.refused = null;
      } catch {
        // The setting's name only: what an admin typed stays in the admin
        // section.
        each.refused = line;
        deps.logger.error(
          "a saved schedule is not a cron line; the last one stays",
          {
            setting,
            job: each.entry.job,
          },
        );
      }
    }
  };
  const timer = setInterval(() => {
    // A read that outlasts a minute is not doubled, nor its new Cron.
    if (reloading) return;
    reloading = true;
    reload()
      .catch((error: unknown) => {
        deps.logger.error("the saved schedules could not be read again", {
          error: message(error),
        });
      })
      .finally(() => {
        reloading = false;
      });
  }, RELOAD_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      stopCrons();
    },
  };
}

function startCron(
  deps: ScheduleDeps,
  entry: ScheduleEntry,
  line: string,
): Cron {
  return new Cron(
    line,
    {
      // A firing whose enqueue has not returned yet is not doubled.
      protect: true,
      catch: (error) => {
        deps.logger.error("a scheduled job could not be queued", {
          job: entry.job,
          error: message(error),
        });
      },
    },
    async () => {
      await enqueue(deps.db, {
        job: entry.job,
        runner: entry.runner,
        args: entry.args ?? {},
        trigger: "schedule",
      });
    },
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
