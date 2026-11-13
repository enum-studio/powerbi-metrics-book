import { z } from "zod";

/**
 * JSON-RPC 2.0, which is what MCP speaks over its Streamable HTTP transport.
 *
 * Small enough to own outright. The official SDK brings a transport layer this
 * route has no use for: the server never pushes anything, so there is no
 * stream to hold open and no session id to keep, and one POST carrying one
 * message (or a small batch) is the whole conversation.
 */

export type JsonRpcId = string | number;

/** A request when it carries an `id`, a notification when it does not. */
export const JSON_RPC_MESSAGE = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcMessage = z.infer<typeof JSON_RPC_MESSAGE>;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId | null;
      error: { code: number; message: string; data?: unknown };
    };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export const replyWith = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

export const replyError = (
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
