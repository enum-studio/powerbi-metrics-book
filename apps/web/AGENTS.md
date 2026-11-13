# apps/web

The React SPA, served by the api at `/`: a person's next steps, the first-run
setup, the admin section, sign-in, the OAuth consent, the device confirmation,
a person's connections, and the review page where a person approves a metric.
The book itself is browsed by agents and the CLI in v1.

Standards: `docs/standards/typescript.md` (The SPA). Look:
`packages/tokens`. Design rules: start each screen from its references in
the spec (The look, Screens in v1).

## Where things go

- `src/router.tsx`: one import and one entry per screen's route module.
- `src/routes/`: one module per screen (`setup.tsx`, `review-metric.tsx`).
- A folder per area for its parts (`src/home/`, `src/setup/`, `src/admin/`,
  `src/review/`, `src/access/`).
- `src/catalog/`: `tree/`, `categories/`, `metrics/`, `terms/`, `datasets/`, `search/` and `diagram/`.
- `e2e/`: Playwright flows, one spec per area.

## Rules here

- `src/catalog/diagram/` takes a neutral model and imports nothing from `src/api`.
- A test that changes what every other test can see is tagged `@tenant`, runs alone after the rest, and restores what it changed.
- Every datum comes from `/api/v1` through TanStack Query, typed from the
  api's OpenAPI file. The SPA keeps no data of its own, decides no
  permission, and shows nothing an API call could not.
- Colours, type, spacing and radius come from `@enum-studio/tokens`
  through Tailwind 4. No value that is not a token.
- No `dangerouslySetInnerHTML`. Thread bodies and descriptions are shown as
  text, never rendered as HTML. Scripts from self only, as the CSP says.
- A secret field is write-only: it sends a value and shows back only what
  the API shows (set, last four characters, by whom, expiry, check).
- The consent screen names the person, the client and the redirect host,
  and says what the client will and will not be able to do.
- The Approve button on the review page is the one place `human_verified`
  is set; it works in a browser session only.
- On the mock tenant every screen carries the "Sample data" band.
- Each failed check says in words what is wrong and the one thing to
  change, in the same words as the docs' setup guide.

The setup, consent, sign-in, connections and home screens are on the auth
boundary: a change gets the security review in `docs/security/agents.md`,
rule 3.

## Check

```bash
pnpm --filter @powerbi-metrics-book/web exec tsc --noEmit
pnpm --filter @powerbi-metrics-book/web exec vitest run
pnpm --filter @powerbi-metrics-book/web exec playwright test e2e/setup.spec.ts
```

UI flows run against the api on the mock tenant, in light and dark, at 390
and 1440 px.
