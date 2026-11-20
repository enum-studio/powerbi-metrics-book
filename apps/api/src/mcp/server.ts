import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { AppDeps, ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { logError } from "../http/error-log.js";
import type { Principal } from "../principal.js";
import { requirePrincipal } from "../services/auth/principal.js";
import { onTheMock } from "../services/auth/sign-in-config.js";
import { getConventionsForAgents } from "../services/conventions/service.js";
import { VERSION } from "../version.js";
import * as rpc from "./protocol.js";
import type { Tool } from "./registry.js";
import { TOOLS } from "./tools/index.js";

/**
 * MCP's Streamable HTTP transport, in its stateless form: one POST carries
 * one JSON-RPC message, or a batch, and gets one JSON reply. The server
 * initiates nothing, so it offers no stream and issues no session id.
 *
 * Newest first. A client asking for a revision this does not know gets the
 * newest one back, which is what the spec asks a server to do rather than
 * failing the handshake.
 */
const PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const SERVER_INFO = {
  name: "powerbi-metrics-book",
  title: "Power BI Metrics Book",
  version: VERSION,
};

/**
 * Keeps one request from becoming hundreds of database round trips. The body
 * on MCP requests is held to 1 MiB before this route reads it (bodySizeLimit, in
 * http/security-headers.ts).
 */
const BATCH_LIMIT = 20;
const BATCH = z.array(rpc.JSON_RPC_MESSAGE).min(1).max(BATCH_LIMIT);

const INITIALIZE = z.object({ protocolVersion: z.string() });
const TOOL_CALL = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});

/**
 * Said once, at initialize, and read from the conventions in force, so a
 * change to the guide reaches the next connection.
 */
async function instructions(context: ServiceContext): Promise<string> {
  const { guide } = await getConventionsForAgents(context);
  const sample = onTheMock(await context.settings.get("powerbi.authority"));
  return instructionsFor(
    guide,
    sample,
    await context.settings.get("questions.enabled"),
  );
}

/**
 * The instructions for a guide, for whether the stack runs on the sample
 * tenant and for whether questions are on, which is all they depend on
 * besides this text. The docs' dump of the connector
 * (scripts/dump-mcp-tools.ts) passes the default preset's guide, false and
 * true, so a new input fails to compile there.
 */
export function instructionsFor(
  guide: string,
  sample: boolean,
  questions: boolean,
): string {
  return [
    ...(sample
      ? [
          "This deployment runs on the invented sample tenant. Every name and number is sample data, not the company's; say so when you report one.",
        ]
      : []),
    "This connector is the company's metrics book over its Power BI: the workspaces, datasets and measures you may see, and the metrics, terms and categories filed on top of them. The sync and curators draft metrics, so a book may be mostly drafts. trust_state draft means not verified, and an edit through a token returns a metric to draft. agent_verified was set through a token, by an agent or a person; only human_verified was approved by a person in a browser. whoami counts the metrics in each state. The connector reads, searches and queries, and never changes a definition." +
      (questions
        ? " Its thread tools post, reply, upvote and accept on your own question, and none changes a metric, term or category."
        : ""),
    "Search the book before you write DAX: a metric's variant usually holds the measure to use. Queries run with your own Power BI rights, and a result stays on the server: read its preview, then page with read_query_result or take a CSV link, rather than pulling every row into your context. When usage.capture is on, your searches and the requests you record are kept for the number of days in usage.retention_days, and you and the company's curators can read them; whoami gives the current values.",
    `${openingOf(guide)} Call get_conventions for the rest.`,
  ].join("\n\n");
}

/** About what one paragraph of the guide needs; get_conventions has the rest. */
const OPENING_LIMIT = 1000;

/**
 * The guide's first paragraph, up to the first blank line. Every client
 * reads it at initialize, and an admin writes it, so it is bounded: cut at
 * the last sentence that ends within the limit, or at the limit itself when
 * no sentence does.
 */
function openingOf(guide: string): string {
  const opening = guide.trim().replace(/\n\s*\n[\s\S]*$/, "");
  if (opening.length <= OPENING_LIMIT) return opening;
  const head = opening.slice(0, OPENING_LIMIT + 1);
  const ends = [...head.matchAll(/[.!?](?=\s)/g)]
    .map(({ index }) => index)
    .filter((index) => index < OPENING_LIMIT);
  const last = ends.at(-1);
  return last === undefined
    ? `${head.slice(0, OPENING_LIMIT - 3).trimEnd()}...`
    : head.slice(0, last + 1);
}

type Call = {
  context: ServiceContext;
  tools: readonly Tool[];
  request_id: string;
};

async function availableTools(call: Call): Promise<readonly Tool[]> {
  const questions = await call.context.settings.get("questions.enabled");
  return call.tools.filter((tool) => tool.requires === undefined || questions);
}

