import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateSpecs } from "hono-openapi";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AppDeps } from "../context.js";
import { createDb, createPool } from "../db/client.js";
import { createLogger } from "../log.js";
import { VERSION } from "../version.js";

/*
 * The OpenAPI file, generated from the app's routes and checked in at
 * apps/api/openapi.json, where the SPA's types come from. `pnpm --filter
 * @powerbi-metrics-book/api openapi` writes it; openapi.test.ts and the
 * merge gate fail when the checked-in file differs from a fresh generation.
 */

export const OPENAPI_FILE = fileURLToPath(
  new URL("../../openapi.json", import.meta.url),
);

/** Building the routes reads no database, setting or secret, so a call to any of these is a mistake. */
const refuses = (what: string) => (): never => {
  throw new Error(
    `The OpenAPI generator called ${what}; it only reads the routes.`,
  );
};

function documentationDeps(): AppDeps {
  const url = "postgres://documentation@localhost/documentation";
  const config = loadConfig(
    {
      PUBLIC_BASE_URL: "https://metrics.example.com",
      DATABASE_URL: url,
      MIGRATOR_DATABASE_URL: url,
      AUDIT_DATABASE_URL: url,
      AUTH_SECRET: "documentation-only-not-a-secret-0000",
      CERBOS_URL: "http://localhost:3592",
      GIT_SHA: "0000000",
      LOG_LEVEL: "error",
      NODE_ENV: "test",
    },
    "api",
  );
  // A pool connects when it is first used, which nothing here does.
  const pool = createPool(url);
  return {
    container: "api",
    pool,
    db: createDb(pool),
    auditDb: createDb(pool),
    config,
    logger: createLogger("error", () => {}),
    clock: () => new Date(0),
    fetcher: {
      fetchFixed: refuses("fetcher.fetchFixed"),
      fetchUntrusted: refuses("fetcher.fetchUntrusted"),
    },
    settings: {
      get: refuses("settings.get"),
      set: refuses("settings.set"),
      source: refuses("settings.source"),
      list: refuses("settings.list"),
    },
    secrets: { read: refuses("secrets.read") },
    access: {
      check: refuses("access.check"),
      require: refuses("access.require"),
      reachableDatasets: refuses("access.reachableDatasets"),
      describableDatasets: refuses("access.describableDatasets"),
      readableQueryLog: refuses("access.readableQueryLog"),
      readableRequests: refuses("access.readableRequests"),
      readableSearchLog: refuses("access.readableSearchLog"),
    },
    vault: {
      recipient: "",
      seal: refuses("vault.seal"),
      open: refuses("vault.open"),
    },
  };
}

/** The app as the document is read from, and the pool to end when done with it. */
export function documentationApp() {
  const deps = documentationDeps();
  return { app: createApp(deps), close: () => deps.pool.end() };
}

/** The document as it is checked in: two-space JSON and a final newline. */
export async function generateOpenApi(): Promise<string> {
  const { app, close } = documentationApp();
  try {
    const specs = await generateSpecs(app, {
      documentation: {
        openapi: "3.1.0",
        info: {
          title: "Power BI Metrics Book",
          version: VERSION,
          description:
            "The REST API of Power BI Metrics Book. Every route checks its own credential.",
        },
        components: {
          securitySchemes: {
            session_cookie: {
              type: "apiKey",
              in: "cookie",
              name: "__Secure-better-auth.session_token",
              description:
                "A browser session. A request that changes anything must come from the site's own origin.",
            },
            oauth_bearer: {
              type: "http",
              scheme: "bearer",
              description:
                "An OAuth access token for scope api, from `pbmb login` or an MCP client's grant.",
            },
            api_key_bearer: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "pbmb_sk_",
              description: "A service account's API key.",
            },
          },
        },
        security: [
          { session_cookie: [] },
          { oauth_bearer: [] },
          { api_key_bearer: [] },
        ],
      },
    });
    return `${JSON.stringify(specs, null, 2)}\n`;
  } finally {
    await close();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeFile(OPENAPI_FILE, await generateOpenApi());
}
