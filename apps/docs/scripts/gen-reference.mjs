#!/usr/bin/env node
// Writes the reference pages the code can state for itself:
//
//   reference/cli.md        from apps/cli/scripts/dump_help.py (the CLI's help)
//   reference/mcp-tools.md  from apps/api/scripts/dump-mcp-tools.ts
//   reference/rest-api.md   from apps/api/openapi.json
//   reference/settings.md   from apps/api/scripts/dump-settings.ts
//
//   node scripts/gen-reference.mjs           # write the pages
//   node scripts/gen-reference.mjs --check   # fail, naming each stale page
//
// The pages are committed. Change the help text, the description or the
// default in the code, never the page; `pnpm --filter
// @powerbi-metrics-book/docs gen:reference` writes them again.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = join(SITE, "../..");
const API = join(REPOSITORY, "apps/api");
const REFERENCE = join(SITE, "src/content/docs/reference");
const REGENERATE = "pnpm --filter @powerbi-metrics-book/docs gen:reference";

function run(command, commandArguments, cwd) {
  const result = spawnSync(command, commandArguments, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0)
    throw new Error(
      `${command} ${commandArguments.join(" ")} failed: ${result.error?.message ?? result.stderr}`,
    );
  return JSON.parse(result.stdout);
}

const dumpApi = (script) =>
  run(join(API, "node_modules/.bin/tsx"), [`scripts/${script}`], API);

// ---------------------------------------------------------------------------
// Text helpers.

/** Prose goes into Markdown: `<` would open a tag, so it is written as an entity outside code spans. */
function prose(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replaceAll("<", "&lt;"),
    )
    .join("");
}

/** One line for a table cell. */
const cell = (text) =>
  prose(String(text).replace(/\s+/g, " ").trim()).replaceAll("|", "\\|") || " ";

const code = (text) => `\`${String(text).replaceAll("`", "'")}\``;