async function dispatch(
  call: Call,
  message: rpc.JsonRpcMessage,
): Promise<rpc.JsonRpcResponse | null> {
  const { id } = message;
  // A notification. Nothing to answer, including when the method is unknown.
  if (id === undefined) return null;

  switch (message.method) {
    case "initialize": {
      const asked = INITIALIZE.safeParse(message.params);
      return rpc.replyWith(id, {
        protocolVersion:
          asked.success &&
          PROTOCOL_VERSIONS.includes(asked.data.protocolVersion)
            ? asked.data.protocolVersion
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: await instructions(call.context),
      });
    }
    case "ping":
      return rpc.replyWith(id, {});
    case "tools/list": {
      const tools = await availableTools(call);
      return rpc.replyWith(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    }
    case "tools/call": {
      const asked = TOOL_CALL.safeParse(message.params);
      if (!asked.success)
        return rpc.replyError(
          id,
          rpc.INVALID_PARAMS,
          "Name the tool to call, and give its arguments.",
        );
      const tools = await availableTools(call);
      const tool = tools.find(({ name }) => name === asked.data.name);
      if (tool === undefined)
        return rpc.replyError(
          id,
          rpc.INVALID_PARAMS,
          `There is no tool named ${JSON.stringify(asked.data.name)}. Call tools/list.`,
        );
      return rpc.replyWith(
        id,
        await tool.call(call.context, asked.data.arguments ?? {}),
      );
    }
    default:
      return rpc.replyError(
        id,
        rpc.METHOD_NOT_FOUND,
        `This server has no method ${message.method}.`,
      );
  }
}

/**
 * One message's reply. A tool's ServiceError is already its answer, so what
 * arrives here is a bug: logged as app.ts logs one (logError), and answered
 * with a fixed sentence and the request id.
 */
async function reply(
  call: Call,
  message: rpc.JsonRpcMessage,
): Promise<rpc.JsonRpcResponse | null> {
  try {
    return await dispatch(call, message);
  } catch (error) {
    const tool = TOOL_CALL.safeParse(message.params);
    logError(call.context.logger, "mcp message failed", error, {
      request_id: call.request_id,
      method: message.method,
      tool: tool.success ? tool.data.name : null,
    });
    return rpc.replyError(
      message.id ?? null,
      rpc.INTERNAL_ERROR,
      `The server could not answer ${message.method}. Quote request ${call.request_id} to whoever runs it.`,
    );
  }
}

/**
 * The connector takes only an OAuth access token issued for /api/mcp
 * (authenticate checks its audience, scope and grant). A session cookie or
 * an API key also yields a principal, so the channel is checked here.
 */
function connectorPrincipal(c: Context<AppEnv>): Principal {
  const principal = requirePrincipal(c);
  if (principal.via !== "mcp")
    throw new ServiceError(
      "unauthenticated",
      "Connect an MCP client: this path takes only an OAuth access token issued for it.",
    );
  return principal;
}

/** POST /api/mcp, mounted by createApp; a test passes its own tools. */
export function mcpRoutes(
  deps: AppDeps,
  tools: readonly Tool[] = TOOLS,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post("/", async (c) => {
    const call: Call = {
      context: {
        ...deps,
        principal: connectorPrincipal(c),
        signal: c.req.raw.signal,
      },
      tools,
      request_id: c.get("request_id"),
    };
    // An answer names one person's data, so no cache keeps it.
    c.header("Cache-Control", "no-store");
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      const notJson = "The request body is not JSON.";
      return c.json(rpc.replyError(null, rpc.PARSE_ERROR, notJson), 400);
    }
    const messages = BATCH.safeParse(Array.isArray(body) ? body : [body]);
    if (!messages.success) {
      const shape = `Send one JSON-RPC 2.0 message, or an array of 1 to ${String(BATCH_LIMIT)}.`;
      return c.json(rpc.replyError(null, rpc.INVALID_REQUEST, shape), 400);
    }

    // One after another, so a batch costs what its messages would sent singly.
    const replies: rpc.JsonRpcResponse[] = [];
    for (const message of messages.data) {
      const replied = await reply(call, message);
      if (replied !== null) replies.push(replied);
    }
    // Notifications only: accepted, with nothing to say back.
    if (replies.length === 0) return c.body(null, 202);
    return c.json(Array.isArray(body) ? replies : replies[0]);
  });
  // Checked first, so an unsigned caller learns nothing about what lives
  // here. This server pushes nothing, so GET opens no stream, and it keeps
  // no session, so DELETE has nothing to end.
  routes.on(["GET", "PUT", "PATCH", "DELETE"], "/", (c) => {
    connectorPrincipal(c);
    c.header("Allow", "POST");
    const stateless =
      "This MCP server keeps no stream or session: POST a JSON-RPC message.";
    return c.json({ error: "method_not_allowed", message: stateless }, 405);
  });
  return routes;
}
