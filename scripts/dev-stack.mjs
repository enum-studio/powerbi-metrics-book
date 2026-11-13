#!/usr/bin/env node
// The whole stack on the mock tenant, one per checkout.
// Usage: node scripts/dev-stack.mjs up [--no-setup] | serve [--no-setup] | down | reset
//   | logs [service] | url | setup-link
// (pnpm dev:up, dev:down, dev:reset, dev:logs).
//
// The compose project name and the ports come from a hash of the checkout's
// path, so worktrees and parallel agents each run their own stack. `up` then
// runs the image's server sample-seed command for setup and the sample book.
// With --no-setup it stops before the setup and
// prints the setup link instead, so the setup screen can be walked by hand or
// by its Playwright flow; setup-link prints a new one, ending every earlier one.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE } from "../apps/api/src/services/sample/tenant.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The compose project name, and the api's port with the mock's beside it, for
 * the checkout at path. 30000 to 39999 sits above the well-known ports and
 * below the ephemeral range macOS allocates from (49152 up); the api's tests
 * use 20000 to 29999. The api takes an even port and the mock the odd one
 * after it, so one checkout's mock is never another's api. Postgres has no
 * port: it is on the internal network, and only the api publishes one.
 */
export function devIdentity(path) {
  const digest = createHash("sha256").update(resolve(path)).digest("hex");
  const api_port = 30000 + 2 * (Number.parseInt(digest.slice(0, 8), 16) % 4999);
  return {
    project: `pbmb_${digest.slice(0, 8)}`,
    api_port,
    mock_port: api_port + 1,
  };
}

const ENV_LOCAL_NAMES = [
  "POSTGRES_PASSWORD",
  "MIGRATOR_PASSWORD",
  "API_RW_PASSWORD",
  "WORKER_RW_PASSWORD",
  "AUDIT_WRITER_PASSWORD",
  "AUTH_SECRET",
];

/**
 * Writes .env.local with random throwaway values the first time, and answers
 * whether it did. A file that exists is never touched: postgres made its roles
 * with its passwords when the volume was first used.
 */
export function ensureEnvLocal(root) {
  const lines = [
    "# Throwaway development values, written once by pnpm dev:up. Gitignored.",
    ...ENV_LOCAL_NAMES.map(
      (name) => `${name}=${randomBytes(24).toString("hex")}`,
    ),
  ];
  try {
    writeFileSync(join(root, ".env.local"), `${lines.join("\n")}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Writes the local connector's config for Claude Code (.mcp.json) and Cursor
 * (.cursor/mcp.json), pointing at this checkout's api port. The content is
 * derived from the checkout's path, so every run overwrites it; the files are
 * gitignored because no committed file could hold a port that differs per
 * checkout. The entry is named powerbi_metrics_book_dev, so a checkout that ran
 * the dev stack still loads the production connector under its own name.
 */
export function writeConnectorConfigs(root, { api_port }) {
  const url = `http://localhost:${String(api_port)}/api/mcp`;
  const _comment =
    "The local connector. pnpm dev:up writes this file from the checkout's path.";
  const configs = {
    ".mcp.json": { type: "http", url },
    ".cursor/mcp.json": { url },
  };
  for (const [file, server] of Object.entries(configs)) {
    const config = {
      _comment,
      mcpServers: { powerbi_metrics_book_dev: server },
    };
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `${JSON.stringify(config, null, 2)}\n`);
  }
}

export function openStack(root) {
  const identity = devIdentity(root);
  const url = `http://localhost:${String(identity.api_port)}`;
  return {
    ...identity,
    root,
    url,
    env: {
      COMPOSE_PROJECT_NAME: identity.project,
      PBMB_PORT: String(identity.api_port),
      PBMB_MOCK_PORT: String(identity.mock_port),
      PUBLIC_BASE_URL: url,
    },
  };
}

/** The commit the image is built from: it bakes it in, and the api refuses to start without one. */
export function gitSha(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `The image needs the commit's sha as GIT_SHA, and git rev-parse HEAD failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

/** A program's stdout when capture is set; its output otherwise goes to this one's. */
function run(program, command, { cwd, env = {}, capture = false, hint = "" }) {
  const result = spawnSync(program, command, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error)
    throw new Error(`Could not run ${program}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `${program} ${command[0]} exited with ${String(result.status)}${hint}`,
    );
  return result.stdout;
}

