Everything is green. Here's where Phase J landed.

What's built

All six sessions, S39–S44, plus three things the plan assumed existed and didn't.

┌─────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Session │ Delivered │
├─────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ S39 │ api/client.ts with single-flight refresh + CSRF echo, resource modules, authStore, login/register built on the same Zod schemas the server validates with │
├─────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ S40 │ Aurora Glass tokens.css, self-hosted fonts, themeStore (the only DOM writer), en/fa across 5 namespaces, real RTL, Persian numerals + Jalali dates │
├─────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ S41 │ Registry-driven welcome page + /games/:slug, with the public rate card │
├─────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ S42 │ One-socket manager, socketStore with handshake clock offset, gameStore/tableStore/chatStore/walletStore/uiStore │
├─────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ S43 │ /t/:inviteCode — unauthenticated, one field, one button; guest join, returning-guest and signed-in paths │
├─────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ S44 │ TableShell — seat map, presence, chat, countdown ring, ejection panel with live reclaim, reward summary, signup nudge │
└─────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Results

- 1707/1707 backend tests · 154/154 frontend (was 18) · typecheck, ESLint, stylelint clean · builds at 150 kB gzip entry chunk
- Postman: 94 requests, 134 assertions, 0 failures against a live API

Three gaps in the build plan I had to fill

1. GET/PUT /me/preferences didn't exist — S40 says "wired". Built it at level U (a guest has no row; their choices ride in on the claim). 10 tests.
2. No signed-in path through an invite — resolve withholds tableId from everyone, correctly, which left a user with no way in except becoming a guest and stranding their coins. Added POST /invites/:code/redeem. 10 tests.
3. ZOD_ISSUE_KEYS lived behind the REST boundary — moved to contracts/ so the browser renders the same refusal the server would.

Two bugs the tests caught in my own code

- The redeem route consumed an invite use, guarded by an "already a member?" check that never fires — membership comes from the socket, not REST. A user refreshing the invite page would have burned two uses of a maxUses: 2 link. Now it consumes none, with ★★ consumes NO invite use pinning it.
- formatNumber rounded reward multipliers, rendering a 1.5× premium as "×2" — the breakdown contradicting the total it exists to explain.

What needs you

- I did not commit. Message ready below.
- I did not run db:reset — Prisma's guardrail asks for explicit consent, and I won't destroy data without it. Newman ran against your existing dev DB and passed; say the word if you want a reset + re-run.
- Playwright still can't launch (libnspr4/libnss3): sudo npx playwright install-deps chromium. The J2 journey spec is written and unrun — it also needs a live API, which playwright.config.ts doesn't start yet.
- frontend/node_modules is now WSL-owned, but I unpacked the win32 esbuild/rollup binaries alongside, so npm test runs from both OSes.
- One pre-existing flake: ejection.test.ts failed once under full-suite parallel load, passed 12/12 alone and in the final full run. It's the real-time waitFor poll, not a regression.

feat(frontend): Phase J — Axios, i18n/RTL, welcome, sockets, invite landing, TableShell (S39–S44)

Adopt design direction 04 "Aurora Glass" and build the whole frontend phase on it.

- S39 single-flight refresh interceptor; authStore; login/register on the shared
  contracts/ Zod schemas, with server-identical localized messages
- S40 tokens.css from sample 04, self-hosted font subsets, themeStore as the sole
  DOM writer, en+fa across 5 namespaces, RTL, Persian numerals and Jalali dates
- S41 registry-driven welcome page and game detail, with the public rate card
- S42 one-socket manager, clock-offset store, game/table/chat/wallet/ui stores
- S43 unauthenticated invite landing, guest join, returning-guest and user paths
- S44 TableShell: seats, presence, chat, countdown ring, ejection, reward summary

Backend gaps the plan assumed were filled:

- add GET/PUT /me/preferences (level U) and POST /invites/:code/redeem (level U)
- move ZOD_ISSUE_KEYS into contracts/ so both sides render the same refusal

Fixes found by the new tests:

- redeem consumed an invite use behind a guard that could never fire
- formatNumber rounded reward multipliers, showing a 1.5x premium as "x2"

1707 backend tests, 154 frontend tests, Postman 94/134 green.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
