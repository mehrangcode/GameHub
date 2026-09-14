# Design system samples — how to read these

Five art directions for the **player lobby** (`/` when logged in), built as standalone HTML.
Open `Samples/index.html` and click through. No build step, no dependencies beyond Google Fonts.

## The one thing that matters

**All five files declare the exact same token names.** Only the *values* and the surface
treatment differ:

```css
:root {
  --color-bg, --color-surface, --color-surface-raised, --color-border, --color-text,
  --color-text-muted, --color-primary, --color-on-primary, --color-accent, --color-on-accent,
  --color-success, --color-danger, --color-warning,
  --color-coin, --color-gem, --color-ticket,
  --seat-ring-active, --timer-ok, --timer-warn, --timer-danger,
  --font-display, --font-body, --font-numeric,
  --text-xs … --text-3xl, --space-1 … --space-8,
  --radius-sm, --radius-md, --radius-lg, --radius-full,
  --shadow-1, --shadow-2, --shadow-3,
  --dur-fast, --dur-base, --dur-slow, --ease
}
```

So choosing a direction is a *values* decision, not an architecture decision. Whichever you
pick, its `:root` + `[data-theme="dark"]` blocks become `frontend/src/styles/tokens.css`
and every CSS Module consumes them by name. The cosmetics/theming system in
`06-frontend-architecture.md` is runtime variable swapping — this is exactly the shape it needs.

## Constraints every sample already honours

| Rule | Where it comes from | How it shows up here |
|---|---|---|
| **Logical properties only** | CLAUDE.md hard rule, stylelint | `margin-inline-start`, `padding-block`, `inset-inline-end`, `border-start-start-radius`. No `left`/`right`/`margin-left` anywhere |
| **Full RTL is correctness** | `02-technical-prd.md` §8.1 | The **فا** button flips `dir` and swaps every string. The layout mirrors with no extra CSS |
| **No English in payloads** | `GET /games` returns `nameKey`, not "Shelem" | Every label carries `data-en` / `data-fa`; the markup holds no hardcoded copy |
| **No emoji as icons** | `ui-ux-pro-max` §4 | One inline SVG sprite per file, `<use>` referenced, `aria-hidden` on decorative ones |
| **Theme = variable swap** | cosmetics system | The ☾ button sets `data-theme` on `<html>`. Nothing else changes |
| **Reduced motion** | WCAG, skill §7 | The turn-timer ring and all transitions collapse under `prefers-reduced-motion` |
| **375px** | skill §5 | Each file is usable at small-phone width; the bento/sidebar grids stack |

## The content is deliberately domain-accurate

Every sample renders the same lobby, using real shapes from `backend/src/contracts`:

- an **active table** to resume — Shelem, a live turn deadline, a seat with **1 strike of 2**,
  a **bot-substituted** seat and a **reconnecting** seat
- the **registry-driven game grid** — six games, one `comingSoon` and therefore disabled,
  each with `playableCounts` and its `RewardRule.base` rate
- a **recent matches** list containing the case that defines this platform:
  a Shelem match on the **winning team** that paid **0 coins**, marked `EJECTED_TIMEOUT`,
  forfeited — next to a partner row that paid in full

If a direction cannot make that forfeited row read as *a published rule* rather than *a bug*,
it is the wrong direction. That row is the single hardest thing in the lobby to design.

## Picking

Tell me the number. I will then:

1. promote its tokens to `frontend/src/styles/tokens.css` with the light/dark pairs,
2. write `Documents/13-design-system.md` (scale, component specs, do/don't),
3. carry it into S39's login/register and S41's welcome page.