/** docker compose on the project's file and the dev overlay. */
function compose(stack, command, { capture = false } = {}) {
  ensureEnvLocal(stack.root);
  return run(
    "docker",
    [
      "compose",
      ...["-f", "stack/compose.yml", "-f", "stack/dev/compose.dev.yml"],
      ...["--env-file", ".env.local", "-p", stack.project],
      ...command,
    ],
    {
      cwd: stack.root,
      env: { ...stack.env, GIT_SHA: gitSha(stack.root) },
      capture,
      hint: "; pnpm dev:logs <service> shows why a service failed",
    },
  );
}

/** This project's own two image tags, which a build makes; never an image another project or the registry shares. */
function removeOwnImages(stack) {
  for (const name of ["powerbi-metrics-book", "powerbi-metrics-book-mock"]) {
    const image = `${name}:${stack.project}`;
    const built = run("docker", ["image", "ls", "--quiet", image], {
      capture: true,
    });
    if (built.trim() !== "") run("docker", ["image", "rm", image], {});
  }
}

/** A new setup link from `server setup-link`, as a person runs it; it ends every earlier link. Undefined when an admin exists. */
function newSetupLink(stack) {
  const printed = compose(
    stack,
    ["exec", "-T", "api", "server", "setup-link"],
    { capture: true },
  );
  return printed.match(/https?:\/\/\S+/)?.[0];
}

/** What a browser keeps between requests: one cookie per name, sent where its path matches. Secure is ignored, as Chrome and Firefox do on localhost. */
function browser(origin) {
  const jar = new Map();
  return {
    async send(target, { method = "GET", json } = {}) {
      const url = new URL(target, origin);
      const headers = {};
      if (url.origin === origin) {
        const cookie = [...jar]
          .filter(([, c]) => url.pathname.startsWith(c.path))
          .map(([name, c]) => `${name}=${c.value}`)
          .join("; ");
        if (cookie !== "") headers.cookie = cookie;
        // The api refuses a state-changing request from another origin.
        if (method !== "GET") headers.origin = origin;
      }
      if (json !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        redirect: "manual",
      });
      if (url.origin === origin)
        for (const line of response.headers.getSetCookie()) {
          const [, name, value] = /^([^=]+)=([^;]*)/.exec(line);
          const path = /;\s*path=([^;]+)/i.exec(line)?.[1] ?? "/";
          // The api clears a cookie by setting it empty.
          if (value === "") jar.delete(name);
          else jar.set(name, { value, path });
        }
      return response;
    },
  };
}

async function answered(response, status, what) {
  if (response.status !== status)
    throw new Error(
      `${what}: the api answered ${String(response.status)}: ${await response.text()}`,
    );
  return response;
}

const secretValue = (value) => ({ value, expires_at: "2099-12-31T00:00:00Z" });

async function devSignInAdmin(web) {
  await answered(
    await web.send("/api/auth/dev/sign-in", {
      method: "POST",
      json: {
        email: "admin@sample.example",
        object_id: SAMPLE.people["admin@sample.example"],
      },
    }),
    200,
    "The dev sign-in of the sample admin",
  );
}

/** The sample admin signed in with the dev sign-in, as a browser: used by email-password. */
export async function adminSession(stack) {
  const web = browser(stack.url);
  await devSignInAdmin(web);
  return web.send;
}

