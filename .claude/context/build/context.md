# Live Context — read this first, every session

**Last updated:** 2026-09-09

## Where we are

| | |
|---|---|
| **Milestone** | M0 — Platform Skeleton |
| **Last session completed** | **S01–S16 (Phases A + B + C) built and green — not yet verified by Mehrang** |
| **Next session** | **S17 — game registry + `GET /games`, `/games/:slug`** (2 h, 🌐) — starts Phase D, Tables & invites |
| **Blocked on** | Nothing in code. **`npm install` must be re-run from Windows** (below), plus the two older environment items |
| **Repo state** | `backend/` and `frontend/` exist. **561 backend tests**, 18 frontend tests, all green. No `admin-frontend/` (MA) |

Session spec for S17: `Documents/11-build-plan.md` §6.

## ⚠ Do this first: `npm install` from Windows

Phase C added four dependencies — `jose`, `helmet`, `cors`, `cookie-parser` — and they were installed
**from WSL**, which swapped `esbuild`/`rollup` to their Linux builds. The suite therefore runs from
WSL as the tree stands, not from Windows.

```powershell
cd backend; npm install; npm run db:generate
```

That one command picks up the new packages *and* swaps the native binaries back. See the
one-`node_modules` note further down for why this keeps happening.

`frontend/` is untouched by Phase C apart from the regenerated `src/contracts/` mirror — its
`typecheck` and `contracts:check` are green (both pure JS), but its **18 Vitest tests were not
re-run**: that tree is Windows-installed, so `rollup` cannot load from WSL. Run
`cd frontend; npm test` from Windows to confirm they are still green.

## Phase C — what to verify (the gate for S11–S16)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 561 tests

# S11 — the primitives, in isolation. Two assertions carry the session:
#   "stored refresh token is a hash — the raw value appears nowhere in the row"
#   "★ a guest token for table A does not verify against table B"
npx vitest run tests/unit/auth --reporter=verbose

# S12 — the boundary. Read the names: no coercion, no unknown keys, i18n keys
#       everywhere, and a 429 that says when to come back.
npx vitest run tests/integration/boundary.test.ts tests/integration/csrf.test.ts \
  tests/unit/rate-limiter.test.ts --reporter=verbose

# S13/S14/S16 — the flows.
npx vitest run tests/integration/auth-register-login.test.ts \
  tests/integration/auth-refresh.test.ts tests/integration/auth-guest.test.ts --reporter=verbose
#   Read: "★ replaying a revoked token kills the family, including the live token",
#         "★ two parallel refreshes leave exactly one live token in the family",
#         "★ refuses another table with 403 — and audits it".

# S15 — the audit trail, and the absence of a route for it.
npx vitest run tests/integration/security-events.test.ts tests/unit/metrics.test.ts \
  --reporter=verbose

# ── Live. Port 3000 is occupied on this machine (see below). ────────────────
npm run db:reset          # SEEDDEMO invite + the demo tables
PORT=3999 npm run dev
```

`backend/requests/auth.http` walks the whole flow from your editor and explains each block. The
`curl` equivalents, in order:

```bash
API=localhost:3999/api/v1

# S13
curl -sc /tmp/c.txt -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"correct-horse-battery","displayName":"Mehrang"}' | jq
curl -sb /tmp/c.txt $API/auth/me | jq                       # → your identity, cookie only
curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"another-one","displayName":"Dup"}' | jq   # → 409 EMAIL_TAKEN
# then in Studio: exactly ONE user, ONE preferences row, THREE wallets (all VESTED),
# the DEFAULT cosmetics, and ONE RefreshToken. The 409 left nothing behind.

# S14 — the point of the session
cp /tmp/c.txt /tmp/old.txt
curl -sb /tmp/c.txt -c /tmp/c.txt -X POST $API/auth/refresh | jq
curl -si -b /tmp/old.txt -X POST $API/auth/refresh | head -1   # → 401 TOKEN_REUSED
curl -si -b /tmp/c.txt  -X POST $API/auth/refresh | head -1     # → 401 too: the family died
# → an ALERT-severity BAD_TOKEN row in SecurityEvent

