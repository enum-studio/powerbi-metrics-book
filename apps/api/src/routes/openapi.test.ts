import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../version.js";
import { documentationApp, generateOpenApi, OPENAPI_FILE } from "./openapi.js";

/*
 * The checked-in apps/api/openapi.json is what the SPA's types are made from,
 * so it must be what the routes generate now. These tests read the routes and
 * the file only; neither starts a database.
 */

type Document = {
  info: { title: string; version: string };
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  components: {
    schemas: Record<
      string,
      { properties?: Record<string, { anyOf?: { maxLength?: number }[] }> }
    >;
    securitySchemes: Record<string, unknown>;
  };
};

const checkedIn = readFileSync(OPENAPI_FILE, "utf8");
const document = JSON.parse(checkedIn) as Document;

/** The first line where the two files part, with both lines, for a failure a person can act on. */
function firstDifference(checked: string, fresh: string): string | null {
  if (checked === fresh) return null;
  const was = checked.split("\n");
  const now = fresh.split("\n");
  const at = was.findIndex((line, index) => line !== now[index]);
  const line = at === -1 ? Math.min(was.length, now.length) : at;
  return `apps/api/openapi.json differs from the routes at line ${String(line + 1)}: it has ${JSON.stringify(was[line] ?? "(end of file)")}, the routes give ${JSON.stringify(now[line] ?? "(end of file)")}. Run pnpm --filter @powerbi-metrics-book/api openapi and commit the file.`;
}

describe("the OpenAPI file", () => {
  it("is what the routes generate now", async () => {
    const difference = firstDifference(checkedIn, await generateOpenApi());
    expect(difference, difference ?? "").toBeNull();
  });

  it("names the first difference between two files", () => {
    expect(firstDifference("a\nb\nc\n", "a\nb\nc\n")).toBeNull();
    expect(firstDifference("a\nb\nc\n", "a\nx\nc\n")).toContain(
      'line 2: it has "b", the routes give "x"',
    );
    expect(firstDifference("a\n", "a\nb\n")).toContain("line 2");
  });

  it("is titled, versioned from the package, and offers the three ways to sign in", () => {
    expect(document.info).toMatchObject({
      title: "Power BI Metrics Book",
      version: VERSION,
    });
    expect(Object.keys(document.components.securitySchemes)).toEqual([
      "session_cookie",
      "oauth_bearer",
      "api_key_bearer",
    ]);
  });

  it("describes every route under /api/v1 and the setup API", async () => {
    const { app, close } = documentationApp();
    await close();
    const described = new Set(
      Object.entries(document.paths).flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    );
    const routes = app.routes
      .filter(
        ({ method, path }) =>
          method !== "ALL" &&
          (path.startsWith("/api/v1/") || path.startsWith("/api/setup")),
      )
      // Hono's /categories/:path{.+} is OpenAPI's /categories/{path}.
      .map(
        ({ method, path }) =>
          `${method} ${path.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, "{$1}")}`,
      );
    expect(routes.length).toBeGreaterThan(100);
    expect(
      [...new Set(routes)].filter((route) => !described.has(route)).sort(),
    ).toEqual([]);
    for (const route of [
      "PUT /api/v1/admin/secrets/{name}",
      "DELETE /api/v1/admin/grants/{id}",
      "POST /api/v1/admin/import",
      "POST /api/setup/steps/address",
    ])
      expect(described, route).toContain(route);
  });

  it("resolves every $ref to a named component, and keeps the admin answers named", () => {
    const named = new Set(Object.keys(document.components.schemas));
    const refs = [...checkedIn.matchAll(/"\$ref": "([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/"), ref).toBe(true);
      expect(named, ref).toContain(ref.replace("#/components/schemas/", ""));
    }
    for (const id of [
      "Error",
      "AdminSecret",
      "AdminNewApiKey",
      "AdminServiceAccount",
    ]) {
      expect(named, id).toContain(id);
      expect(refs, id).toContain(`#/components/schemas/${id}`);
    }
  });

  it("gives a secret's answer and a key's list no field that could hold a value or a key", () => {
    const { AdminSecret, AdminApiKey, AdminNewApiKey } =
      document.components.schemas;
    expect(Object.keys(AdminSecret?.properties ?? {})).not.toContain("value");
    expect(AdminSecret?.properties?.hint?.anyOf?.[0]?.maxLength).toBe(4);
    expect(Object.keys(AdminApiKey?.properties ?? {})).not.toContain("key");
    expect(Object.keys(AdminNewApiKey?.properties ?? {})).toContain("key");
  });
});
