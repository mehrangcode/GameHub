# Live Context — read this first, every session

**Last updated:** 2026-09-08

## Where we are

| | |
|---|---|
| **Milestone** | M0 — Platform Skeleton |
| **Last session completed** | **S01–S06 (Phase A) built and green — not yet verified by Mehrang** |
| **Next session** | **S07 — Value objects, entities, `AppError` taxonomy** (2.5 h, 🧪) |
| **Blocked on** | Nothing in code. Two environment items need Mehrang (below) |
| **Repo state** | `backend/` and `frontend/` exist. 90 backend tests, 18 frontend tests, all green. No `admin-frontend/` (MA) |

Session spec for S07: `Documents/11-build-plan.md` §4.

## Session start protocol

1. Read this file.
2. Read the next session's spec in `Documents/11-build-plan.md`.
3. State the session id, its goal, and its **You verify** steps to Mehrang **before writing code**.
4. Build + test. Report real test output.
5. Mehrang runs the "You verify" steps himself. That is the gate.
6. Tick the boxes in `plan.md`, update this file, hand over a conventional commit message.
7. **Mehrang commits.** Never commit on his behalf.

## Phase A — what to verify (the gate for S01–S06)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 90 tests
npm run dev                                             # then in another terminal:
curl -s localhost:3000/health                           # → {"ok":true,"version":"0.1.0"}

# the guards must reject these:
echo "import {PrismaClient} from '@prisma/client'" > src/domain/_probe.ts && npm run lint
echo "export const x = Math.random()" > src/domain/games/_probe.ts && npm run lint
rm src/domain/_probe.ts src/domain/games/_probe.ts

npm run contracts:sync && npm run contracts:check       # exit 0
echo "// tampered" >> ../frontend/src/contracts/index.ts
npm run contracts:check                                 # exit 1, names index.ts
(cd ../frontend && npm run contracts:check)             # exit 1 here too
npm run contracts:sync                                  # green again

npm run db:reset && npm run db:studio                   # ~28 models; RewardRule shelem = 80,
                                                        # _global caps; MatchParticipant has an
                                                        # EJECTED_TIMEOUT row, coinsAwarded 0,
                                                        # rewardForfeited true, on the WINNING team
npm run seed                                            # run twice — counts unchanged

