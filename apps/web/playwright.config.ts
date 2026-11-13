import { defineConfig, devices } from "@playwright/test";
import { devStackUrl } from "./e2e/fixtures.ts";

/** The widths and themes every UI flow runs at. */
export const SIZES = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
export const SCHEMES = ["light", "dark"] as const;
/** The tag in a test's title that makes it run once, in the "once" project. */
const ONCE = /@once/;
/** Shared tenant writes run alone after every other spec project. */
const TENANT = /@tenant/;
/** The setup's first run, which needs a stack with no admin yet (dev-stack.mjs up --no-setup). */
const FIRST_RUN = /setup\.spec\.ts$/;
const SIZE_PROJECTS = SIZES.flatMap(({ width }) =>
  SCHEMES.map((scheme) => `${String(width)}-${scheme}`),
);
const DESKTOP = {
  ...devices["Desktop Chrome"],
  viewport: SIZES[1],
  colorScheme: "light" as const,
};

/**
 * Against the dev stack (pnpm dev:up), whose api serves the built SPA: each
 * flow at a phone's width and a desktop's, in light and dark. The sessions
 * project signs in once per role first, and the specs start from those
 * sessions (e2e/fixtures.ts, signedInAs).
 */
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/e2e",
  forbidOnly: true,
  reporter: process.env.CI === undefined ? "list" : "dot",
  use: { baseURL: devStackUrl(), trace: "retain-on-failure" },
  projects: [
    { name: "sessions", testMatch: /sessions\.setup\.ts$/, use: DESKTOP },
    ...SIZES.flatMap((viewport) =>
      SCHEMES.map((colorScheme) => ({
        name: `${String(viewport.width)}-${colorScheme}`,
        grepInvert: [ONCE, TENANT],
        testIgnore: FIRST_RUN,
        dependencies: ["sessions"],
        use: { ...devices["Desktop Chrome"], viewport, colorScheme },
      })),
    ),
    // Tests that count against a limit per address run once after the sizes/themes.
    {
      name: "once",
      grep: ONCE,
      grepInvert: TENANT,
      testIgnore: FIRST_RUN,
      dependencies: SIZE_PROJECTS,
      use: DESKTOP,
    },
    {
      name: "tenant",
      grep: TENANT,
      testIgnore: FIRST_RUN,
      dependencies: ["sessions", ...SIZE_PROJECTS, "once"],
      fullyParallel: false,
      workers: 1,
      use: DESKTOP,
    },
    // Separate because it needs a stack with no admin, where every other project needs dev:up's; scripts/e2e.ts runs it first with PBMB_E2E_FIRST_RUN=1.
    ...(process.env.PBMB_E2E_FIRST_RUN === "1"
      ? [{ name: "first-run", testMatch: FIRST_RUN, use: DESKTOP }]
      : []),
  ],
});
