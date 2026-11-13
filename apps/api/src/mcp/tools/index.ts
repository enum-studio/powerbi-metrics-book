import type { Tool } from "../registry.js";
import { conventionsTools } from "./conventions.js";
import { findTools } from "./find.js";
import { queryTools } from "./query.js";
import { readTools } from "./read.js";
import { talkTools } from "./talk.js";
import { usageTools } from "./usage.js";
import { whoamiTools } from "./whoami.js";

/**
 * Every tool the connector offers. A group of tools is one module in this
 * folder, exporting its `Tool[]`, added here with one line;
 * connector_surface_security_test.ts then checks its names and what it
 * imports.
 */
export const TOOLS: readonly Tool[] = [
  ...findTools,
  ...readTools,
  ...conventionsTools,
  ...queryTools,
  ...talkTools,
  ...usageTools,
  ...whoamiTools,
];
