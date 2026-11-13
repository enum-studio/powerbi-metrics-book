import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// One group per part, each read from its folder under src/content/docs, so a
// page added there shows in the sidebar without a change here. Pages order
// themselves by `sidebar.order` in their front matter.
const PARTS = [
  ["Start", "start"],
  ["Set up", "set-up"],
  ["Deploy", "deploy"],
  ["Use", "use"],
  ["Make it yours", "make-it-yours"],
  ["Security", "security"],
  ["Reference", "reference"],
];

// Set by apps/site's build: the docs as powerbimetricsbook.io serves them, with
// the site's address and the extras in src/site.ts. Unset, the build is the
// copy the api serves inside every deployment.
const PUBLIC_SITE = process.env.PBMB_DOCS_SITE === "1";

export default defineConfig({
  ...(PUBLIC_SITE ? { site: "https://powerbimetricsbook.io" } : {}),
  // The api serves dist at /docs (apps/api/src/http/docs.ts).
  base: "/docs",
  outDir: "dist",
  trailingSlash: "always",
  // The Start folder's opening page is the front page, at the root.
  redirects: { "/start": "/docs/" },
  integrations: [
    starlight({
      title: "Power BI Metrics Book",
      // The tile, served by src/pages/favicon.svg.ts.
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/enum-studio/powerbi-metrics-book",
        },
      ],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        Banner: "./src/components/Banner.astro",
      },
      sidebar: PARTS.map(([label, directory]) => ({
        label,
        items: [
          // The Start part's opening page has the slug "index" (its front
          // matter), so it is the site's front page at /docs/ and the folder
          // no longer holds it.
          ...(directory === "start" ? [{ slug: "index" }] : []),
          { autogenerate: { directory } },
        ],
      })),
    }),
  ],
});
