/*
 * The next time a five-field cron line fires, in UTC, for the sentence under
 * a schedule. The api's croner decides what a valid line is and runs it;
 * this reads the same lines (numbers, lists, ranges, steps, *) only to say
 * when. A line it cannot read gives null and no sentence, never a wrong one.
 */

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

function field(text: string, [low, high]: readonly [number, number]) {
  const allowed = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", step] = part.split("/");
    const every = step === undefined ? 1 : Number(step);
    const [from, to] =
      range === "*"
        ? [low, high]
        : range.includes("-")
          ? range.split("-").map(Number)
          : [Number(range), step === undefined ? Number(range) : high];
    if (
      from === undefined ||
      to === undefined ||
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      !Number.isInteger(every) ||
      every < 1
    )
      return null;
    for (let n = from; n <= to; n += every)
      allowed.add(n === 7 && high === 6 ? 0 : n);
  }
  return [...allowed].some((n) => n < low || n > high) ? null : allowed;
}

export function nextRun(line: string, after: Date): Date | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, i) => field(part, RANGES[i] ?? RANGES[0]));
  const [minute, hour, day, month, weekday] = sets;
  if (
    minute === null ||
    hour === null ||
    day === null ||
    month === null ||
    weekday === null ||
    minute === undefined ||
    hour === undefined ||
    day === undefined ||
    month === undefined ||
    weekday === undefined
  )
    return null;
  // Both day fields restricted means either may match, as cron does.
  const bothDays = parts[2] !== "*" && parts[4] !== "*";
  const at = new Date(after);
  at.setUTCSeconds(0, 0);
  const limit = after.getTime() + 366 * 24 * 60 * 60 * 1000;
  for (
    at.setUTCMinutes(at.getUTCMinutes() + 1);
    at.getTime() <= limit;
    at.setUTCMinutes(at.getUTCMinutes() + 1)
  ) {
    const dayOk = bothDays
      ? day.has(at.getUTCDate()) || weekday.has(at.getUTCDay())
      : day.has(at.getUTCDate()) && weekday.has(at.getUTCDay());
    if (
      minute.has(at.getUTCMinutes()) &&
      hour.has(at.getUTCHours()) &&
      month.has(at.getUTCMonth() + 1) &&
      dayOk
    )
      return at;
  }
  return null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/**
 * "Next run in 3 hours, Tue 27 Oct at 02:30 UTC (Tue 03:30 CET for you).", or
 * null for a line this cannot read. Cron runs in UTC, so UTC comes first; the
 * viewer's own time follows unless it is UTC too. `timeZone` is for tests.
 */
export function nextRunInWords(
  line: string,
  now: Date,
  timeZone?: string,
): string | null {
  const next = nextRun(line, now);
  if (next === null) return null;
  const distance = next.getTime() - now.getTime();
  const [unit, size] =
    UNITS.find(([, size]) => distance >= size) ?? UNITS[UNITS.length - 1] ?? [];
  if (unit === undefined || size === undefined) return null;
  const relative = new Intl.RelativeTimeFormat("en", {
    numeric: "always",
  }).format(Math.round(distance / size), unit);
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(next);
  const local = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
    hour12: false,
  })
    .format(next)
    .replace(",", "");
  const utc = `${when.replace(",", "").replace(/(\d\d:\d\d)$/, "at $1")} UTC`;
  return `Next run ${relative}, ${utc}${local.endsWith(" UTC") ? "" : ` (${local} for you)`}.`;
}
