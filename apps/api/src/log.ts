export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type Fields = Record<string, string | number | boolean | null | undefined>;
export type Logger = Record<
  LogLevel,
  (message: string, fields?: Fields) => void
>;

/**
 * One JSON object per line on stdout. Fields are named by the caller and
 * nothing is added from the request, so a header, cookie or body reaches the
 * log only if a caller passes one, and none does.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const at =
    (lineLevel: LogLevel) =>
    (message: string, fields: Fields = {}): void => {
      if (LOG_LEVELS.indexOf(lineLevel) < threshold) return;
      write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: lineLevel,
          msg: message,
          ...fields,
        }),
      );
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}