function table(head, rows) {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function page({ title, description, order, source, body }) {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    "sidebar:",
    `  order: ${String(order)}`,
    "---",
    "",
    `<!-- Generated from ${source} by scripts/gen-reference.mjs. Do not edit; change the code and run: ${REGENERATE} -->`,
    "",
    body.trim(),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// JSON Schema in a few words.

function resolveRef(document, schema) {
  if (typeof schema?.$ref !== "string") return schema;
  const name = schema.$ref.split("/").at(-1);
  return { ...document.components.schemas[name], title: name };
}

/** What a value may be, short enough for a table cell. */
function accepts(document, schema, depth = 0) {
  if (schema === undefined || schema === true) return "any value";
  if (typeof schema.$ref === "string") return schema.$ref.split("/").at(-1);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined)
    return `one of ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives !== undefined)
    return alternatives
      .map((alternative) => accepts(document, alternative, depth))
      .join(" or ");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types
    .map((type) => {
      if (type === "array")
        return `a list of ${accepts(document, schema.items, depth + 1)}`;
      if (type === "object") {
        const keys = Object.keys(schema.properties ?? {});
        return depth > 0 || keys.length === 0
          ? "an object"
          : `an object with ${keys.join(", ")}`;
      }
      if (type === "string")
        return schema.format === undefined || schema.format === "uuid"
          ? schema.format === "uuid"
            ? "a GUID"
            : "text"
          : `text (${schema.format})`;
      if (type === "integer") return numberWithBounds("a whole number", schema);
      if (type === "number") return numberWithBounds("a number", schema);
      if (type === "boolean") return "true or false";
      if (type === "null") return "null";
      return "any value";
    })
    .join(" or ");
}

function numberWithBounds(label, { minimum, maximum, exclusiveMinimum }) {
  const bounds = [];
  if (minimum !== undefined) bounds.push(`at least ${String(minimum)}`);
  if (exclusiveMinimum !== undefined)
    bounds.push(`above ${String(exclusiveMinimum)}`);
  if (maximum !== undefined) bounds.push(`at most ${String(maximum)}`);
  return bounds.length === 0 ? label : `${label}, ${bounds.join(" and ")}`;
}

/** A schema's fields as table rows: name, what it accepts, required, description. */
function fieldRows(document, schema) {
  const resolved = resolveRef(document, schema);
  const required = new Set(resolved?.required ?? []);
  return Object.entries(resolved?.properties ?? {}).map(([name, field]) => [
    code(name),
    cell(accepts(document, field)),
    required.has(name) ? "yes" : "no",
    cell(resolveRef(document, field)?.description ?? ""),
  ]);
}

// ---------------------------------------------------------------------------
// reference/cli.md

function cliCommand(command, depth) {
  const path = command.path.join(" ");
  // Every command takes --json, which the page says once at the top.
  const options = command.parameters.filter(
    (p) => p.kind === "option" && !p.flags.includes("--json"),
  );
  const argumentsOf = command.parameters.filter((p) => p.kind === "argument");
  const usage = [
    path,
    command.commands.length > 0 ? "COMMAND" : null,
    options.length > 0 ? "[OPTIONS]" : null,
    ...argumentsOf.map((a) =>
      a.required ? a.flags[0].toUpperCase() : `[${a.flags[0].toUpperCase()}]`,
    ),
  ]
    .filter((part) => part !== null)
    .join(" ");
  const parts = [
    `${"#".repeat(Math.min(depth + 1, 5))} ${code(path)}`,
    prose(command.help),
    ["```bash", usage, "```"].join("\n"),
  ];
  if (argumentsOf.length > 0)
    parts.push(
      table(
        ["Argument", "Required", "What"],
        argumentsOf.map((a) => [
          code(a.flags[0]),
          a.required ? "yes" : "no",
          cell(a.help),
        ]),
      ),
    );
  if (options.length > 0)
    parts.push(
      table(
        ["Option", "Takes", "Default", "What"],
        options.map((o) => [
          o.flags.map(code).join(", "),
          o.flag ? " " : cell(o.choices ? o.choices.join(" or ") : o.type),
          o.default === null || o.default === false ? " " : code(o.default),
          cell(o.help),
        ]),
      ),
    );
  return [
    ...parts,
    ...command.commands.map((c) => cliCommand(c, depth + 1)),
  ].join("\n\n");
}

function cliPage(root) {
  const body = [
    "Every command takes `--json`, which prints one JSON document to stdout and nothing else. Sign in with `pbmb login`, or set `PBMB_API_KEY`.",
    "",
    ...root.commands.map((command) => cliCommand(command, 1)),
  ].join("\n\n");
  const global = table(
    ["Option", "What"],
    root.parameters.map((p) => [p.flags.map(code).join(", "), cell(p.help)]),
  );
  return page({
    title: "CLI",
    description: "Every pbmb command, with its arguments and options.",
    order: 20,
    source: "the CLI's own help (apps/cli/scripts/dump_help.py)",
    body: `${prose(root.help.split("\n\n")[0])}\n\nOptions before any command:\n\n${global}\n\n${body}`,
  });
}

// ---------------------------------------------------------------------------
// Who may call: from the authorization matrix (apps/api/src/routes/authorization-matrix.ts).

/** The kinds of caller the matrix tries, as the page names them. A kind the matrix adds must be named here, so the page cannot go stale. */
const CALLER_LABELS = {
  anonymous: "no credential",
  outsider: "a signed-in person with no role on the data",
  viewer: "a viewer",
  curator: "a curator",
  admin: "an admin",
  curator_elsewhere: "a curator outside the data's audience",
  service_account: "a service account with no grant",
  service_account_granted: "a service account with a grant",
  curator_cli_token: "a curator signed in with `pbmb login`",
  curator_mcp_token: "a curator's MCP client token",
  curator_session: "a curator's browser session",
};

/** Whole sets of callers that read better as one phrase. */
const WHOLE_SETS = {
  route: [
    [
      [
        "outsider",
        "viewer",
        "curator",
        "admin",
        "curator_elsewhere",
        "service_account",
        "service_account_granted",
        "curator_cli_token",
      ],
      "Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.",
    ],
    [
      ["outsider", "viewer", "curator", "admin", "curator_elsewhere"],
      "Any signed-in person, in a browser only.",
    ],
    [["curator_mcp_token"], "An MCP client, with its OAuth token."],
  ],
  tool: [
    [
      ["outsider", "viewer", "curator", "admin", "curator_elsewhere"],
      "Any signed-in person, through an MCP client.",
    ],
  ],
};

/** The callers whose answer is allowed, in words. */
function whoMayCall(cells, kind) {
  const names = Object.keys(cells);
  const allowed = names.filter((name) => cells[name] === "allowed");
  for (const name of allowed)
    if (CALLER_LABELS[name] === undefined)
      throw new Error(
        `The authorization matrix has a caller named ${name}; name it in CALLER_LABELS in gen-reference.mjs.`,
      );
  if (allowed.length === names.length)
    return "Public: anyone, with no credential.";
  if (allowed.length === 0)
    return "Nobody once an admin exists: it answers 404. Before the first admin, only the holder of the setup link.";
  const same = (set) =>
    set.length === allowed.length &&
    set.every((name) => allowed.includes(name));
  const whole = WHOLE_SETS[kind].find(([set]) => same(set));
  if (whole !== undefined) return whole[1];
  const labels = allowed
    .filter((name) => name !== "anonymous")
    .map((name) => CALLER_LABELS[name]);
  const list = `${labels.join("; ")}.`;
  return allowed.includes("anonymous")
    ? `Public: no credential is needed. Also allowed: ${list}`
    : `${list[0].toUpperCase()}${list.slice(1)}`;
}

// ---------------------------------------------------------------------------
// reference/mcp-tools.md

function mcpPage({ instructions, tools }, authorization) {
  const sections = tools.map((tool) => {
    const document = { components: { schemas: {} } };
    const rows = fieldRows(document, tool.inputSchema);
    const cells = authorization.tools[tool.name];
    if (cells === undefined)
      throw new Error(
        `The tool ${tool.name} has no row in the authorization matrix (TOOL_MATRIX).`,
      );
    return [
      `### ${code(tool.name)}`,
      prose(tool.description),
      `Who may call it: ${prose(whoMayCall(cells, "tool"))}`,
      rows.length === 0
        ? "It takes no arguments."
        : table(["Argument", "Accepts", "Required", "What"], rows),
    ].join("\n\n");
  });
  const quoted = instructions
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${prose(line)}`))
    .join("\n");
  return page({
    title: "MCP tools",
    description: "Every tool the connector offers, with its input.",
    order: 30,
    source: "the tool registry (apps/api/scripts/dump-mcp-tools.ts)",
    body: [
      "The connector is at `/api/mcp` and takes an OAuth access token issued for it. It only reads, searches and queries; it never changes the book. A tool answers a person's data under that person's rights, so what a call returns depends on who is calling. Each tool lists the callers that get past authorization, from the same matrix as the [REST API](/docs/reference/rest-api/#who-may-call-a-route); any other caller is turned away before the tool runs.",
      "## What the server tells a client",
      "A client reads these instructions once, when it connects. The last paragraph shown here is the start of the conventions' guide in force, here the default preset's.",
      quoted,
      "## The tools",
      ...sections,
    ].join("\n\n"),
  });
}

// ---------------------------------------------------------------------------
// reference/rest-api.md

const METHODS = ["get", "post", "put", "patch", "delete"];

/** The group a route belongs to: its tag, else the first word after /api/v1, else "setup". */
function groupOf(path, operation) {
  if (operation.tags?.length > 0) return operation.tags[0];
  const [, , version, first] = path.split("/");
  return version === "v1" ? first : version;
}

/** The matrix writes a path parameter `:id` (and `:path{.+}`); OpenAPI writes `{id}`. */
const matrixKey = (method, path) =>
  `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`;

function callers(authorization, path, method) {
  const key = matrixKey(method, path);
  const cells = Object.entries(authorization.routes).find(
    ([row]) => row.replace(/\{[^}]*\}/g, "") === key,
  )?.[1];
  if (cells === undefined)
    throw new Error(
      `${key} has no row in the authorization matrix (ROUTE_MATRIX).`,
    );
  return whoMayCall(cells, "route");
}

function restRoute(document, authorization, path, method, operation) {
  const parts = [
    `### ${method.toUpperCase()} ${code(path)}`,
    prose(operation.summary ?? ""),
  ];
  parts.push(`Who may call it: ${prose(callers(authorization, path, method))}`);
  const parameters = (operation.parameters ?? []).map((parameter) => [
    code(parameter.name),
    parameter.in,
    cell(accepts(document, parameter.schema)),
    parameter.required ? "yes" : "no",
    cell(parameter.description ?? ""),
  ]);
  if (parameters.length > 0)
    parts.push(
      table(["Parameter", "In", "Accepts", "Required", "What"], parameters),
    );
  const body = operation.requestBody?.content?.["application/json"]?.schema;
  if (body !== undefined) {
    const rows = fieldRows(document, body);
    parts.push(
      rows.length > 0
        ? `Body (JSON, ${operation.requestBody.required ? "required" : "optional"}):\n\n${table(["Field", "Accepts", "Required", "What"], rows)}`
        : `Body (JSON): ${cell(accepts(document, body))}.`,
    );
  }
  const answers = Object.entries(operation.responses ?? {})
    .filter(([status]) => status.startsWith("2"))
    .map(([status, answer]) => {
      const schema = answer.content?.["application/json"]?.schema;
      return [
        status,
        cell(answer.description ?? ""),
        schema === undefined ? " " : cell(accepts(document, schema)),
      ];
    });
  parts.push(table(["Answer", "Meaning", "Shape"], answers));
  const answerFields = Object.entries(operation.responses ?? {})
    .filter(([status]) => status.startsWith("2"))
    .map(([, answer]) => answer.content?.["application/json"]?.schema)
    .find((schema) => schema !== undefined);
  const fields =
    answerFields === undefined ? [] : fieldRows(document, answerFields);
  if (fields.length > 0)
    parts.push(
      `Fields of the first answer:\n\n${table(["Field", "Accepts", "Required", "What"], fields)}`,
    );
  const failures = Object.entries(operation.responses ?? {})
    .filter(([status]) => !status.startsWith("2"))
    .map(([status, answer]) =>
      `${status} ${(answer.description ?? "").replace(/\.$/, "")}`.trim(),
    );
  if (failures.length > 0)
    parts.push(`Other answers: ${prose(failures.join("; "))}.`);
  return parts.join("\n\n");
}

