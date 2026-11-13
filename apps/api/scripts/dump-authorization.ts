/*
 * Prints the authorization matrix as JSON: for every route and every
 * connector tool, the answer each kind of caller gets. The docs site reads it
 * for "who may call it" in reference/rest-api.md and reference/mcp-tools.md
 * (apps/docs/scripts/gen-reference.mjs):
 *
 *   pnpm --filter @powerbi-metrics-book/api exec tsx scripts/dump-authorization.ts
 *
 * authorization_matrix_security_test.ts holds the code to the matrix, so the
 * pages say what the code does.
 */
import {
  ROUTE_CALLERS,
  ROUTE_MATRIX,
  TOOL_CALLERS,
  TOOL_MATRIX,
} from "../src/routes/authorization-matrix.js";

process.stdout.write(
  `${JSON.stringify(
    {
      route_callers: ROUTE_CALLERS,
      routes: ROUTE_MATRIX,
      tool_callers: TOOL_CALLERS,
      tools: TOOL_MATRIX,
    },
    null,
    2,
  )}\n`,
);
