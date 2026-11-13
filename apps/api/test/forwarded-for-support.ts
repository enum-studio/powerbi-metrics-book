import { createApp } from "../src/app.js";
import { createLogger } from "../src/log.js";
import { createTestDeps, testConfig } from "./deps.js";

/** An app whose warn lines are kept, on a clock the test moves. */
export function warningApp(env: Record<string, string>) {
  const lines: string[] = [];
  let now = new Date("2026-11-13T12:00:00Z");
  const app = createApp(
    createTestDeps({
      config: testConfig("api", env),
      logger: createLogger("warn", (line) => lines.push(line)),
      clock: () => now,
    }),
  );
  const send = (peer: string, headers: Record<string, string> = {}) =>
    app.request(
      "/health",
      { headers },
      { incoming: { socket: { remoteAddress: peer } } },
    );
  const warnings = () => lines.map((line) => JSON.parse(line) as unknown);
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { send, warnings, lines, advance };
}
