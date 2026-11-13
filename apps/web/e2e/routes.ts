import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** A value for each path parameter a route may have, from the sample tenant. */
const SAMPLE_PARAMS: Record<string, string> = {
  // The draft the first sync makes from Net sales and its period variants, which no e2e test takes.
  name: "net_sales",
  id: "d1000000-0000-4000-8000-000000000005",
  term: "Channel",
  table: "Order lines",
  column: "Order date",
  _splat: "sales",
  folder: "Sales",
};

/** Every route's path, read from the router itself so a screen's new route is checked without a list to update. */
async function routePaths(): Promise<string[]> {
  const vite = await createServer({
    root: WEB,
    logLevel: "error",
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const loaded: unknown = await vite.ssrLoadModule("/src/router.tsx");
    return pathsBelow(
      typeof loaded === "object" && loaded !== null
        ? Reflect.get(loaded, "routeTree")
        : undefined,
    );
  } finally {
    await vite.close();
  }
}

/** Each route's path, joined as the router joins them (fullPath is set only once a router starts). */
function pathsBelow(route: unknown, parent = ""): string[] {
  if (typeof route !== "object" || route === null)
    throw new Error("src/router.tsx exports no route tree");
  const options: unknown = Reflect.get(route, "options");
  const own: unknown =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "path")
      : undefined;
  const full =
    typeof own !== "string"
      ? parent
      : own === "/"
        ? parent || "/"
        : `${parent}/${own.replace(/^\/+|\/+$/g, "")}`;
  const children: unknown = Reflect.get(route, "children");
  const below =
    typeof children === "object" && children !== null
      ? Object.values(children).flatMap((child) =>
          pathsBelow(child, full.replace(/\/$/, "")),
        )
      : [];
  return typeof own === "string" ? [full, ...below] : below;
}

function withSamples(path: string): string {
  return path.replace(/\$(\w+)|\$(?=\/|$)/g, (_, name: string | undefined) => {
    const key = name ?? "_splat";
    const value = SAMPLE_PARAMS[key];
    if (value === undefined)
      throw new Error(
        `Add a sample value for $${key} to SAMPLE_PARAMS in e2e/routes.ts`,
      );
    return encodeURIComponent(value);
  });
}

/** Every route in src/router.tsx, with sample values in its parameters. */
export async function sampleRoutes(): Promise<string[]> {
  return (await routePaths()).map(withSamples);
}
