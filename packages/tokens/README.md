# @enum-studio/tokens

The look Power BI Metrics Book and Metrics Book share: Enum Studio's brand as CSS custom properties, a Tailwind 4 theme, two self-hosted fonts and the mark. It implements `docs/brand.md` in the enumstudio repository. The light palette, type scale, spacing, radius and shell widths are the Metrics Book planner's; the dark values are the admin's dark theme (bottle green `#8fc1a6` on `#0b0d0f`).

A product sets only its name beside the mark and nothing else of its own.

## Files

| Import                           | What it holds                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@enum-studio/tokens/tokens.css` | Every token on `:root`, light by default. The dark values apply under `prefers-color-scheme: dark` unless the root has `data-theme="light"`, and always under `data-theme="dark"`. |
| `@enum-studio/tokens/theme.css`  | A Tailwind 4 `@theme inline` block that maps the tokens to utilities.                                                                                                              |
| `@enum-studio/tokens/fonts.css`  | Inter (variable, weights 100 to 900, optical sizing left to the browser) and IBM Plex Mono 400 and 500, from the `@fontsource` packages. No page loads a font from a third party.  |
| `@enum-studio/tokens/mark.svg`   | The line mark, drawn in `currentColor`.                                                                                                                                            |
| `@enum-studio/tokens/tile.svg`   | The favicon tile: the mark in paper on bottle green.                                                                                                                               |

## Use it with Tailwind 4

```css
@import "tailwindcss";
@import "@enum-studio/tokens/fonts.css";
@import "@enum-studio/tokens/tokens.css";
@import "@enum-studio/tokens/theme.css";
```

Utilities are named after their token, with one exception: `--font-text` is `font-sans`. Tailwind's own palette, type sizes, radii and shadows are removed, so `bg-red-500` and `text-xs` do not exist:

| Token                                                                                       | Utilities                                                                           |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `--bg`, `--surface`, `--raised`, `--canvas`, `--accent-soft`                                | `bg-bg`, `bg-surface`, `bg-raised`, `bg-canvas`, `bg-accent-soft`                   |
| `--ink`, `--ink-2`, `--ink-3`, `--accent`, `--out`, `--on-accent`                           | `text-ink`, `text-ink-2`, `text-ink-3`, `text-accent`, `text-out`, `text-on-accent` |
| `--line`, `--line-strong`, `--line-control`                                                 | `border-line`, `border-line-strong`, `border-line-control`                          |
| `--accent-hover`, `--select`, `--scrim`                                                     | `bg-accent-hover`, `bg-select`, `bg-scrim`                                          |
| `--type-title`, `--type-heading`, `--type-body`, `--type-ui`, `--type-meta`, `--type-label` | `text-title`, `text-heading`, `text-body`, `text-ui`, `text-meta`, `text-label`     |
| `--font-text`, `--font-mono`                                                                | `font-sans` (Inter, and the page's default face), `font-mono`                       |
| `--space-1` (4px)                                                                           | the spacing scale: `p-3` is `--space-3`, and every step stays on the 4px grid       |
| `--radius`, `--radius-sheet`                                                                | `rounded`, `rounded-sheet`                                                          |
| `--shadow`, `--shadow-sheet`                                                                | `shadow`, `shadow-sheet`                                                            |

The shell widths (`--rail-width`, `--tree-width`, `--tree-width-min`, `--tree-width-max`, `--assistant-width`, `--page-min`, `--bar-height`, `--read-max`, `--page-max`, `--measure`) have no utility. Use `w-(--rail-width)`.

## Use it without Tailwind

Import `fonts.css` and `tokens.css`, and read tokens as `var(--ink)`, `var(--type-ui)` and so on.

## Light and dark

With no `data-theme` on the root, the reader's system setting decides. A product with a theme toggle sets `data-theme="light"` or `data-theme="dark"` on `<html>`. Every colour token has a dark value, and `contrast.test.ts` fails if one is missing, if the two dark blocks differ, or if a text pair falls under 4.5:1 in either theme (a field's edge, `--line-control`, under 3:1).

## The mark and the favicon

`mark.svg` takes the text colour of its page only when it is inline: `<img src>` always draws it black. In Vite, `import mark from "@enum-studio/tokens/mark.svg?raw"` gives the markup to inline. The brand's rule: ink on paper, paper on the green or the dark ground, 15 to 18px in a bar, never smaller than 14px.

`tile.svg` is the favicon, identical in every Enum Studio repository and needing no dark variant. Link it from the page head as `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`, with the file copied from this package at build time and never edited.

## Changing the look

A change to the look is one pull request here and one version bump of `@enum-studio/tokens` in each product. Change `docs/brand.md` in the enumstudio repository in the same change when the brand itself moves. A new token needs a reason both products share, written as a comment in `tokens.css`.

## Tests

`pnpm --filter @enum-studio/tokens test` parses `tokens.css` and measures every text pair in light and in both dark blocks.