cd ../frontend && npm run typecheck && npm run lint && npm test && npm run dev
# click through / /login /register /play /customize /store /wallet /premium /profile
# /t/abc /table/abc /games/x /matches/1 and /nope (→ 404 page)
# browser console, backend running:  await fetch('/api/v1/health').then(r=>r.json())
```

## Two things Mehrang needs to do

| | |
|---|---|
| **Port 3000 is occupied** on this machine by *another* Express process (it answers with `X-Powered-By: Express`, which our app disables). Our server was verified on `PORT=3999`. Free the port or set `PORT` in `backend/.env` | before the S01 curl step |
| **Playwright browsers can't launch** — Chromium downloaded, but the OS is missing `libnspr4`/`libnss3`. Run `sudo npx playwright install-deps chromium` in `frontend/`, then `npx playwright test` | before ticking S02 |

Everything else — Vitest, ESLint, stylelint, Prisma, the seed — runs clean.

**`node_modules` is installed for Linux (WSL).** Committing works from either OS now that the hook
needs only `node`, but `npm run dev`, `test`, `lint` and the Prisma CLI must be run **from WSL** —
`tsx`, `esbuild`, the Prisma engines and `argon2` are all native or `.bin`-resolved and have no
Windows shims. If you ever want the toolchain on the Windows side too, that needs its own
`npm install` from a Windows shell (and a separate `node_modules`, so pick one and stay there).

## Decisions made while building Phase A (2026-09-08)

| Decision | Value | Why |
|---|---|---|
| **`provider = env("DATABASE_PROVIDER")` does not work** | `scripts/prisma-provider.mjs` rewrites the literal from `DATABASE_PROVIDER`; every `db:*` script runs it first | Prisma rejects `env()` in the provider argument (P1012). One canonical schema with one machine-managed line beats a SQLite copy and a Postgres copy that would drift. `02-technical-prd.md` §6.1 and `11-build-plan.md` S04 corrected |
| Entrypoint is `main.ts`, not `server.ts` | `src/main.ts` | `11-build-plan.md` S01 said `server.ts`; `02` §4 (the authority) says `main.ts` |
| `/health` mounted twice | bare `/health` **and** `/api/v1/health` | Compose healthchecks want the bare path; the Vite proxy only forwards `/api`, and S02's verification step curls the prefixed one |
| Reward variants get their own rule rows | `sudoku` + `sudoku:race`, `chess` + `chess:rapid` | `10` §3.2 gives two base rates for those games but `RewardRule.id` is free-form and `gameSlug` is a separate column, so a `slug:variant` id needs no schema change. S35 looks up `${slug}:${variant}` then falls back to `${slug}` |
| `placementJson` shape | `{ draw: 1, bySeatCount: { "4": { "1": 1.5, … } } }` | Lets the seed test assert ranks `1..seatCount` are covered for every declared seat count |
| A `fixture` RewardRule is seeded | base 5 | The M0 `_fixture` engine (S30) needs a rule to exercise settlement before a real game exists |
| **`contracts:sync`/`check` is `sync-contracts.mjs`, not `.ts`** | plain node, no `tsx` | It runs from the pre-commit hook. `tsx` resolves through `node_modules/.bin`, which is platform-specific — committing from a Windows client against a WSL-installed `node_modules` finds no `tsx.cmd`, and the hook then reports "contract drift" for what is really a missing binary. The hook now calls `node` on the scripts directly, checks `node` is on PATH first, and says *"contracts:check failed"* rather than asserting drift. `02` §4/§4.1, `11` S03 and `12` §8.2 corrected |
| Vitest 3, not 2 | both projects | Vitest 2 pins its own Vite 5 beside the project's Vite 6, and the two `Plugin` types don't unify — `vite.config.ts` fails to typecheck |
| argon2id lives in `infrastructure/auth/password.ts` now | small forward slice of S11 | The seed has to hash the admin password. S11 adds config-driven params and the rehash path |
| `AdminCredential` / `AdminSession` / `AdminAuditLog` **not** in the schema yet | S48 | `03` §3.1 lists them on `User`, but they are Phase L. Their `User` back-relations get added with the models |
| `SecurityEvent[]` added to `User` | not in `03` §3.1 | Prisma requires both sides of a relation; the doc's `SecurityEvent.user` had no counterpart |
| `db:reset` keeps `--force-reset` | user-run only | Prisma refuses that flag when it detects an AI agent. The test harness deletes `prisma/test.db` and plain-`db push`es instead |

## Decisions from planning (2026-09-08, unchanged)

| Decision | Value | Why |
|---|---|---|
| Session length | 2–3 focused hours | Mehrang's realistic evening budget |
| **Admin console specified** | `Documents/12-admin-console.md`; M0 grows **Phase L (S48–S50)**, M2 +1, M3 +1, new milestone **MA** between M7 and M8 | Same codebase / separate entrypoint on an unpublished `:3100`; separate admin session with mandatory TOTP; append-only audit row in the same transaction as the mutation; admin sees only the spectator projection |
| **MA is a letter, not M9** | Between M7 and M8 | Avoids renumbering M8 and invalidating every cross-reference |
| Plan depth | M0 in full detail; M1–M8 as outlines | Detailing M4 now would be fiction |
| **`_fixture` engine added to M0** | `domain/games/_fixture/`, dev/test registry only | M0's ejection exit criterion is untestable without a game, and Sudoku is M1 |
| Session ends green or unfinished | No 80%-done carry-forward | Same rule `08-roadmap.md` applies to games |

## Open questions inherited from the specs

| Question | Needed by | Documented default | Status |
|---|---|---|---|
| `db push` vs dual migration folders for dev (`03` §8) | S04 | `db push` for dev, real migrations for Postgres only | **Resolved by building it that way.** `db:push` for dev/test; `prisma/migrations/` stays Postgres-only and is generated in S46 |
| `ejectAfterStrikes`: 2 (spec default) or 1 (Mehrang's literal rule) (`04` §6.3) | **S32** | 2, as a table option — set to 1 for the strict rule | Open |
| Should coins be purchasable for real money? (`10` §6.5) | M7 | No — coins earn-only, money buys the subscription | Open |
| Shelem: match target, all-pass rule, point-card discards (`games/shelem.md` §0.4) | M4-S01 | Unsourced; a real match will settle them | Open |
| Reward rates, prices, caps, multipliers (`10` §3–4) | S06 seeds them | A starting guess; all live in `RewardRule` rows | **Seeded.** `sudoku` `expectedMinMs` (2 min) is the one number with no source in `10` — invented, worth a look |
| `SUPPORT` role — ever used by a solo operator? (`12` §12) | MA | Ship the role + RBAC matrix, seed only `ADMIN` | Open |
| Admin chat visibility (`12` §12) | MA | Report-scoped and audited | Open |
| Account deletion / anonymization (`12` §12) | Not v1 | Anonymize, never `DELETE` | Open |
| Audit-log retention (`12` §12) | Later | Indefinite; the hash chain makes pruning need a checkpoint | Open |
| Alerting channel for `SecurityEvent` and ledger drift (`12` §12) | MA | None in v1 — console only | Open |

## Notes for next session

- **S07 needs no new dependencies.** `domain/value-objects/`, `domain/entities/`,
  `domain/errors/`, and `domain/games/shared/rng.ts` are all pure. The error-taxonomy table test
  should read its rows from `contracts/errors.ts`, which already carries the `ERROR_CODES` union.
- `git config core.hooksPath` is now `.githooks`, installed by `backend/scripts/install-hooks.mjs`.
  The pre-commit hook runs `contracts:check` in every project that has `node_modules`.
- `backend/requests/*.http` is still empty — it starts in S10 and every later session's
  verification leans on it.
- `scripts/dev-socket.ts` (S23) is the verification tool for S23–S38. Budget time to make it
  genuinely pleasant to use.
- **S15 changed:** it builds the `SecurityEvent` recorder and the metrics registry but exposes
  **no HTTP route**. `/metrics` and `/security-events` move to the admin process in S49. The
  "no `/admin` on `:3000`" assertion already exists in `tests/integration/health.test.ts` and must
  survive every later session.
- **A fourth ESLint guard lands in S48** — the ban on `interface/admin/**` imports from the public
  app. It gets the same deliberate-violation proof `tests/unit/lint-guards.test.ts` uses for the
  other three.
- M0 is not closed at S47 — **S50 is the gate**, because two of M0's exit criteria are admin
  criteria.
