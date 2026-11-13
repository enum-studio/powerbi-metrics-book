import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answered, type Browser } from "./browser.js";
import { ROOT } from "./stack.js";

type Ran = { code: number | null; stdout: string; stderr: string };

/**
 * `uv run pbmb` as one person on their own machine: a config directory of
 * their own holds their login. `started` sees stderr as it arrives.
 */
function run(
  home: string,
  url: string,
  command: string[],
  started?: (stderr: () => string) => Promise<void>,
): Promise<Ran> {
  // The person's own login, never a key the shell running the test may hold.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: home,
    PBMB_URL: url,
  };
  delete env.PBMB_API_KEY;
  const child = spawn("uv", ["run", "--no-sync", "pbmb", ...command], {
    cwd: ROOT,
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<Ran>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  if (started === undefined) return exited;
  return Promise.all([exited, started(() => stderr)]).then(([ran]) => ran);
}

export type Cli = {
  /** The command with --json; its parsed stdout, or an error naming the command, its exit code and stderr. */
  json<T>(command: string[]): Promise<T>;
  /** The command as it is, whatever its exit code. */
  run(command: string[]): Promise<Ran>;
  /** The access token the login saved, for a tool that calls the API with the person's rights. */
  accessToken(): string;
};

const said = (command: string[], ran: Ran) =>
  `pbmb ${command.join(" ")} exited with ${String(ran.code)}: ${ran.stderr.trim().slice(-600) || ran.stdout.trim().slice(-600)}`;

/**
 * `pbmb login` through the device flow: the CLI prints a code, the person
 * opens the device page in their browser, which shows the request, and
 * allows it there; the CLI's next poll gets the tokens.
 */
export async function loginCli(url: string, person: Browser): Promise<Cli> {
  const home = mkdtempSync(join(tmpdir(), "pbmb-e2e-"));
  const login = ["login", "--url", url];
  const ran = await run(home, url, login, async (stderr) => {
    const deadline = Date.now() + 60_000;
    let code: string | undefined;
    while (code === undefined) {
      code = /type this code[^\n]*\n\s*\n\s*(\S+)/.exec(stderr())?.[1];
      if (code !== undefined) break;
      if (Date.now() > deadline)
        throw new Error(
          `pbmb login printed no code in a minute: ${stderr().slice(-600)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await answered(
      await person.send(
        `/api/v1/oauth/device?user_code=${encodeURIComponent(code)}`,
      ),
      200,
      "GET /api/v1/oauth/device",
    );
    await answered(
      await person.send("/api/v1/oauth/device", {
        method: "POST",
        json: { user_code: code, allow: true },
      }),
      204,
      "POST /api/v1/oauth/device",
    );
  });
  if (ran.code !== 0) throw new Error(said(login, ran));
  const cli: Cli = {
    run: (command) => run(home, url, command),
    accessToken() {
      const saved = JSON.parse(
        readFileSync(join(home, "pbmb", "credentials.json"), "utf8"),
      ) as { access_token: string };
      return saved.access_token;
    },
    async json<T>(command: string[]) {
      const done = await run(home, url, [...command, "--json"]);
      if (done.code !== 0) throw new Error(said(command, done));
      return JSON.parse(done.stdout) as T;
    },
  };
  return cli;
}
