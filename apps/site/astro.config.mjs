import { defineConfig } from "astro/config";

// The landing page at the root of powerbimetricsbook.io. The docs are a
// separate build (apps/docs) that scripts/build.mjs copies to dist/docs, so
// this project holds no page under /docs.
export default defineConfig({
  site: "https://powerbimetricsbook.io",
  outDir: "dist",
  trailingSlash: "always",
});