function restPage(document, authorization) {
  const groups = new Map();
  for (const [path, item] of Object.entries(document.paths))
    for (const method of METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      const group = groupOf(path, operation);
      if (!groups.has(group)) groups.set(group, []);
      groups
        .get(group)
        .push(restRoute(document, authorization, path, method, operation));
    }
  const schemes = Object.entries(document.components.securitySchemes).map(
    ([name, scheme]) => [code(name), cell(scheme.description ?? "")],
  );
  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, routes]) => `## ${group}\n\n${routes.join("\n\n")}`);
  return page({
    title: "REST API",
    description: "Every route, grouped, with who may call it and its shapes.",
    order: 40,
    source: "apps/api/openapi.json",
    body: [
      prose(document.info.description),
      'The same document is at `apps/api/openapi.json` in the repository. Errors answer `{ "error": kind, "message": ... }` with the status the kind maps to. A dataset the caller may not see is answered 404, as a missing one is.',
      "## Credentials",
      table(["Credential", "What"], schemes),
      "## Who may call a route",
      "Each route lists the callers that get past authorization. Any other caller is answered 401 (no credential, or one this route does not take), 403 (a credential without the role) or 404 (the thing is not there, or not one the caller may see). The list comes from the authorization matrix, which a test holds the code to, with a real request for each caller on the sample tenant. The callers it tries:",
      table(
        ["Caller", "Means"],
        Object.keys(CALLER_LABELS).map((name) => [
          code(name),
          cell(CALLER_LABELS[name]),
        ]),
      ),
      ...sections,
    ].join("\n\n"),
  });
}

