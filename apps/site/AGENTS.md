# apps/site

The landing page of powerbimetricsbook.io, in Astro without Starlight. Its
build also builds the docs for the public site and copies them to
`dist/docs/`, so `dist/` is the whole site. `Dockerfile` serves it with
Caddy on Dokploy; README.md has the settings.

Spec: `docs/specs/2026-10-27-website.md`. Look: `packages/tokens`.

## Rules here

- The sections, their order and their words are settled in the spec, and
  the ones marked "Settled by inspection" were picked by Martin from
  rendered prototypes. Change the spec first, with his word, then the page.
- Every claim on the page traces to the spec's "Facts the copy relies on"
  table: the code, a generated reference page or the README. A new claim
  adds its row. No invented numbers, quotes, logos or star counts.
- Nothing on the page says an install works before 0.1 ships. README.md
  lists the places to change at the release.
- Colours, type sizes, radii and spaces come from the tokens. The landing
  page has no section eyebrows, no icons in tinted squares and no card
  grids. Motion is allowed where it shows how the product works (Martin,
  2026-10-27), and every piece of it stops under `prefers-reduced-motion`.
- Every address the page links to is in `src/links.ts`.
- The docs and the README draw the stack with `apps/docs/public/stack.svg`.
  The landing page draws its own, isometric, in `src/drawing/stack.ts`, with
  its steps in `src/components/StackStage.astro`. A change to the stack
  changes both.
- The dashboard in the internal tools section shows the sample tenant's
  real net sales by month for 2025, from `src/net-sales-2025.ts`. The hero's
  internal tool is a reorder list with the sample's real units on hand,
  from `src/stock-on-hand.ts`. If the sample's rows change, recompute them
  with `netSalesByMonth(salesRows(), 2025)`, `stockRows()` and
  `retailProductRows()` from `packages/powerbi-mock`.
- An outside number (a benchmark, a survey, a vendor's report) is opened
  and checked at its source before it goes on the page, cited with
  `src/components/Cite.astro`, and listed under Sources with who made it
  and what stake they have. A number that cannot be found at its source
  stays off the page.
- The hero drawing is drawn at build time by `src/drawing/hero.ts`, with the
  helpers in `src/drawing/iso.ts`. `src/components/HeroStack.astro` holds
  the example run, the step cycle and the colours. Change the drawing there;
  its shapes carry classes and the component's CSS colours them from the
  tokens.

## Check

```bash
pnpm --filter @powerbi-metrics-book/site build
pnpm --filter @powerbi-metrics-book/site check
node scripts/check-text.mjs apps/site
```