# S16
curl -sc /tmp/g.txt -X POST $API/auth/guest -H 'content-type: application/json' \
  -d '{"inviteCode":"SEEDDEMO","displayName":"Sara"}' | jq
curl -sb /tmp/g.txt $API/auth/me | jq                          # → {"kind":"guest","tableId":"seed-table-fixture"}
curl -si -b /tmp/g.txt $API/_probe/table/seed-table-fixture | head -1     # → 200
curl -s  -b /tmp/g.txt $API/_probe/table/seed-table-blackjack | jq        # → 403 GUEST_TABLE_BINDING
# → an ALERT SEAT_IMPERSONATION row, and a PROVISIONAL COIN wallet on the guest

# S12
curl -s -X POST $API/_probe -H 'content-type: application/json' -d '{}' | jq
curl -s -X POST $API/_probe -H 'content-type: application/json' -d '{"n":"5"}' | jq   # not coerced
curl -s -X POST $API/_probe -H 'content-type: application/json' -H 'Origin: https://evil.test' \
  -d '{"n":5}' | jq                                            # → 403 ORIGIN_MISMATCH
for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}\n" $API/no-such-route; done \
  | sort | uniq -c                                             # → 404s then 429s
curl -sI localhost:3999/health | grep -i -E 'x-frame|content-security|x-content-type|pending'
#   the last one must print NOTHING for x-pending-middleware — every slot is filled now

# S15
curl -si $API/metrics | head -1                                # → 404, deliberately
curl -si localhost:3999/admin/api/v1/users | head -1           # → 404, permanently
npm run db:studio    # SecurityEvent: RATE_LIMIT, BAD_TOKEN (ALERT), SEAT_IMPERSONATION, INVITE_ABUSE
```

**The one thing to look hardest at:** `fieldErrors` values are i18n keys (`errors.field.tooSmall`,
`errors.passwordTooShort`), never English sentences. Zod's own wording stays in the server log.

## Phase B — what to verify (the gate for S07–S10)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 392 tests

# S07 — read the test names; two matter most: seeded RNG is reproducible,
#       and the error table matches 02 §5.6 row for row.
npx vitest run tests/unit/errors.test.ts tests/unit/rng.test.ts tests/unit/card.test.ts --reporter=verbose

# S08 + S09 — the SAME contract suite against the fakes and against SQLite.
#       Every assertion appears twice: [in-memory] … and [prisma] …
#       182 = 91 × 2. If the counts ever differ, a fake is lying.
npx vitest run tests/unit/repositories --reporter=verbose
npx vitest run tests/integration/unit-of-work.test.ts --reporter=verbose
#       Read: "rolls back BOTH writes when the second one throws",
#             "two simultaneous claims for one seat: exactly one wins",
#             "two simultaneous credits with the same key pay exactly once".

# S10 — the live server. Port 3000 is occupied on this machine (see below).
PORT=3999 npm run dev
curl -s localhost:3999/health | jq                      # → {"ok":true,...}
curl -si localhost:3999/ready | head -1                 # → 200
curl -s localhost:3999/api/v1/ready | jq                # → checks.database.ok true
curl -si localhost:3999/admin/api/v1/users | head -1    # → 404
# watch the dev console while you curl: every line carries a requestId,
# and nothing prints a raw cookie.
# then break the DB and watch /ready tell the truth:
DATABASE_URL="file:./nope.db" PORT=3999 npm run dev
curl -si localhost:3999/ready | head -1                 # → 503
curl -si localhost:3999/health | head -1                # → 200, still alive

# backend/requests/health.http runs from your editor (REST Client / JetBrains).
```

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

### ⚠ One `node_modules`, one platform — currently **Windows** (2026-09-09)

**Whichever OS last ran `npm install` owns the tree.** Committing works from either OS now that the
hook needs only `node`, but `npm run dev`, `test` and `lint` run **only on the install platform**.
The blocker is native binaries, which no amount of code can fix:

| Package | Platform-swapped by `npm install` | Currently installed |
|---|---|---|
| `esbuild` (via `tsx`, `vitest`) | `@esbuild/linux-x64` ⟷ `@esbuild/win32-x64` | **win32** — WSL `vitest` dies in `rollup/dist/native.js` |
| `rollup` (via `vitest`) | `rollup-linux-x64-gnu` ⟷ `rollup-win32-x64-*` | **win32** |
| `@prisma/engines` (the CLI's schema engine) | downloads per host | **both** `schema-engine-windows.exe` and `-debian-openssl-3.0.x` are present |
| `.prisma/client` (the query engine) | **baked in by `prisma generate`, not by install** | **both** — see `binaryTargets` below |
| `argon2` | ships prebuilds for every platform | ✅ both |

So: run the suite from **Windows** as the tree stands. To move the toolchain to WSL, re-run
`npm install` from WSL — that swaps esbuild/rollup back and costs nothing else, because the Prisma
client is now dual-target either way.

**`prisma generate` is the trap, and it is now disarmed.** The generated client at
`node_modules/.prisma/client` carries a *host-specific* query engine, so generating from WSL and
then testing from Windows failed every DB-touching test with `could not locate the Query Engine for
runtime "windows"` (122 failures, 2026-09-09) — while `vitest` itself and `prisma db push` worked,
which is what made it look like a test bug rather than a toolchain one. `prisma/schema.prisma` now
pins `binaryTargets = ["native", "windows", "debian-openssl-3.0.x"]`, so one `generate` emits both
engines. **After any `npm install` or schema change, re-run `npm run db:generate`** — install can
wipe `.prisma/client`, and a client generated before this pin has the one engine only.

What *is* fixed: nothing in the repo depends on `node_modules/.bin` shims any more. The pre-commit
hook (S178), `contracts:sync`/`check`, the test global setup and the seed test all spawn
`node <resolved cli.js>` — see `tests/bin.ts`. So the failure you get from Windows is now an honest
"missing Prisma engine for this platform" rather than a misleading `ENOENT` on `npx`.

## Decisions made while building Phase C (2026-09-09)

| Decision | Value | Why |
|---|---|---|
| **Refresh tokens are opaque, not JWTs** | 32 random bytes; access tokens are HS256 JWTs via `jose` | S11's brief says "sign … refresh tokens", but `07` §5.3 specifies an opaque random value and is right: rotation, family revocation and reuse detection all need server state anyway, so a self-describing refresh token buys nothing and costs revocability |
| JWT library is **`jose`** | not `jsonwebtoken` | ESM-native, zero dependencies, and its `JWTExpired` error is what makes "expired" distinguishable from "forged" — which is the distinction the client acts on |
| **The refresh cookie's path is `/api/v1/auth`**, one segment wider than the spec | `07` §5.3 asks for `/api/v1/auth/refresh` | `POST /auth/logout` must *read* the refresh cookie to revoke its family; with the narrower path, logout could not end the session it is asked to end. The intent ("not sent with every request") holds |
| Refresh token hash is **peppered** | `hmac256(token, JWT_REFRESH_SECRET)`, not bare sha256 | A 256-bit random token is already preimage-safe, so this is not load-bearing — it costs one line and means a stolen database alone cannot confirm a guessed token. Also gives `JWT_REFRESH_SECRET` a real job. Trade: rotating that secret logs everyone out |
| Guest token format is **`g1.<b64(tableId)>.<nonce>.<hmac>`** | stored as `sha256(token)` | Lets a cross-table use be rejected **before any database hit**, and means the binding is asserted twice independently (signed token + non-nullable `GuestSession.tableId`) |
| **CSRF = Origin check + double-submit, with the token demanded only when `Origin`/`Referer` is present** | no env flag | `07` §5.4's double-submit, implemented, plus OWASP's primary Origin defence. A client with no `Origin` is not a browser, has no ambient cookie jar to ride, and therefore has no CSRF to prevent — so every `curl` step in the build plan works while a hostile page gets 403, with *identical* behaviour in dev and prod. `Origin: null` (sandboxed iframe) counts as a mismatch, not as absent |
| **Our own sliding-window limiter behind `IRateLimiter`** | `application/ports/rateLimiter.ts` + `infrastructure/rateLimit/slidingWindow.ts` | `11` S12 says "behind the same interface" for the S27 Redis swap. Sliding, not fixed-window: a fixed window permits 2× the intended burst at the boundary. Also gives exact control of `retryAfterMs`. `express-rate-limit` not installed |
| `/health` and `/ready` are **exempt from the global limiter** | `skip` option | An orchestrator polling every 5 s must not be able to exhaust our budget and take the instance out of rotation by itself |
| **`EMAIL_TAKEN` (409) added to `ERROR_CODES`** | + `EmailTakenError` | A taken email is not a malformed request, and the form renders it under the email field. `02` §5.6 now tables it with Phase B's four extras |
| **The unique constraint decides uniqueness** | `IUserRepository.create` throws `EmailTakenError`; no `findByEmail` pre-check in `AuthService.register` | A read-then-write uniqueness test is wrong under concurrency. Same discipline as `claimSeat`; the contract suite holds the fake and Prisma to it |
| **`IRefreshTokenRepository.revokeIfActive`** added | conditional `updateMany where { id, revokedAt: null }` | `findByTokenHash` then `revoke` cannot express an atomic claim — under Postgres READ COMMITTED both racers read the same active row. This is what makes two parallel refreshes produce one winner and one retriable 401 instead of a forked family. **Not** the reuse path: a replay is caught earlier, on a token already revoked at lookup time |
| **A replay always kills the family — no grace window** | even one second after rotation | A grace window would break S14's own verify step, and "contain a stolen cookie" is the entire point. The cost is that a client without single-flight refresh can log itself out; that is why S39 has the interceptor |
| Auth primitives reach `AuthService` through **three ports** | `IPasswordHasher`, `ITokenIssuer`, `IGuestTokenIssuer` in `application/ports/auth.ts`, adapters in `infrastructure/auth/adapters.ts` | `application/` may not import `infrastructure/` (guard 1). Side benefit: the auth *flow* is testable without 50 ms of argon2 per case |
| **`authenticate` reads the user from the database every request** | one indexed PK lookup | Baking identity into the JWT would let a **banned** player keep full access for the token's remaining 10 minutes and a renamed player keep their old name. Both have tests |
| An **expired** access token leaves cookies alone; an **invalid** one clears them + `BAD_TOKEN` | in `authenticate` | Clearing on expiry would log everyone out every ten minutes; not clearing on a forged cookie leaves the browser retrying forever |
| A guest hitting a **U**-level route is **403, not 401** | `requireUser` | 401 means "refresh and retry", which a guest can never win. 403 is the truth and renders as "sign up to do this" |
| **`fieldErrors` values are i18n keys** | `errors.field.*`, or the schema's own `errors.*` message | Caught live: Zod's defaults ("Expected number, received string") are rendered English prose in front of a Persian reader — the exact failure the `code` + `i18nKey` contract exists to prevent. Zod's wording is kept in the logged `message` |
| `SecurityEventService.record` is **fire-and-forget and never throws** | `recordAndWait` returns `false` on loss | An audit failure must not fail the audited request — a monitoring outage would become a game outage. Deliberate contrast with admin `withAudit` (`12` §10), where the row *is* the accountability |
| `MetricsRegistry` is **not** Prometheus | named counters + gauges + `snapshot()` | One process, no scraper. A client library now would be infrastructure for an audience of one; the shape is what an exporter would read anyway |
| **`ACCESS_TOKEN_TTL_SEC` default 900 → 600** | `.env.example` too | `07` §5.3 says 10 minutes. A stateless token cannot be revoked, so its TTL *is* the revocation lag |
| **`ARGON2_TIME_COST` floor is 2, not 1** | env `.min(2)` | argon2 itself rejects `t=1` — discovered by a test that tried to build a deliberately weak hash |
| Guests get a **COIN wallet only** | not one per asset | Gems and tickets are not earnable, so a guest has no use for those wallets. Users get all three, all `VESTED` |
| **`GET /api/v1/_probe/table/:tableId`**, dev-only | `interface/http/routes/probe.routes.ts` | S16's central property (`403` + audit row for a cross-table guest) is otherwise unverifiable until `/tables/:id` lands in S18. Same middleware, same outcome. **Delete it in S18** |
| `placeholders.ts` **deleted** | all seven stubs replaced | A test now asserts `x-pending-middleware` is absent, so the header cannot quietly come back |
| `express.json` errors become **400, not 500** | `translateBodyParserError` in `errorHandler` | Malformed JSON and an oversized body are plainly bad requests; as opaque 500s they read as "the server is broken" |
| Display-name policy is in **`application/policies/`**, shape rules in `contracts/` | `assertDisplayNameAllowed` / `assertPasswordAcceptable` | A blocklist in the client bundle is both a bypass hint and a published list of slurs. Length and character rules go in contracts so the S39 form enforces them too. `i`/`l`/`1`/`!` fold onto one letter so `Adm1n`, `Admln` and `Admin` all collide |

## Decisions made while building Phase B (2026-09-09)

| Decision | Value | Why |
|---|---|---|
| **Four extra error codes got HTTP statuses the spec never gave them** | `ILLEGAL_PHASE_TRANSITION` 409, `INSUFFICIENT_FUNDS` 409, `CAP_REJECTED` 429, `SEAT_NOT_RECLAIMABLE` 409 | `02` §5.6 tables only the nine REST errors; these four surface mainly as socket acks. `INSUFFICIENT_FUNDS` is deliberately **not** 402 — coins are earned, never bought (`10` §6.5), and 402 would imply the purchasable currency we refuse to have. Recorded in the docblock of `domain/errors/errors.ts` |
| A class exists for **every** member of `ERROR_CODES`, including `INTERNAL` | 14 classes | Lets `tests/unit/errors.test.ts` assert the mapping is *total*: a code added to `contracts/errors.ts` without a class fails the build |
| **One contract suite, a harness array** | `tests/harnesses.ts` exports `REPO_HARNESSES`; contract files are `describe.each(REPO_HARNESSES)` | S09's only edit to the suite was appending `prismaHarness()` — 91 assertions became 182 with zero changes to a single expectation. That is the property that makes the fakes trustworthy |
| Repositories grouped by aggregate, not one file per interface | `identity.ts`, `tables.ts`, `games.ts`, `economy.ts` in both `domain/repositories/` and `infrastructure/prisma/repositories/` | Six navigable files beat fifteen 40-line ones; still one class per interface, which is what S08's "done when" asks |
| `IGameEventRepository` and `ISecurityEventRepository` do **not** extend `IRepository` | No `update`, no `delete` | An append-only log with an update method is not an append-only log. The type system should say so |
| `IWalletRepository` exposes **no** way to set `balance` | `append()` is the only mutation | E1 says the cached balance is written only inside the transaction that appends the ledger row. Removing the other path makes that structural instead of a convention someone forgets |
| `PrismaRepositoryBase.atomically()` detects an existing transaction | `typeof client.$transaction !== 'function'` ⇒ we are inside one | Prisma cannot nest `$transaction`, and a repository cannot know whether its caller wrapped it. Lets `wallets.append` and `events.append` be atomic standalone *and* flat inside `uow.run` |
| `events.append` retries a lost `seq` race | bounded loop, 5 tries, on P2002 for `(gameId, seq)` | `MAX(seq)+1` is a read-modify-write. The unique constraint catches the collision; the retry makes concurrent appends produce a gapless log (asserted in `unit-of-work.test.ts`) |
| `/ready` counts a real table, not `SELECT 1` | `prisma.rewardRule.count()` | On SQLite the driver *creates* a missing file, so `SELECT 1` reports ready against a `DATABASE_URL` typo. Touching a table proves the schema is there — which is what the S10 verify step actually checks |
| Unbuilt middleware are **named no-op stubs**, in order | `interface/http/middleware/placeholders.ts` | Order is the security property (`02` §7). Reserving the slot means S12/S13 fill a body instead of re-deriving the chain |
| The `x-pending-middleware` header is **dev-only** | suppressed when `NODE_ENV === 'production'` | Caught during the live smoke test: it announces "no helmet, no rate limit, no auth" to anyone with `curl -i` |
| 4xx logs without a stack, 5xx logs with one | `errorHandler` | Also caught live: every 404 was emitting a ten-frame trace, burying the line a human wants |
| `requestId` sets `req.id`, pino-http's own field | no Express module augmentation | Augmenting `Request` with `id?: string` collides with pino-http's `id: ReqId` on `IncomingMessage` and breaks `app.use` overload resolution |
| Added `ICosmeticRepository.upsertItem` | not in `02` §5.2's list | The catalog is data the S06 seed writes and the admin console will edit; without it the catalog was unreachable through the interface and untestable by the contract suite |
| **The test harness spawns `node <cli.js>`, never `npx`** | `tests/bin.ts` resolves a dependency's bin entry from its `package.json`; `global-setup.ts` and `seed.test.ts` use it | S178's lesson, missed in two places. `execFileSync('npx', …)` is `ENOENT` on Windows for two compounding reasons: Node's `spawnSync` does no PATHEXT resolution (so it never finds `npx.cmd`), and `node_modules/.bin` shims are written per platform at install time (a WSL tree has no `.cmd` files at all). Resolving the entry script sidesteps shims, PATH and the shell |

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

- **S17 needs no new dependencies.** It is the game registry plus two public routes; the `_fixture`
  engine itself is S30.
- **Route wiring is now a three-line pattern.** `buildXRouter(container)` in
  `interface/http/routes/`, mounted under `API_PREFIX` in `app.ts`, with `zodValidate({...})` and an
  authorize guard per route. Copy `auth.routes.ts`: it is deliberately thin — validate, call a
  service, answer.
- **The access levels exist.** `requireIdentity()` (**G**), `requireUser()` (**U**),
  `requireRole(...)` (**A**, admin process only). **H** (host-of-table) is the one still missing and
  belongs to S18, where the table repository is in hand.
- **`enforceGuestBinding(container.guests)` is ready for `/tables/:id`.** It reads `:tableId` or
  `:id` from the route params, so S18 gets the 403 + `SEAT_IMPERSONATION` row for free — and should
  then delete `_probe/table/:tableId` from `probe.routes.ts`.
- **Tests: use `tests/helpers/app.ts`.** `buildTestApp()` gives `{ app, container, resetLimits }`.
  **Call `resetLimits()` in `beforeEach`** — the app is built once per file, so without it the second
  half of a file runs against a budget the first half already spent, and the failures look like auth
  bugs rather than rate limits. `registerUser(app)` returns a cookie-carrying agent.
- **`buildApp(container)` takes the container.** `buildContainer` accepts
  `{ prisma, logger, env, rateLimiter }` overrides.
- **Grow `requests/auth.http` into `requests/tables.http` for S18–S20**, same style: every block
  says what the response should be and why it matters.
- **The contract suite is the cheapest test you will ever write.** Adding a repository method means
  adding one `it(...)` in `tests/unit/repositories/contract/` and getting it verified against both
  the fake and SQLite. Add the method to the interface first, then the test, then both
  implementations — the suite will tell you when the fake and the database disagree.
- `git config core.hooksPath` is now `.githooks`, installed by `backend/scripts/install-hooks.mjs`.
  The pre-commit hook runs `contracts:check` in every project that has `node_modules`.
- `backend/requests/health.http` exists now. Grow it every session — S13 adds the auth flows.
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
