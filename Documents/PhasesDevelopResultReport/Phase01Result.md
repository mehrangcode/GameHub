Phase A (S01–S06) of M0 is built and green.

What shipped

S01 — Backend scaffold · backend/, Node 22 ESM, Express 5, TS strict + noUncheckedIndexedAccess, Zod-validated env that exits on a bad value, GET /health, full folder skeleton per 02 §4. The three architecture guards are in eslint.config.js and proven to fire — tests/unit/lint-guards.test.ts lints real source text at real paths for each of them, including the case where the domain/games/\*\* block would silently drop guard 1 by replacing the rule options.

S02 — Frontend scaffold · Vite 6 + React 19 + React Router 7, ws:true on the socket proxy, all 13 routes + 404 as placeholders, stylelint with stylelint-plugin-logical-css (the guard test actually lints margin-left and expects a rejection).

S03 — Contracts · backend/src/contracts/ as canonical: the TS unions + Zod schemas that replace Prisma enums, the error taxonomy, the socket event maps. sync-contracts.ts stamps the DO-NOT-EDIT header and a SHA-256; contracts:check fails and names the file in both projects; pre-commit hook installed at .githooks/.

S04/S05 — Prisma schema · All 28 models. Every constraint that carries weight is proven by a failing insert: (tableId, seat), (tableId, userId), (tableId, guestSessionId), two spectators coexisting, (gameId, seq), (gameId, clientMoveId), (walletId, idempotencyKey), providerEventId. Portability and money-type tests parse the schema as text — no enum, no scalar list, no Decimal, no @db., and exactly one Float in the whole file.

S06 — Seed · Idempotent by construction, proven by running it twice. Includes the ejected-winner fixture: rank 1, on the winning team, coinsAwarded: 0, with a zero-amount CAP_REJECTED ledger row explaining why — while their partner is paid in full.

backend 90 tests · typecheck · lint — all green
frontend 18 tests · typecheck · lint · stylelint — all green

Three things you should know

1. provider = env("DATABASE_PROVIDER") does not work. Prisma rejects it (P1012 — "a datasource must not use the env() function in the provider argument"). 02-technical-prd.md §6.1 assumes it does. I kept the intent — one canonical schema, DATABASE_PROVIDER as the single switch — by having scripts/prisma-provider.mjs rewrite that one line, run first by every db:\* script. The alternative, a SQLite copy and a Postgres copy, would drift the first time a column is added in a hurry. I corrected 02 §6.1 and 11 S04 and recorded the reasoning in both.

2. Port 3000 is occupied on this machine by another Express process — it answers with X-Powered-By: Express, which our app disables. I verified /health, /api/v1/health, and the :3000/admin/\* → 404 assertion on PORT=3999. Free the port or set PORT in backend/.env before the curl step.

3. Playwright can't launch a browser here — Chromium downloaded fine, but the OS is missing libnspr4/libnss3 and installing them needs sudo. Config and smoke spec are committed; run sudo npx playwright install-deps chromium in frontend/, then npx playwright test. This is the one S02 done-when box I could not close.

I left every checkbox in plan.md unticked — those are yours to tick after the "You verify" pass. The full command list is in .claude/context/build/context.md, which also records the smaller decisions (entrypoint is main.ts per 02 §4, not server.ts; reward variants as sudoku:race/chess:rapid rows; Vitest 3 because Vitest 2 pins a second Vite that breaks the config typecheck).

Commit message when you're ready:

feat(m0): scaffold backend and frontend through Phase A (S01–S06)

Backend: Express 5 + TS strict scaffold, Zod-validated env, /health, and the
three architecture lint guards with deliberate-violation tests. Frontend: Vite

- React Router scaffold with all 13 routes and logical-CSS enforcement.
  Contracts mirror with a SHA-256 drift guard in both projects and a pre-commit
  hook. Full Prisma schema with the load-bearing unique constraints proven by
  failing inserts, plus an idempotent seed carrying the ejected-winner fixture.

Prisma rejects env() in datasource.provider (P1012), so DATABASE_PROVIDER now
drives the literal via scripts/prisma-provider.mjs; 02 §6.1 corrected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