function report(stack) {
  const mock = `http://localhost:${String(stack.mock_port)}`;
  console.log(`
Power BI Metrics Book is up on the mock tenant (sample data).
  Open       ${stack.url}
  Connector  ${stack.url}/api/mcp
  Mock       ${mock}
  Project    ${stack.project}   dev:down keeps the data, dev:reset removes it
  Logs       pnpm dev:logs [service]

Sign in as a sample person, in Chrome or Firefox: Safari may refuse the Secure
cookies on http://localhost. In a browser, pick who Microsoft signs in, then
choose Sign in with Microsoft:
  curl -X POST ${mock}/_mock/acting-user -H 'content-type: application/json' -d '{"object_id":"<id>"}'
Without a browser, the dev sign-in:
  curl -X POST ${stack.url}/api/auth/dev/sign-in -H 'origin: ${stack.url}' -H 'content-type: application/json' -d '{"email":"<email>"}'
${Object.entries(SAMPLE.people)
  .map(([email, id]) => `  ${email.padEnd(28)}${id}`)
  .join("\n")}
What each person reaches: packages/powerbi-mock/src/sample/README.md`);
}

/** A new link, for the person who set the stack up and left the setup unfinished. */
function reportNoSetup(stack) {
  const link = newSetupLink(stack);
  console.log(`
Power BI Metrics Book is up on the mock tenant, with the setup not run (--no-setup).
  Open the setup  ${link ?? "no link: an admin exists"}
  A new link      node scripts/dev-stack.mjs setup-link
  Mock            http://localhost:${String(stack.mock_port)}
  Project         ${stack.project}   dev:down keeps the data, dev:reset removes it`);
}

function setupFlag(args) {
  const unknown = args.filter((arg) => arg !== "--no-setup");
  if (unknown.length > 0)
    throw new Error(
      `Unknown option ${unknown.join(" ")}: up and serve take --no-setup`,
    );
  return args.includes("--no-setup");
}

const COMMANDS = {
  async up(stack, args = []) {
    const noSetup = setupFlag(args);
    writeConnectorConfigs(stack.root, stack);
    compose(stack, ["up", "-d", "--build", "--wait"]);
    if (noSetup) return reportNoSetup(stack);
    compose(stack, ["exec", "-T", "api", "server", "sample-seed"]);
    report(stack);
  },
  // For a preview pane or a terminal that owns the stack: up, then hold until
  // stopped, then down, so a stopped preview leaves no stack or network behind.
  async serve(stack, args) {
    await COMMANDS.up(stack, args);
    const hold = setInterval(() => {}, 1 << 30);
    const signal = await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    clearInterval(hold);
    console.log(`${signal}: taking the stack down.`);
    COMMANDS.down(stack);
  },
  async "email-password"(stack) {
    const send = await adminSession(stack);
    await answered(
      await send("/api/v1/admin/secrets/resend_api_key", {
        method: "PUT",
        json: secretValue("sample-resend-key"),
      }),
      200,
      "The dev email key",
    );
    for (const [key, value] of [
      ["email.from", "invites@sample.example"],
      ["sign_in.email_password", true],
    ])
      await answered(
        await send(`/api/v1/admin/settings/${key}`, {
          method: "PUT",
          json: { value },
        }),
        200,
        `The ${key} setting`,
      );
  },
  url: (stack) => console.log(stack.url),
  // The documented command, as a person runs it; it ends every earlier link
  // and setup session.
  "setup-link": (stack) =>
    process.stdout.write(
      compose(stack, ["exec", "-T", "api", "server", "setup-link"], {
        capture: true,
      }),
    ),
  down: (stack) => compose(stack, ["down", "--remove-orphans"]),
  reset(stack) {
    compose(stack, ["down", "--remove-orphans", "--volumes"]);
    removeOwnImages(stack);
  },
  logs(stack, [service]) {
    const output = compose(
      stack,
      ["logs", "--tail", "200", ...(service ? [service] : [])],
      { capture: true },
    );
    process.stdout.write(output);
  },
};

async function main([command, ...rest]) {
  const action = COMMANDS[command ?? ""];
  if (action === undefined)
    throw new Error(
      `Usage: dev-stack.mjs ${Object.keys(COMMANDS).join(" | ")}`,
    );
  await action(openStack(realpathSync(ROOT)), rest);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `dev-stack: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
