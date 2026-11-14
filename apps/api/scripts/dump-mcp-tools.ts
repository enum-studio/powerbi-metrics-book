/*
 * Prints what the MCP connector announces as JSON: the server's instructions
 * and each tool's name, description and input JSON schema. The docs site
 * renders it into reference/mcp-tools.md (apps/docs/scripts/gen-reference.mjs):
 *
 *   pnpm --filter @powerbi-metrics-book/api exec tsx scripts/dump-mcp-tools.ts
 *
 * The instructions end with the conventions' guide, which a deployment can
 * change; the page shows the default preset's, the guide a new deployment
 * starts with, and a deployment on a real tenant, which has no sample
 * paragraph.
 */
import { instructionsFor } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools/index.js";
import { resolve } from "../src/services/conventions/store.js";

const tools = TOOLS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

process.stdout.write(
  `${JSON.stringify(
    {
      instructions: instructionsFor(
        resolve({ preset: "metrics_book" }).guide,
        false,
        true,
      ),
      tools,
    },
    null,
    2,
  )}\n`,
);