// ---------------------------------------------------------------------------
// reference/settings.md

function settingsPage({ settings, secrets }) {
  const groups = new Map();
  for (const setting of settings) {
    const group = setting.key.split(".")[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(setting);
  }
  const document = { components: { schemas: {} } };
  const sections = [...groups.entries()].map(
    ([group, entries]) =>
      `## ${code(group)}\n\n${entries
        .map((setting) =>
          [
            `### ${code(setting.key)}`,
            prose(setting.description),
            [
              `- Default: ${code(JSON.stringify(setting.default))}`,
              `- Environment variable: ${code(setting.environment_variable)}`,
              `- Accepts: ${prose(accepts(document, setting.accepts))}`,
              ...(setting.environment_only
                ? [
                    "- Set only in the environment. No admin can set it, because it says where a secret is sent.",
                  ]
                : []),
            ].join("\n"),
          ].join("\n\n"),
        )
        .join("\n\n")}`,
  );
  const secretRows = secrets.map((secret) => [
    code(secret.name),
    code(secret.environment_variable),
    secret.readers.join(", "),
  ]);
  return page({
    title: "Settings and secrets",
    description:
      "Every setting with its default and environment variable, and every secret with who reads it.",
    order: 10,
    source: "the settings registry (apps/api/scripts/dump-settings.ts)",
    body: [
      "Every setting has three ways in: the admin section, `pbmb admin settings get|set`, and an environment variable. The environment variable wins, and the admin section shows the setting as set by the environment. A key's variable is the key in upper case with each dot as an underscore, so `powerbi.tenant_id` is `POWERBI_TENANT_ID`.",
      "Saving a setting checks it against the schema shown as Accepts.",
      ...sections,
      "## Client address",
      "Two environment variables, not settings, decide which address a request counts against. `TRUSTED_PROXY` is an IP address or CIDR range (not /0), a range written by its network address, such as `10.0.1.0/24`: the api refuses to start with `10.0.1.25/24`, which would trust the whole range. Only a connection from it may name the client in `X-Forwarded-For`; when the header comes from any other connection, the api logs a line for that connection's address at most once a minute, so a proxy whose address changed shows in the log. Any connection can send the header, so look the proxy's address up rather than setting one from the log. An IPv6 range that holds all of `::ffff:0:0/96`, such as `::/64`, is refused like /0. `CLIENT_ADDRESS_HEADER` is `x-forwarded-for` (the default) or `x-real-ip`.",
      "With `x-real-ip` the api takes the client from that header alone: one value that must be an IP address, else the connection's own address counts. It ignores `X-Forwarded-For` and needs no proxy range, but it is safe only if every request comes through an edge that replaces an `X-Real-IP` the client sent. Railway's [networking page](https://docs.railway.com/networking/public-networking/specs-and-limits) documents that its edge sets the header and does not say it replaces one the client sent, so that is unconfirmed. Before relying on the mode, run `curl -H 'X-Real-IP: 192.0.2.1' -H 'Authorization: Bearer <cli token>' https://<domain>/api/v1/me`. The mode is safe only if `client_address` shows your real address, not 192.0.2.1.",
      "Anything that reaches the api without the edge defeats the mode: Railway's private network from other services, and a TCP Proxy. It is never safe behind Caddy or Traefik as configured here, because they pass a client's `X-Real-IP` through. The api refuses to start with both variables set, and refuses `source_cidrs` on a service account under `x-real-ip`.",
      "## Secrets",
      "A secret is write-only: once saved, nothing returns its value. Set one with `pbmb admin secrets set <name>`, which asks without echoing, or with the environment variable of the same name in upper case. Each secret is encrypted to the containers that read it, and only to them.",
      table(["Secret", "Environment variable", "Read by"], secretRows),
    ].join("\n\n"),
  });
}

// ---------------------------------------------------------------------------

function generate() {
  const authorization = dumpApi("dump-authorization.ts");
  return new Map([
    [
      "cli.md",
      cliPage(
        run(
          "uv",
          ["run", "python", "apps/cli/scripts/dump_help.py"],
          REPOSITORY,
        ),
      ),
    ],
    ["mcp-tools.md", mcpPage(dumpApi("dump-mcp-tools.ts"), authorization)],
    [
      "rest-api.md",
      restPage(
        JSON.parse(readFileSync(join(API, "openapi.json"), "utf8")),
        authorization,
      ),
    ],
    ["settings.md", settingsPage(dumpApi("dump-settings.ts"))],
  ]);
}

const pages = generate();
if (process.argv.includes("--check")) {
  const stale = [...pages].filter(([name, text]) => {
    const file = join(REFERENCE, name);
    return !existsSync(file) || readFileSync(file, "utf8") !== text;
  });
  for (const [name] of stale)
    console.error(`reference/${name} is stale. Regenerate it: ${REGENERATE}`);
  process.exit(stale.length === 0 ? 0 : 1);
}
for (const [name, text] of pages) writeFileSync(join(REFERENCE, name), text);
