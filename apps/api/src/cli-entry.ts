import { runServer } from "./server.js";

/*
 * The image's entry point: `api`, `worker` or `server <command>`. The two
 * long-running commands stop cleanly on SIGTERM, which is how Docker stops a
 * container; a start-up error or a failed job session ends the process
 * non-zero, so the container restarts.
 */

const USAGE = "usage: api | worker | server <command>";

function stopOnSignal(): AbortSignal {
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stop.abort();
    });
  }
  return stop.signal;
}

const [command, ...rest] = process.argv.slice(2);

if (command === "api" && rest.length === 0) {
  const { startApi } = await import("./main.js");
  await startApi(process.env, stopOnSignal());
} else if (command === "worker" && rest.length === 0) {
  const { startWorker } = await import("./worker.js");
  await startWorker(process.env, stopOnSignal());
} else if (command === "server") {
  await runServer(rest, process.env, (line) => {
    process.stdout.write(`${line}\n`);
  });
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}
