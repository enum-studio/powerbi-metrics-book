import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import type { AppEnv } from "../app.js";
import type { AppDeps } from "../context.js";
import { readLogo, readLogoMetadata } from "../services/admin/branding.js";

const LOGO = "/api/branding/logo";
const LOGO_CSP = "default-src 'none'; sandbox";
const MAX_LOGO_BYTES = 262144;

/** Outside the global security headers, so the logo keeps its own CSP: an image that runs nothing. */
export const logoContentSecurityPolicy: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.path === LOGO) c.header("Content-Security-Policy", LOGO_CSP);
};

/** Ahead of authentication and the global 1 MiB limit: a logo over 256 KB is refused before more of it is read. */
export const logoBodyLimit: MiddlewareHandler = bodyLimit({
  maxSize: MAX_LOGO_BYTES,
  onError: (c) =>
    c.json(
      { error: "invalid", message: "The logo is larger than 256 KB." },
      413,
    ),
});

/** The public brand image, read only from the stored bytes. */
export function brandingRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get(
    "/api/branding/logo",
    describeRoute({
      summary: "Read the brand logo",
      responses: {
        200: { description: "The stored image" },
        304: { description: "The image has not changed" },
        404: { description: "No logo is set" },
      },
    }),
    async (c) => {
      c.header("X-Content-Type-Options", "nosniff");
      const logo = await readLogoMetadata(deps);
      if (logo === null) return c.notFound();
      const etag = `"${logo.sha256}"`;
      c.header("ETag", etag);
      c.header("Cache-Control", "public, max-age=300");
      const matches = c.req
        .header("If-None-Match")
        ?.split(",")
        .map((tag) => tag.trim().replace(/^W\//, ""));
      if (matches?.some((tag) => tag === "*" || tag === etag))
        return c.body(null, 304);
      const stored = await readLogo(deps, logo.sha256);
      // Replaced since the first read: the headers above name the old image.
      if (stored === null) {
        c.header("Cache-Control", "no-store");
        return c.notFound();
      }
      return c.body(Buffer.from(stored.bytes), 200, {
        "Content-Type": logo.content_type,
      });
    },
  );
  return routes;
}
