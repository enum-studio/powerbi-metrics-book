# packages/tokens

`@enum-studio/tokens`: the one look Power BI Metrics Book and Metrics Book
share. It implements Enum Studio's brand (one mark, Inter and IBM Plex
Mono, the bottle green `#1f4a3a`, dark green `#8fc1a6` on `#0b0d0f`) as
CSS custom properties. It is built here, in its final shape, until it moves
to a home of its own; moving it is a move and a publish.

## What is here

- `tokens.css`: the light values on `:root`; the dark values under
  `prefers-color-scheme: dark` and `[data-theme="dark"]`.
- `theme.css`: Tailwind 4 `@theme`, mapping the tokens to utilities.
- `fonts.css`: Inter (variable, with its optical-size axis) and IBM Plex
  Mono, self-hosted.
- `mark.svg` (`currentColor`) and `tile.svg`, the favicon tile.
- `contrast.test.ts`: every text pair at 4.5:1 or more, in both themes.

## Rules here

- The type sizes, the 4px spacing scale and the shell widths come from the
  planner's `tokens.css` and carry over as they are. The radius was changed
  on purpose (`docs/decisions/look.md`).
- A product sets only its name beside the mark, nothing else of its own.
  A colour or size one product needs is a token for both, or it is not
  added.
- A change to the look is one pull request here and one version bump in
  each product. It is never patched in an app's own CSS.
- No font, image or script from a third-party host.

## Check

```bash
pnpm --filter @enum-studio/tokens test
```
