# Live Context — read this first, every session

**Last updated:** 2026-09-09

## Where we are

| | |
|---|---|
| **Milestone** | M0 — Platform Skeleton |
| **Last session completed** | **S01–S27 (Phases A + B + C + D + E + F) built and green — not yet verified by Mehrang** |
| **Next session** | **S28 — `GameInstance` + seed commitment + `GameEvent` append with `seq`** (3 h, 🧪) — starts Phase G |
| **Blocked on** | Nothing in code. The two older environment items only (port 3000, Playwright deps) |
| **Repo state** | `backend/` and `frontend/` exist. **1338 backend tests**, 18 frontend tests. No `admin-frontend/` (MA) |

Session spec for S28: `Documents/11-build-plan.md` §9.

## ⚠ `backend/node_modules` is now **WSL**-owned (flipped 2026-09-09 by S23)

Phase F added four dependencies — `socket.io`, `ioredis`, `@socket.io/redis-adapter`, and
`socket.io-client` (dev) — and the install ran from **WSL**, so `esbuild`/`rollup` swapped to their
Linux binaries. `npm run db:generate` was re-run afterwards, so both Prisma engines are present.

**To run `npm test` in `backend/` from Windows, re-run `npm install` there first.** Nothing else
needs doing — the Prisma client is dual-target and `argon2` ships prebuilds for both.

`frontend/node_modules` is **still Windows-owned** and was deliberately not touched. Its
`typecheck`, `lint` and `contracts:check` are green (all pure JS); its **18 Vitest tests were not
re-run** — do that from Windows. Phase F's only change to `frontend/` is the regenerated
`src/contracts/` mirror, which now carries `dto/chat.ts`, `dto/presence.ts` and a fully populated
`events.ts` (13 files, in sync).

## Phase F — what to verify (the gate for S23–S27)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 1338 tests
```

**`backend/requests/socket.md` is the manual** — every command below in full, with what each
response proves and the two cookie-jar traps that cost real time. Read that rather than this
section if you are actually sitting down to do it.

**The names to read, in order of what they protect:**

| Test | What breaks without it |
|---|---|
| `★ a payload carrying userId / playerId / seat cannot alter identity` | The entire seat-impersonation class re-opens |
| `★ socket.data.identity is immutable for the socket's life` | A token swap mid-connection becomes possible |
| `★ the seat room and the spectator room are disjoint, both ways` | **Phase G's hands leak.** Asserted now, while there is nothing to leak |
| `★ a guest joining a table it is not bound to is FORBIDDEN, and audited` | A guest token becomes a wildcard identity (07 §3) |
| `★ closing one of two tabs leaves the seat online` | A permanent "reconnecting…" badge on somebody who is playing |
| `★ grace expiry fires the ejection hook exactly once` | S33 ejects twice, or never |
| `★ every SYSTEM body in the database matches the i18n-key shape` | One row becomes untranslatable English prose forever |
| `★ a missing callback is survivable` | Caught a real bug: `reply?.({ data: await run() })` short-circuits and **never runs the handler** |
| `★ no ledger, cooldown, game-state or idempotency key ever reaches Redis` | A lost write becomes lost money (02 §3.2) |

```bash
# S23 — the handshake. Three identity outcomes and the immutability proof.
npx vitest run tests/integration/socket/handshake.test.ts --reporter=verbose

# S24 — the room model. Read "★ the seat room and the spectator room are
#       disjoint, both ways": it asserts membership *and* delivery, which is
#       the property Phase G's projections will depend on.
npx vitest run tests/integration/socket/rooms.test.ts --reporter=verbose

# S25 — presence. The unit file is where the awkward arithmetic lives (two tabs,
#       a reconnect one millisecond inside the window); the integration file
#       proves the wiring.
npx vitest run tests/unit/presence-service.test.ts tests/integration/socket/presence.test.ts \
  --reporter=verbose

# S26 — chat. The i18n-key assertion is the one that matters most long-term.
npx vitest run tests/integration/socket/chat.test.ts --reporter=verbose

# S27 — Redis, without needing Redis. The guard runs against a recording fake.
npx vitest run tests/unit/redis-keys.test.ts tests/integration/redis.test.ts --reporter=verbose

# And the guard that will matter in Phase G, landed early:
npx vitest run tests/unit/socket/projection-boundary.test.ts --reporter=verbose
```

### Live — two terminals, which is the whole point of S24

```bash
# Port 3000 is occupied on this machine, hence 3999 throughout.
PORT=3999 npm run dev

# set up a host, a table, an invite and a guest — see requests/socket.md §0
# then, in two windows:
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt --join $TID
```

Terminal 1: `takeSeat 1` → terminal 2 prints `table:seatChanged` **and** a `chat:message` whose
body is `table.system.seatTaken` with `params: { name, seat }`. Terminal 2: `takeSeat 1` →
`✗ SEAT_TAKEN { reason: 'SEAT_OCCUPIED' }`. Then `takeSeat 2` → terminal 1 sees it.

**The one thing to look hardest at:** that SYSTEM message's `body`. If you ever see
`"Mehrang took seat 1"` there instead of a dotted key, one row has become untranslatable and the
transcript a Persian reader opens next month is in English.

**Then Ctrl-C terminal 2** → terminal 1 prints
`table:presence { state: 'disconnected', graceEndsAt: <ISO> }`. Restart it inside the 15 s window →
`state: 'online'` and a **full** snapshot. Then open a third client with terminal 1's *own* cookies
and close only one of them: terminal 2 must print **nothing**.

**And the impersonation attempt**, typed into any connected client:

```
raw table:takeSeat {"tableId":"<TID>","seat":3,"userId":"somebody-else"}
→ ✗ VALIDATION_FAILED { userId: ['errors.field.unknownKey'] }
```

*Rejected*, not ignored — see the decisions table below.

## Phase E — what to verify (the gate for S21–S22)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 829 tests

# S21 — the whole session, and it needs no database for most of it.
npx vitest run tests/unit/wallet tests/integration/wallet --reporter=verbose
```

**The names to read, in order of what they protect:**

| Test | What breaks without it |
|---|---|
| `★ the same idempotency key credits exactly once, and returns the first row` | A socket retry pays twice (E2) |
| `★ holds after a randomized sequence of 500 credits` | `balance` and `Σ amount` drift (E1) |
| `★ a fully capped reward writes a zero-amount CAP_REJECTED row, never silence` | "Why did I get no coins?" is unanswerable (10 §2.4) |
| `★ IWalletRepository declares no way to set a balance` | Someone adds `bumpCachedBalance` and E1 becomes a convention |
| `★ the seat keeps its identity: same id, seat, team and joinedAt` | **The whole of S22.** A delete-and-reinsert passes every other test |
| `★ a throw at step 9 rolls back BOTH the user and the seat transfer` | A claimed seat with no wallet, or the reverse |
| `★ the guest token is dead the moment the claim commits` | The old cookie is a second, weaker credential for the account's seat |

```bash
# The four failure modes 03 §6.1 names, each asserting on what is ABSENT after:
npx vitest run tests/integration/wallet/guest-claim.test.ts -t "failure modes" --reporter=verbose
#   The `prisma:error  Unique constraint failed on … (email)` line in that output
#   is the duplicate-email path working, not a fault.

# ── Live. Port 3000 is occupied on this machine (see below). ────────────────
npm run db:reset          # seeds the `_global` RewardRule the caps are read from
PORT=3999 npm run dev
```

**`backend/requests/wallet.http` walks the whole of J2 from your editor** and says what each
response proves. The `curl` equivalent, which is the S22 verify step from `11` §7:

```bash
API=localhost:3999/api/v1

# 1. a host, a table, an invite
curl -sc /tmp/h.txt -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"host@test.dev","password":"correct-horse-battery","displayName":"Mehrang"}' >/dev/null
TID=$(curl -sb /tmp/h.txt -X POST $API/tables -H 'content-type: application/json' \
  -d '{"gameSlug":"fixture","seatCount":4,"options":{}}' | jq -r .id)
CODE=$(curl -sb /tmp/h.txt -X POST $API/tables/$TID/invites \
  -H 'content-type: application/json' -d '{}' | jq -r .code)

# 2. the friend joins and sits down — note the memberId and joinedAt it prints
curl -sc /tmp/g.txt -X POST $API/auth/guest -H 'content-type: application/json' \
  -d "{\"inviteCode\":\"$CODE\",\"displayName\":\"Sara\"}" | jq
curl -sb /tmp/g.txt -X POST $API/_probe/tables/$TID/seats \
  -H 'content-type: application/json' -d '{"seat":2}' | jq '.seats[2]'
#   ★ keep .memberId and .joinedAt. Those two values ARE the test.

# 3. give her coins — through WalletService, never an INSERT
npx tsx scripts/dev-credit.ts --guest-cookie /tmp/g.txt --amount 120
curl -sb /tmp/g.txt $API/_probe/wallet | jq
#   → balance 120, status PROVISIONAL. That word is the entire signup pitch.

# 4. ★ the claim
curl -sb /tmp/g.txt -c /tmp/g.txt -X POST $API/auth/guest/claim \
  -H 'content-type: application/json' \
  -d '{"email":"sara@test.dev","password":"correct-horse-battery"}' | jq
#   → { identity, redirectTo:"/table/…", vestedCoins:120, forfeitedCoins:0,
#       seatPreserved:true }
#   ★ redirectTo comes from the SERVER, decided by the transaction that kept
#     the seat — the client never has to remember which table it was on.

curl -sb /tmp/g.txt $API/tables/$TID | jq '.seats[2]'
#   ★★ THE ONE THING TO LOOK HARDEST AT: memberId and joinedAt are the SAME
#      values as in step 2, now with a user in the seat. The row was UPDATED,
#      not recreated — so no seat was vacated, and from the other players'
#      point of view nothing happened except a name badge losing its "guest"
#      marker. A delete-and-reinsert would satisfy every other check here.

curl -sb /tmp/g.txt $API/_probe/wallet | jq
#   → COIN 120 VESTED, plus GEM and TICKET. A user holds all three.

# 5. the guest token is dead — with the OLD jar
curl -si -b /tmp/g.old.txt $API/auth/me | head -1     # (cp /tmp/g.txt first, in step 3)

# 6. the vesting cap, on a second guest
npx tsx scripts/dev-credit.ts --guest-cookie /tmp/g2.txt --amount 900
#   then claim → { vestedCoins: 500, forfeitedCoins: 400 }
#   and a GUEST_FORFEIT row for −400 reasoned GUEST_VEST_CAP. The remainder is
#   *explained*, not merely missing.

npm run db:studio
#   WalletTransaction: the guest wallet holds +120 MATCH_REWARD and −120
#   GUEST_VEST (balance 0, now VESTED); the user wallet holds +120 GUEST_VEST.
#   Σ across both is 120, unchanged — coins were MOVED, never conjured (E1).
#   Both halves share one derived key: `vest:{guestSessionId}`.
#   GuestSession: claimedAt set, claimedByUserId set, row never deleted.
```

**Or in Postman:** folder `07 Wallet & the claim` runs the same journey with assertions attached,
including the `memberId`/`joinedAt` comparison. 71 requests, 99 assertions, 0 failures expected —
see the note at the bottom of this file about its **new tightest budget** (`auth:create`, 8 of 10).

## Phase D — what to verify (the gate for S17–S20)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 708 tests

# S17 — the catalog, at the level where it is cheap to check. Read the names:
#   "★ rejects literal English where an i18n key belongs"
#   "★ is absent from a production registry entirely"   (the fixture game)
#   "%s publishes a convertible optionsSchema"          (all six, or the form breaks)
npx vitest run tests/unit/games tests/integration/games.test.ts --reporter=verbose

# S18 — read one name in particular: "★ carries no game state — the transport
#       rule, pinned". That test is the reason the rule cannot erode one
#       convenient field at a time.
npx vitest run tests/integration/tables.test.ts --reporter=verbose

# S19 — the two that matter: "★ resolves with no cookie at all" and
#       "★ the bodies are byte-identical, so codes cannot be enumerated".
npx vitest run tests/integration/invites.test.ts --reporter=verbose

# S20 — ★ the headline, and test-only by nature: you cannot click two buttons in
#       the same millisecond.
npx vitest run tests/integration/seat-claim.test.ts --reporter=verbose
#   Read: "★ two claims on the same seat: exactly one wins",
#         "★ four rivals racing for one seat still produce one occupant",
#         "★ IN_PROGRESS keeps the row and stamps disconnectedAt".
#   The `prisma:error  Unique constraint failed` lines in that output are the
#   mechanism working, not a fault: the claim path inserts and catches.

# ── Live. Port 3000 is occupied on this machine (see below). ────────────────
npm run db:reset
PORT=3999 npm run dev
```

**`backend/requests/tables.http` walks all of Phase D from your editor** and explains what each
response proves. `requests/auth.http`'s guest block now points at the real `GET /tables/:id`. The
`curl` equivalents, in order:

```bash
API=localhost:3999/api/v1

# S17 — no cookie needed anywhere here; the welcome page has no login
curl -s $API/games | jq '.[] | {slug, comingSoon, playableCounts, turnTimeoutMs}'
curl -s $API/games/shelem | jq '{slug, preview, optionsSchema}'
curl -si $API/games/nope | head -1                    # → 404
curl -s $API/games | jq 'tostring | test("Shelem|Blackjack|Sudoku")'   # → false
#   ★ the payload carries nameKey/taglineKey, never "Shelem". Localisation is
#     the client's job (02 §8.1), and this is what makes fa/RTL possible at all.

# S18 — needs the cookie jar from requests/auth.http (or the register curl)
curl -sc /tmp/c.txt -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"correct-horse-battery","displayName":"Mehrang"}' >/dev/null
TID=$(curl -sb /tmp/c.txt -X POST $API/tables -H 'content-type: application/json' \
  -d '{"gameSlug":"fixture","seatCount":4,"options":{"target":3}}' | jq -r .id)

curl -sb /tmp/c.txt $API/tables/$TID | jq
#   ★ look for what is NOT there: no state, no deck, no hand, no turn, no
#     legalMoves. And note you are NOT seated — creating a table and sitting
#     down are separate acts.
curl -sb /tmp/c.txt $API/tables/mine | jq '.[].id'
curl -s -b /tmp/c.txt -X POST $API/tables -H 'content-type: application/json' \
  -d '{"gameSlug":"fixture","seatCount":4,"options":{"target":999}}' | jq .fieldErrors
#   → {"options.target":["errors.field.tooBig"]} — the engine's own schema is
#     the gate, so game #6 needs no change here
curl -s -b /tmp/c.txt -X POST $API/tables -H 'content-type: application/json' \
  -d '{"gameSlug":"shelem","seatCount":4,"options":{}}' | jq .fieldErrors
#   → errors.gameComingSoon

# S19 — ★ the uncookied resolve is the whole point
CODE=$(curl -sb /tmp/c.txt -X POST $API/tables/$TID/invites \
  -H 'content-type: application/json' -d '{}' | jq -r .code)
curl -s $API/invites/$CODE | jq        # ← NO -b. This must work: it is what
                                       #   makes the link work in a private window
#   and read what it withholds: no tableId, no host id, no email, no options
curl -sb /tmp/c.txt -X DELETE $API/tables/$TID/invites/$CODE >/dev/null
diff <(curl -s $API/invites/$CODE) <(curl -s $API/invites/TOTALFAKE) && echo IDENTICAL
#   → IDENTICAL. Revoked and never-existed are one answer, or the endpoint is an
#     oracle for enumerating live codes (07 §5.2)
for i in $(seq 1 35); do curl -s -o /dev/null -w "%{http_code}\n" $API/invites/FAKECODE; done \
  | sort | uniq -c                     # → 410s then 429s, on this route's own budget

# S20 — the seat routes are a dev-only window on TableService, deleted in S24
curl -sb /tmp/c.txt -X POST $API/_probe/tables/$TID/seats \
  -H 'content-type: application/json' -d '{"seat":1}' | jq '.seats[1]'
curl -s -b /tmp/c.txt -X POST $API/_probe/tables/$TID/seats \
  -H 'content-type: application/json' -d '{"seat":2}' | jq
#   → 409 SEAT_TAKEN, reason ALREADY_SEATED, yourSeat 1 — one identity, one seat
curl -s -b /tmp/c.txt -X POST $API/_probe/tables/$TID/seats \
  -H 'content-type: application/json' -d '{"seat":1,"userId":"someone-else"}' | jq .code
#   → VALIDATION_FAILED. There is no field with which to claim to be someone
#     else; identity comes from the cookie (and from the socket, from S24)

npm run db:studio    # Table CLOSED with closedAt after a DELETE — never deleted.
                     # Invite rows survive revocation. TableMember carries team
                     # (null for fixture) and disconnectedAt.
```

**The one thing to look hardest at:** the `GET /tables/:id` response. If a `state`, `deck`, `hand`
or `turn` key ever appears there, the transport split has been breached and the leak-test suite in
M1 will be guarding a door that is already open.

**Or verify it in Postman instead**, which covers the same ground with assertions attached — import
`postman/` (see the section at the bottom of this file) and run the collection: 58 requests, 77
assertions, 0 failures expected.

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
5. **Extend `postman/Template.postman_collection.json` with every route the session added**, in the
   same style: one folder per phase, an assertion on every request, ids captured into collection
   variables for the requests that follow. Then *run it* — `npx newman run
   postman/Template.postman_collection.json -e postman/Template.local.postman_environment.json`
   against a live API — and report the result. See the note at the bottom of this file for how to
   start an API from WSL and for the trap this caught the first time.
6. Mehrang runs the "You verify" steps himself. That is the gate.
7. Tick the boxes in `plan.md`, update this file, hand over a conventional commit message.
8. **Mehrang commits.** Never commit on his behalf.

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

### ⚠ One `node_modules`, one platform — `backend/` is **WSL**, `frontend/` is **Windows** (2026-09-09)

**Phase F flipped `backend/` to WSL** (four new dependencies, installed from there) and left
`frontend/` alone. The table below still describes the mechanism; only the "currently installed"
column has moved for `backend/`.

**Whichever OS last ran `npm install` owns the tree.** Committing works from either OS now that the
hook needs only `node`, but `npm run dev`, `test` and `lint` run **only on the install platform**.
The blocker is native binaries, which no amount of code can fix:

| Package | Platform-swapped by `npm install` | Currently installed |
|---|---|---|
| `esbuild` (via `tsx`, `vitest`) | `@esbuild/linux-x64` ⟷ `@esbuild/win32-x64` | backend **linux-x64**, frontend **win32** |
| `rollup` (via `vitest`) | `rollup-linux-x64-gnu` ⟷ `rollup-win32-x64-*` | backend **linux-x64**, frontend **win32** |
| `@prisma/engines` (the CLI's schema engine) | downloads per host | **both** `schema-engine-windows.exe` and `-debian-openssl-3.0.x` are present |
| `.prisma/client` (the query engine) | **baked in by `prisma generate`, not by install** | **both** — see `binaryTargets` below |
| `argon2` | ships prebuilds for every platform | ✅ both |

So, as the tree stands: **`cd backend && npm test` runs from WSL**, and **`cd frontend && npm test`
runs from Windows**. To move either one, re-run `npm install` from the other OS — it swaps
esbuild/rollup and costs nothing else, because the Prisma client is dual-target either way. Moving
`backend/` back to Windows is the likelier need, since that is where the 1338 tests are.

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

## Decisions made while building Phase F (2026-09-09)

| Decision | Value | Why |
|---|---|---|
| **★ An identity-shaped field in a payload is *rejected*, not ignored** | every inbound schema is `.strict()`; none declares `userId`/`playerId`/`guestSessionId`/`memberId` | `11` S23 asks for "is ignored". Rejecting is strictly stronger and matches every REST body in this codebase: there is no field to claim to be somebody else *with*, so the defence is a property of the schema rather than a branch a handler must remember not to write. The counter `socket_identity_spoof_attempts` should sit at zero forever — our own clients are typed from the same file — so any movement is a probe or a bug we introduced |
| **`socket.data.identity` is `Object.freeze`d and non-writable** | `Object.defineProperty(..., { writable: false, configurable: false })` | "Immutable for the socket's life" (04 §1.1) as a property of the object, not a convention. A test asserts the descriptor, so a future handler that tries to reassign it fails rather than succeeding quietly |
| **A protocol mismatch is reported over `error`, not refused at the handshake** | `connected` still fires; an `error` follows | Refusing is tidier and leaves an out-of-date page with no way to explain itself — a `connect_error` is a dead screen, whereas an `error` on a live socket is a banner that says "please refresh". The protection comes from the Zod schemas either way |
| **`IRealtimePublisher` port + `MutableRealtimePublisher`** | `application/ports/realtime.ts`; the gateway attaches the Socket.IO adapter | There is a real cycle — services need to broadcast, broadcasting needs the server, the server's handlers need the services. Late-binding one of the three is unavoidable, and this is the cheapest place: a detached publisher silently drops, which is correct both before the gateway listens and in every unit test. `RecordingPublisher` then turns "did the other three learn seat 2 dropped?" into an array assertion |
| **★ Room names come from four builders, and a test forbids assembling one by hand** | `tableRoom` / `seatRoom` / `spectatorRoom` / `userRoom`, branded `Room` | This is what makes 04 §2's guarantee *auditable*: `rg 'seatRoom\('` finds every place a private projection can go. A hand-written `` `seat:${id}:${n}` `` would be invisible to that search, and invisible is how a hand leaks. `user:` is excluded from the check because `holderKey` has produced the byte-identical string since Phase B |
| **The projection guard is a source-scan test, not the ESLint rule 04 §4.1 names** | `tests/unit/socket/projection-boundary.test.ts` | `game:state` does not exist until S30, so a lint rule would today guard a door with no room behind it and sit unproven — while `lint-guards.test.ts` proves every real guard rejects a deliberate violation. The scan gives identical protection now and converts to a rule for free later. It also keeps S48's "the fourth ESLint guard" note true |
| **`Clock` is a port; `FakeClock` lives in `tests/fakes/`** | `application/ports/clock.ts` | Vitest's fake timers replace the global for the whole file — including Prisma's internals, `ioredis`'s retry loop and Socket.IO's own ping — and the resulting failures read as race conditions rather than as a stubbed clock. Injecting time costs one interface and makes a 90-second Shelem grace window a one-line test |
| **Presence is in-process; only `disconnectedAt` is persisted** | `PresenceService`, keyed by identity | Live presence is cheap to lose and cheap to recompute (02 §3.2). A persisted `state: 'online'` would survive a crash as a *lie* about somebody the other three are waiting on. The one column that is persisted is the one that must survive: the grace deadline is derived from it, so a restart re-arms the timer from where it stood rather than gifting a fresh 90 seconds (04 §5.4) |
| **Presence tracks a *set* of sockets per identity** | `sockets: Set<string>` | Multi-tab. Only the last socket closing starts the grace clock. Getting this wrong produces the most annoying possible bug — a permanent "reconnecting…" badge on somebody who is sitting there playing — and it is invisible until somebody opens a second tab |
| **`away` exists, and the transport ping cannot replace it** | 3 missed 15 s heartbeats | Socket.IO's ping proves a **TCP connection**; it is answered by the browser's networking stack from a backgrounded tab with the screen off, from a closed laptop lid, and from a page whose JS has thrown. The application heartbeat proves a human could still act. `away` starts no timer and forfeits nothing — it exists so three players stop waiting on a fourth whose screen is off |
| **★ `armGrace` calls `clearTimer`, not `cancelGrace`** | the bug this caused, then the fix | `cancelGrace` also forgets `disconnectedAt` and `graceEndsAt` — right when somebody reconnects, catastrophic when arming: `detach` sets both immediately before, so arming erased the two facts the timer exists to act on. The countdown rendered as absent and **the hook never fired**. Caught by `★ grace expiry fires the ejection hook exactly once` |
| **★ `attach`, not `noteSeat`, after every seat change** | `afterSeatChange` in `table.handlers.ts` | The ordinary flow is *join the lobby, then sit down*, and at join time there is no member row to track — so a socket that took its seat afterwards was invisible to presence and disconnecting from it started no grace timer at all. Found by the kick test, which is a useful reminder that the "obvious" ordering was the untested one |
| **★ `const data = await run(...)` before `reply?.(...)`** | `interface/socket/ack.ts` | `reply?.({ data: await run(…) })` reads naturally and is wrong: optional chaining short-circuits its *arguments*. With no ack callback — which Socket.IO permits and a hostile client guarantees — the handler never ran, and every event from such a client was silently ignored while the server looked healthy. Found by `★ a missing callback is survivable` |
| **A kick evicts by *room*, not by looking sockets up** | `socket.nsp.in(seatRoom(t, s)).socketsLeave(...)` | The seat room *is* the set of that seat occupant's sockets, so this removes exactly the right ones — across every instance once the Redis adapter is in play — without the handler knowing who they are. Emit first, then evict: the other order sends the notice to an empty room |
| **`syncRooms` is declarative, and computes the exact room set** | leaves what is unwanted, joins what is missing | Incremental room juggling is how a player who moved from seat 1 to seat 2 keeps receiving seat 1's private projection — a bug that stays invisible until Phase G puts cards in those payloads. The room list is derived from `table.seatCount`, so the "leave" side matches by exact name rather than by substring |
| **`table:releaseSeat` carries no `seat`** | `{ tableId }` only | You can only release your own, the server already knows which, and a payload that could name a different one would be a kick wearing a friendlier name |
| **Chat is limited per *identity*; seats and joins per *socket*** | `config/socketLimits.ts` | The cost being controlled differs. A seat change costs server work on one connection, and a second tab genuinely doubles the legitimate need. A chat message costs *other people's attention*, and five tabs must not buy five times the spam |
| **Text and emotes have independent buckets** | 5/10 s and 10/10 s | An emote is a reaction; reacting to four things in a fast hand must not cost you the ability to say "nice one". A shared bucket makes the cheaper action eat the more valuable one |
| **A bad display name is refused; a bad chat message is *masked*** | `application/policies/chat.ts` | A name is chosen once and is how you are addressed all evening, so making somebody pick again is proportionate. A message is a sentence in a live conversation — refusing it mid-hand teaches people that chat is unreliable, and the swear was already thought. The mask preserves surrounding punctuation, and matches whole tokens so "Scunthorpe" survives |
| **Bidi overrides and zero-width characters are stripped from every body** | a table of code-point ranges, not a regex literal | `U+202E` reverses everything rendered after it, and in a UI that is *already* bilingual and already switching `dir` per locale that is a genuinely effective way to make a message read as something it is not — in the one place a reader has no reason to be suspicious. A character class of invisible characters is a line of source nobody can review, hence the table |
| **`SYSTEM` keys are a closed `SYSTEM_MESSAGE_KEYS` object** | `contracts/dto/chat.ts` | "Which strings must the client translate?" is answered by reading one array, and a typo is a compile error rather than a message that renders in production as its own key. The i18n-key shape is additionally enforced by a pattern that **forbids whitespace**, which no English sentence can satisfy |
| **★ Every Redis key is built in `infrastructure/redis/keys.ts`, and a test enforces it two ways** | no builder produces a forbidden name; nothing outside that directory touches a client | 02 §3.2's four "must NEVER" rows are a rule somebody breaks eighteen months from now in a caching PR that looks entirely reasonable. Funnelling every key through named builders makes it mechanical. `assertStorableKey` is the runtime backstop for a key assembled from a runtime value, and it **throws** rather than falling back — a bucket named `wallet:…` is our bug, and degrading silently would keep Redis clean while letting the mistake ship |
| **Losing Redis degrades; the limiter falls back in-process** | `RedisRateLimiter` holds a `SlidingWindowRateLimiter` | Failing *open* removes the protection at exactly the moment the system is under stress; throwing turns a cache outage into an API outage. A per-instance budget is strictly weaker than a shared one and strictly stronger than none. This is only defensible *because* nothing durable is in there |
| **The Redis limiter is one Lua script, not four commands** | `EVAL` | Drop-expired, count, decide, record must be atomic. As a pipeline it is a read-modify-write with a gap, and two requests arriving together both read the old count — which is precisely the scenario a limiter exists for |
| **Presence in Redis is a *mirror*, cleared at boot** | `RedisPresenceMirror`, 5-minute TTL | It exists so a second instance can render a seat map without asking the first. Nothing reads it to make a decision — ejection and reward eligibility read `TableMember.disconnectedAt` from the database — so losing it costs one recomputation. Clearing at boot is what makes "presence recomputes after a restart" true rather than aspirational |
| **★ `/_probe/tables/:id/seats` is kept, against S24's instruction** | re-dated for S37 | S24 says delete it once `table:takeSeat` calls the same service, and that reasoning was right when it was written. It is now outweighed: **Newman cannot speak Socket.IO**, and Postman folder 07 uses these routes to seat a guest before asserting that `memberId` and `joinedAt` survive the claim — the single assertion that distinguishes an *updated* seat from a delete-and-reinsert, and therefore the headline check of J2. Deleting them would delete that coverage with nothing able to replace it. Both paths call one method, so they cannot disagree; the router is still dev-only |
| **`withCredentials` must not be set on a Node socket client** | `scripts/dev-socket.ts` | Cost twenty minutes. It is the *browser's* way of saying "attach your own cookie jar"; in Node there is no jar, and setting it stops `engine.io-client` applying `extraHeaders` on the websocket transport. Every connection then returns `UNAUTHORIZED` from a cookie file that is perfectly good — indistinguishable from an expired token or a broken handshake |
| **`dev-socket.ts` reads curl's Netscape jar, `#HttpOnly_` and all** | `--cookies /tmp/c.txt` | That is where the cookies already are: every verification step in `11` establishes a session with `curl -c`. The prefix is glued to the *domain* field for exactly the three cookies that matter here, so a parser that skips `#` comment lines silently reads an empty jar |
| **`zodErrors.ts` extracted, shared by REST and sockets** | `interface/validation/` | Two copies of the issue→key table would drift, and a player would see a translated error on a form and an untranslated one from an ack. Extracted the moment there were two callers |
| **13 Phase F counters added** | incl. `socket_identity_spoof_attempts` | That one should sit at exactly zero forever, which is what makes any movement worth looking at. `presence_grace_expired` against `reconnects` is the honest answer to "is the grace window long enough?", which is otherwise a guess |

## Decisions made while building Phase E (2026-09-09)

| Decision | Value | Why |
|---|---|---|
| **The cap windows are rolling, not calendar** | `now − 1 h`, `now − 24 h` | A cap that resets at a wall-clock instant can be straddled: 2 000 coins at 23:50 and 2 000 more at 00:10 is 4 000 in twenty minutes, which is exactly the *rate* E7 exists to refuse. Same reasoning as S12's sliding-window limiter, and the same cost — "when do I earn again?" has a per-credit answer rather than a clock time. The one calendar-keyed thing stays calendar-keyed: the daily bonus, whose `daily:{holder}:{YYYY-MM-DD}` key *is* its once-a-day guarantee |
| **`applyCaps` is a pure function in `domain/economy/caps.ts`** | takes usage + limits, returns a decision | The interesting cases are boundaries — exactly at the cap, one coin over, three caps binding at once, a cap lowered below a holder's current spend — and every one of them would otherwise need ledger rows written at controlled times. 23 unit tests, no database, no clock |
| **A partial cap credits what fits; only zero writes `CAP_REJECTED`** | 100 requested, 30 of headroom → a 30-coin `MATCH_REWARD` row reasoned `CAP_PER_HOUR:100` | 10 §2.4's pseudocode only branches at zero, and refusing the whole reward because part of it exceeded a cap would be punitive. Recording the cap on the *paying* row means one row can render "earned 120, credited 30, hourly limit" |
| **`reason` is a machine code with the requested amount** | `CAP_PER_HOUR:120`, `GUEST_VEST_CAP` | Same discipline as `i18nKey`: the statement renders in Persian without a round-trip through the server (02 §8.1). Two facts, neither otherwise recoverable — *which* cap bound, and what was originally earned (the credited amount is the row's own `amount`) |
| **Four kinds are exempt from the earn caps** | `GUEST_VEST`, `ADMIN_ADJUST`, `REFUND`, and every negative amount | Each exemption is a case where a cap would make the ledger *less* true. `GUEST_VEST` **moves** coins between wallets rather than minting them — charging it against the daily cap would mean a guest who earned right up to the limit could not keep their own balance. `ADMIN_ADJUST` is an operator correcting a mistake, and a cap silently eating the correction is worse than the mistake |
| **`sumCreditsSince` counts positive amounts only** | `amount: { gt: 0 }` in the `where` | ★ Load-bearing. If the window netted debits against credits, a player could **spend their way back under the daily cap and keep earning** — the store would become a cap bypass. A cap is on earning *rate*, and spending is not negative earning. There is a contract test named after this |
| **`WalletService` has two entry points** | `credit()` opens a transaction; `creditWithin(repos, …)` joins one | Prisma cannot nest `$transaction`, and S22 and S36 must credit as *part of* a larger all-or-nothing transaction — a vested wallet with no transferred seat is as broken as the reverse. So the seam is a requirement, not a convenience. Asserted directly: a throw after `creditWithin` leaves no ledger row |
| **★ E1 is enforced structurally, not by a call-site test** | `IWalletRepository` has no balance setter at all | `11` S21 asks for "a test asserting no code path calls `bumpCachedBalance` without appending a row". This codebase answers a step earlier: **there is no `bumpCachedBalance`** (the Phase B decision), so the invariant is a shape nobody can express rather than a rule they must remember. `tests/unit/wallet/ledger-invariant.test.ts` therefore guards the *design*: the interface declares no setter, the Prisma repository writes `balance:` only inside `append`, and only `append`/`markVested` touch the wallet row at all |
| **`recompute` reports drift and does not repair it** | `{ cached, computed, drift }` | A silent self-heal would hide the write path that lied, which is the only interesting question. S38's job is an `ALERT`, not a fix |
| **`IRewardRuleRepository` added; the caps are read from `_global` per credit** | falls back to 10 §3.7's numbers when the row is missing | Rebalancing the economy is a row update, not a deploy (10 §3) — and the numbers in the spec are explicitly a starting guess. Falling back rather than throwing is deliberate: an unseeded developer database must not fail its first credit, and an *uncapped* economy is the worse of the two failures |
| **`capMultiplier` declared now, unused until M7** | defaults to 1; scales the hourly and daily ceilings only | E3 — premium buys earn *rate*, never immunity, and never touches the guest cap (a guest holds no subscription). Declaring it now means the multiplier has exactly one home in the economy instead of appearing in the reward formula *and* the caps |
| **★ `markClaimed` replaced by `claimIfUnclaimed`, returning null on a loss** | conditional `updateMany where { id, claimedAt: null }` | The old signature could not express an atomic claim: two requests with one guest cookie both read an unclaimed session, both build a user, and under PostgreSQL READ COMMITTED both would commit. The conditional write makes the database pick a winner and the loser's whole twelve-step transaction unwind — same discipline as `revokeIfActive` and `claimSeat`. Nothing called the old method yet, so replacing it beat having two ways to claim |
| **An unknown guest id also returns `null`, not `NotFoundError`** | matches Prisma's `updateMany` | The caller cannot act on the difference between "already claimed" and "no such session" — both mean "this is not yours to claim" — and a fake that threw where the database returns 0 rows would be a lying fake. There is a contract test for it |
| **`IMatchParticipantRepository` created deliberately narrow** | `reattributeActor` + two counts | Step 7 of the claim needs it now; settlement (S36) will grow it. Reaching into Prisma from the claim service instead would have broken guard 1 and made the claim untestable against the fakes. Its populated case is tested against the *database* rather than in the contract suite, because a `MatchParticipant` row needs a `MatchResult` and no repository can create one yet — an honest gap, not a hidden one |
| **`IChatRepository.reattributeActor` added** | `updateMany` on `guestSessionId` | Without it the transcript of the hand a player just joined keeps addressing a guest session that no longer exists, and moderation (12 §6) has no way to attribute what was said to the account that said it |
| **The mirror-negative row shares the vest's key** | both halves carry `vest:{guestSessionId}` | Uniqueness is per *wallet*, so one derived key identifies the pair and both halves replay together or not at all. A capped claim additionally writes `GUEST_FORFEIT` for the remainder under `forfeit:{guestSessionId}` — the guest wallet lands on exactly zero and the shortfall is *explained* rather than merely absent |
| **The emptied guest wallet is kept and marked `VESTED`** | `markVested(provisional.id)` | It is the guest half of the audit trail. Leaving it `PROVISIONAL` at zero would read as "coins still waiting" on any screen that filters by status |
| **`GuestSession.prefsJson` is copied through a whitelist** | `application/mappers/preferences.ts` | The blob was written by a client and `preferences.upsert` spreads its patch straight into Prisma — an unknown key would crash the claim, and a key matching a different column would let a guest set it. Every field is named, every enum value checked against `contracts/enums.ts`, and anything else is **dropped rather than rejected**: losing an unrecognised theme preference must never cost somebody their seat |
| **`POST /auth/guest/claim` carries no `requireIdentity()`** | reads the `guest` cookie directly | `authenticate` resolves the access cookie *first* (correctly — a player who signed up mid-session **is** a user), so a browser holding both would present as a user and `req.identity` would never be the guest being claimed. The service refuses, not the middleware. There is a Postman assertion that a `tableId` in the body is a 400: that is the field somebody will eventually try to add, and accepting it would make this a route that can take another table's seat |
| **The claim distinguishes its refusal reasons; the invite endpoint does not** | `GUEST_EXPIRED` vs `ALREADY_CLAIMED` vs `NO_GUEST_SESSION` | The caller is presenting a cookie *we issued to them*, so possession is already proof and a reason confirms nothing about anyone else. And it is worth having: "your session expired" and "this was already upgraded" send the player to two different screens. What stays undifferentiated is a token that resolves to nothing — malformed, forged, unknown and swept all answer `NO_GUEST_SESSION`, where the difference *would* be information about which tokens exist |
| **`clearGuestCookie` added** | clears `guest` only | The claim issues `access` + `refresh` and must retire `guest` in the same response. `clearAuthCookies` would have cleared the two cookies just issued — a bug that would have looked like "the claim logs you out" |
| **`GET /_probe/wallet`, dev-only, dated for deletion in S37** | `probe.routes.ts` | S22's verification is "provisional 120 before, vested 120 after" and that sentence needs something to read; the real `GET /wallet` is S37's deliverable. Same precedent and same fate as S16's `/_probe/table/:tableId` |
| **`scripts/dev-credit.ts` grants coins through `WalletService`** | never an `INSERT` | Nothing is earnable before S36 settles a match, so the setup for a hand-walked J2 has to come from somewhere. Going through the service means the derived key, the caps, `balanceAfter` and the audit row all happen — teaching anyone to insert a ledger row by hand is how a cached balance and its ledger drift apart, which is the exact failure E1 exists to prevent. It refuses to run under `NODE_ENV=production` |
| **Eight Phase E counters added** | incl. `wallet_credits_replayed` | That one is the mechanism *working*: it counts idempotency keys that collided. A spike means something upstream is retrying; a permanent zero probably means the keys stopped being derived |

## Decisions made while building Phase D (2026-09-09)

| Decision | Value | Why |
|---|---|---|
| **The `GameEngine` interface is written in full at S17**, with zero engines behind it | `domain/games/GameEngine.ts`, types only | Every later session is then built against the real interface instead of an ad-hoc shape that has to be reconciled at M1. `registry.engine(slug)` returns `undefined` rather than throwing, which keeps "announced but unplayable" an ordinary state — and M0 spends all of itself in that state |
| **`comingSoon` added to `GameMeta` — and `05` §1 corrected to carry it** | `Documents/05-game-engine-spec.md` §1 | `11` S17 requires the field and the spec's interface did not have it. Declared rather than derived from "has an engine registered", because those are not the same claim: an engine can pass its unit tests while the renderer, the reward rule or the bot is still missing. Each milestone flips its own game's flag as the last step of shipping it |
| **A Zod meta-schema over `GameMeta`, run at registry construction** | `domain/games/metaSchema.ts`; `assertValidMeta` in `buildGameRegistry` | TypeScript checks the shape; this checks what a type cannot — `playableCounts ⊆ [min..max]`, i18n **keys** rather than English, a preset whose options its own game would reject. A malformed catalog entry becomes a boot failure naming the slug and field, instead of an empty preview card nobody notices for a week |
| **`fixture` is registered only when `NODE_ENV !== 'production'`, and never listed** | `includeDevGames` from `env`, `list()` returns `PUBLIC_METAS` | The dev rig must be creatable (S18–S20 need a slug that is actually playable) without ever being advertised. In production its 404 is identical, but for the echoed slug, to a game that never existed |
| **Our own Zod → JSON Schema converter, ~160 lines, no dependency** | `application/mappers/jsonSchema.ts`; **throws** on a node it cannot express | The create-table form renders from the published schema, and five games × ~15 options is a lot of form to hand-write twice — hand-writing it twice is how the form and the validator drift. Throwing rather than truncating is what makes an unconvertible option shape a failed build; a test converts every registry entry |
| **`GameCatalogService.assertPlayable` is the single gate**, shared by `/games` and `POST /tables` | `application/services/GameCatalogService.ts` | S18 needs "does this game exist / is it playable / are these options valid" too, and `TableService` reaching into the registry to re-derive them is how two answers to one question appear |
| **Stored options are the *parsed* output**, not the submitted fragment | `parseOptions` result is what `tables.create` writes | Defaults filled in and unknown keys refused means a stored table is replayable a year later even after a default moves. What you see in `GET /tables/:id` is what plays |
| **Creating a table does not seat the host** | `create` returns a table with an empty seat map | Convenient and wrong: seating has its own authorization, its own race and — from S24 — its own socket event the whole table watches. A host auto-seated at seat 0 could then never choose seat 2, because one identity holds one seat per table |
| **Level `H` reads the table and stashes it on `req.table`** | `requireHost(tables)` in `authorize.ts` | The only access level needing a database read. Stashing it means one read per request *and* that the handler edits the row the guard approved. A matchmade table has `hostUserId: null`, so every H-level route on it refuses — nobody owns a table the matchmaker assembled (09 §2) |
| **A guest hitting an H-level route is 403, not 401** | `requireHost` | Same reasoning as `requireUser`: hosting needs an account, so "refresh and retry" is advice a guest can never act on |
| **`GET /tables/:id` is readable by any authenticated caller who can name it** | no membership check | The cuid *is* the capability, exactly as the invite code is; there is no id to guess. A guest is additionally pinned to its own table by `enforceGuestBinding`, which is where S16's property now lives — the dev-only `/_probe/table/:tableId` is deleted and the three tests that used it now run against the real route |
| **The seat map carries display names and `isSelf`, never ids** | `OccupantView` has no `userId` | A seat map is shown to spectators and to anyone holding the invite link, so it is the wrong place to hand out account identifiers. "Which seat is mine?" is answered by a boolean |
| **`PATCH` refuses an empty body** | `.refine(Object.keys(patch).length > 0)` → `errors.emptyPatch` | "Change nothing" almost always means the client sent the wrong field name, and a 200 hides that bug. `gameSlug` is absent from the patch schema entirely: changing the game is a different table, not an edit |
| **Shrinking `seatCount` below an occupied seat is a 400** | `assertNoOrphanedSeats` | Otherwise the host can evict a seated player by editing a number, and the seat map would have to render an occupant outside its own range |
| **`U` removed from the invite alphabet — 30 symbols, not 31** | `INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'` | Found by the Postman collection's first run, which minted `WRQ6UUR6`. The docblock claimed `I L O U 0 1` were removed and then stated 31 symbols — 36 − 6 = 30, so the arithmetic contradicted itself and `U` was in fact still there. `U`/`V` is exactly the confusion the alphabet exists to avoid. Backward-compatible (lookup is by exact string), costs 0.3 bits per character. **The lesson is the test, not the letter:** the original check sampled *one* generated code, so it passed ~4 runs in 5 while the defect sat in place. It now asserts on the alphabet constant, where the property is total |
| **Invite codes are 8 chars over a 30-symbol alphabet with `I L O U 0 1` removed** | `infrastructure/invites/inviteCode.ts` | Every excluded character is one that gets mistyped off a phone screen or misheard on a call — `SEEDDEM0` vs `SEEDDEMO` is a support conversation, and a link that fails once is a friend who does not join. ≈6.6 × 10¹¹ codes, and the code is only ever a *join* capability, never an identity |
| **Code generation is a port** | `IInviteCodeGenerator`, `next()` | `application/` may not import `infrastructure/` (guard 1) — and the seam pays for itself immediately: a test hands in a generator that returns the same code twice and proves `mint` survives the collision, which real randomness cannot be made to do |
| **Minting retries on collision rather than checking first** | bounded 5-try loop on the unique constraint | Same discipline as the seat claim: "is this code free?" then insert has a race that the constraint does not |
| **★ Revoked, expired, exhausted, dangling and unknown are one byte-identical 410** | one `refuse()` exit in `InviteService` | Any difference — a distinct code, an extra `details` field, a different message — makes the public endpoint an oracle for enumerating live codes (07 §5.2). The *reason* goes to the `INVITE_ABUSE` audit row, where it is useful and invisible to whoever supplied the code. A test builds all five causes and asserts one distinct body |
| **`GET /invites/:code` is in its own router** | `invites.routes.ts`, separate from `tables.routes.ts` | It is the one table-adjacent route with no authentication at all. Keeping it in its own file means nobody adds a `requireIdentity()` to the tables router and silently kills the invite link — and its docblock says so at the top |
| **Resolution gets its own tighter rate limit** | `INVITE_RESOLVE_MAX=30/min` per IP, on top of the global limiter | It is the only public endpoint that takes a guessable-shaped secret. Generous enough that a pre-join screen reloading is never throttled; a 429 additionally records `RESOLVE_RATE_LIMIT` |
| **The public invite payload carries no `tableId`** | `PublicInviteResponse` | A leaked code should not also leak the table's identifier. A stranger deciding whether to join needs the game (as an i18n key), the host's display name, and whether there is room — nothing else |
| **Revocation and closing are tombstones** | `revokedAt`, `closedAt`; `DELETE /tables/:id` → 204 | The event log, match results and ledger rows all reference the table, and a cascade would erase the history that pays people. Both operations are idempotent |
| **`team` is written in the same insert as the seat** | `claimSeat(..., team)` | For a partnership game the team is part of who you are at that table. A follow-up update could fail and leave a seated player on no team — and there is no correct way to repair that mid-match |
| **`SeatTakenError` carries *which* constraint fired** | `SEAT_OCCUPIED` vs `ALREADY_SEATED` (+ `yourSeat`) | Both are 409s, and they are different problems with different buttons to press. The distinction is derived *after* the insert fails, so the claim path itself is still read-free |
| **Release behaves differently either side of the deal** | `WAITING` deletes the row; `IN_PROGRESS` stamps `disconnectedAt` | The seat belongs to the *match* once play starts: it holds the player's cards, chips and reward eligibility, and the grace timer decides whether a bot takes over (04 §5.2). Vacating it would delete a hand mid-play |
| **Unseating someone else is a host act, and an audited refusal otherwise** | `SEAT_IMPERSONATION` + `RELEASE_OTHER_SEAT` | One player unseating another is a kick, and a kick is host authority. The audit row is what makes an attempt visible |
| **`requireApproval` is a refusal, not a queue, at M0** | `APPROVAL_REQUIRED` | There is no pending-member state in the schema, and inventing one now would be guessing at the socket flow that S24/S43 actually needs. The leaked-link defence still works today: a stranger cannot sit down |
| **Seat routes live on `/_probe`, dated for deletion in S24** | `probe.routes.ts` | Seat changes are socket traffic and `02` §5 lists no REST seat routes — but S20 lands four sessions before the gateway and "claim it twice → 409" is worth running by hand. The **service** is the deliverable; `table:takeSeat` will call the very same method |
| **Nine Phase D counters added to `MetricsRegistry`** | incl. `invite_resolve_failures` | With one answer for every dead link, that counter and the audit rows are the only place "a friend reloaded a dead link" and "someone is spraying codes" are distinguishable at all |

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

### Phase F left these for S28–S30 to build on

- **★ Broadcast through `container.realtime`, never through `io` directly.** The four room builders
  in `application/ports/realtime.ts` are the only way to name a room, and a test enforces it. S30's
  `broadcastState` loops over seated members and publishes to `seatRoom(tableId, seat)` **once per
  viewer** — there is deliberately no `publishToTable('game:state', …)` to reach for, and
  `tests/unit/socket/projection-boundary.test.ts` will fail the build if one appears.
  The canary in that file (`nothing emits game state at all yet`) is *expected* to fail at S30:
  delete it then, and consider converting the scan to the ESLint rule 04 §4.1 names.
- **`PresenceService.onGraceExpired(handler)` is the hook S33 wants.** It fires exactly once per
  absence, carries `{ tableId, memberId, seat, identity, gameSlug, disconnectedAt }`, and swallows a
  throwing handler so one bad hook cannot stop the others from inside a timer callback. The
  *consequence* — attach a bot, mark `EJECTED_ABANDON` — is S33's; the mechanism is done and tested.
- **Timers come from `application/ports/clock.ts`.** S31's `TurnTimerService` should take the same
  `Clock` and be tested with `tests/fakes/clock.ts` — do not reach for `setTimeout`, and do not
  reach for Vitest's fake timers (they replace the global for Prisma, ioredis and Socket.IO too, and
  the failures read as race conditions).
- **`table:statusChanged` is declared and emitted only by `TableService.close`.** S30's `game:start`
  should emit it for `WAITING → IN_PROGRESS`, from the handler rather than the service — every
  *seat* change is announced by the handler that made it, because that is the layer that knows which
  socket to exclude and which system message to write. `close` is the exception because it happens
  over REST, where nothing on the socket side would otherwise notice.
- **Adding an event is four edits, in this order:** the payload schema and the two typed maps in
  `contracts/events.ts`, `npm run contracts:sync`, a handler registered in
  `interface/socket/handlers/`, and a test. The `handler(ack, Schema, fn)` wrapper does the Zod
  parse, the `AppError → ack` mapping and the opaque `INTERNAL`; a handler never sees an unparsed
  payload and never formats an error.
- **`atTable(context, tableId)` is the two-line gate every table-scoped event needs** — the guest
  binding (403 + an `ALERT` audit row) and the join check. Copy `table.handlers.ts`; it is the
  fullest example.
- **`tests/helpers/socket.ts` gives you a real gateway on an ephemeral port.** `startSocketHarness()`
  → `{ container, gateway, url, clock, register(), guest(), open(), resetLimits() }`. **Call
  `resetLimits()` in `beforeEach`** — chat is limited per *identity*, so one flood test silences
  every later test that reuses the same account, and the failures look like missing broadcasts.
  `client.next(event)` checks the transcript first, which is what stops the emit-then-wait race that
  makes socket tests flaky.
- **`scripts/dev-socket.ts` is the verification tool for the next 19 sessions.** `raw <event> <json>`
  emits anything at all, which is how you test a handler before there is a UI for it.
  `backend/requests/socket.md` is its manual and carries both cookie-jar traps.
- **Two dev-only route groups remain, both now dated for S37**: `/_probe/tables/:id/seats*` (kept
  against S24's instruction — see the Phase F decisions) and `GET /_probe/wallet`. `POST /_probe`
  (S12) stays indefinitely.

### Standing rules from earlier phases

- **Every credit in the platform must go through `WalletService`.** `credit(input)` opens its own
  transaction; `creditWithin(repos, input)` joins one the caller already opened — that second form is
  what S36's settlement and S22's vesting use, and it is the only way to credit as part of a larger
  all-or-nothing transaction. Do not call `repos.wallets.append` from a service: it bypasses the caps
  and the derived-key check. The one exception in the codebase is the claim's mirror-negative and
  forfeit rows, which are deliberate ledger *movements* rather than earnings, and they are commented
  as such.
- **Idempotency keys come from `domain/economy/idempotency.ts`.** `matchRewardKey(matchResultId, seat)`
  is the one S36 wants — **per seat**, because an ejected player earns zero while their partner is
  paid in full, and one match therefore produces several distinct credits. Never assemble a key
  inline; `tests/unit/wallet/idempotency.test.ts` pins every format to 10 §2.4 as a literal.
- **`repos.rewardRules`, `repos.participants` and `IChatRepository.reattributeActor` are new.**
  `findForGame(slug, variant)` already implements S35's `slug:variant` → `slug` fallback, so do not
  re-derive it. `participants` is deliberately narrow — S36 grows it into the settlement repository.
- **The reward *formula* is S35 and does not exist yet.** S21 built the credit *path*: caps,
  idempotency, `CAP_REJECTED`. `RewardRule.baseAmount`, `placement`, `expectedMinMs` and
  `repeatDecay` are read into the domain by the mapper and nothing consumes them yet. `capMultiplier`
  on `CreditInput` is the hook premium uses in M7.
- **Two dev-only routes are now dated for deletion.** `/_probe/tables/:id/seats*` in **S24**, and
  `GET /_probe/wallet` in **S37**. Both are marked in `probe.routes.ts`. `POST /_probe` (S12) stays.
- **All four access levels now exist.** `requireIdentity()` (**G**), `requireUser()` (**U**),
  `requireHost(container.tables)` (**H**, stashes the row on `req.table`), `requireRole(...)` (**A**,
  admin process only).
- **Route wiring is a three-line pattern and there are now five routers.** `buildXRouter(container)`
  in `interface/http/routes/`, mounted under `API_PREFIX` in `app.ts`. Copy `tables.routes.ts`: it
  is the fullest example — `zodValidate({ params, body })`, then a guard, then a thin handler. Note
  the ordering trap it documents: `/tables/mine` **must** be declared before `/tables/:id`.
- **`GameCatalogService` is the gate for anything game-shaped.** `assertPlayable(slug, seatCount)`
  and `parseOptions(meta, options)` — do not reach into `container.registry` to re-derive them. The
  registry is exposed for the socket gateway (S24) and for S30's engines.
- **Delete the seat routes from `probe.routes.ts` in S24**, once `table:takeSeat` calls the same
  `TableService.claimSeat`. They are marked and dated in the file's docblock. `POST /_probe` (S12)
  stays.
- **`enforceGuestBinding(container.guests)` now sits on `GET /tables/:id` and the probe seat
  routes.** It reads `:tableId` or `:id` from the params, so any new table-scoped route gets the
  403 + `SEAT_IMPERSONATION` row by adding one middleware.
- **Test fixtures for a table:** `registerUser(app)` → cookie agent; `POST /tables` with
  `{ gameSlug: 'fixture', seatCount: 4, options: {} }`; and `tests/helpers/db.ts` has `makeUser`,
  `makeTable`, `makeGuest`, `makeGame`, `makeWallet` for rows you do not want to create over HTTP.
  `tests/integration/seat-claim.test.ts` shows how to build a second `TableService` over a fake
  registry when you need a game shape the catalog does not offer (it is how team assignment is
  proven before Shelem exists).
- **Tests: use `tests/helpers/app.ts`.** `buildTestApp()` gives `{ app, container, resetLimits }`.
  **Call `resetLimits()` in `beforeEach`** — the app is built once per file, so without it the second
  half of a file runs against a budget the first half already spent, and the failures look like auth
  bugs rather than rate limits. `registerUser(app)` returns a cookie-carrying agent.
- **`buildApp(container)` takes the container.** `buildContainer` accepts
  `{ prisma, logger, env, rateLimiter }` overrides.
- **`requests/tables.http` and `requests/wallet.http` exist** and cover all of Phases D and E in the
  same style: every block says what the response should be and why it matters. `wallet.http` walks
  journey J2 end to end. Grow them, or start `requests/socket.md` alongside `dev-socket.ts` for S23.
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

## The Postman collection (`postman/`, added 2026-09-09)

`Template.postman_collection.json` + `Template.local.postman_environment.json`. Import both, pick
the **Template — local** environment, and run the collection top to bottom: **71 requests, 99
assertions**, folders `00 Health` → `09 Teardown`. It is a smoke test of the REST surface, not a
replacement for Vitest — concurrency, rollback, ledger arithmetic, audit rows and the leak checks
live there.

**It must grow with every phase** (step 5 of the protocol above), and it must be *run*, not just
edited:

```bash
# 1. an API this side of the WSL/Windows split, without touching prisma/dev.db
cd backend
npm run build                                     # tsc is pure JS — works from WSL
cp prisma/dev.db prisma/postman-check.db          # ★ BEFORE starting the server
DATABASE_URL="file:./postman-check.db" PORT=3999 node dist/main.js &

# 2. run it — ONCE. See the budget note below.
cd .. && npx --yes newman run postman/Template.postman_collection.json \
  -e postman/Template.local-3999.postman_environment.json

# 3. clean up
rm backend/prisma/postman-check.db && rm -rf backend/dist
```

**Swap the database file *before* the server starts, never while it is running.** Cost an hour
during S22: `rm && cp` on `postman-check.db` under a live server leaves SQLite holding a handle to
the deleted inode, so every request afterwards fails against a database nobody can see — and the
symptom is a wall of 401s and `tableId: null` that reads exactly like a broken collection. To rerun,
stop the server, re-copy, start it again.

`npm run dev` cannot be used for this from WSL (tsx → esbuild is Windows-only in this tree), and
**`PORT=... node.exe` does not work either**: WSL does not pass environment variables to Windows
processes unless they are listed in `WSLENV`, so the server silently boots on `:3000` against
`dev.db`. Building and running with WSL's own node sidesteps both — the Linux Prisma engine is
already generated.

Five things about the collection worth remembering:

- **★ `auth:create` is now the tightest budget in the collection — 8 of 10.** `/auth/register`,
  `/auth/guest` and `/auth/guest/claim` share one bucket of **10 per minute per IP**, because each
  mints an account and burns an argon2 hash and an attacker must not get ten of each. One full run
  spends eight of them (register, two guest joins in folder 06, one join and four claims in folder
  07). So folder 07 is the *first* place a too-soon rerun 429s — before the global 100/min limiter
  ever bites — and **a full minute between runs is now mandatory**, not merely advisable. If you add
  a request that registers, joins as a guest, or claims, take one out. One check was already removed
  for this reason (see folder 07's description).
- **A logged-in user masks a guest.** `authenticate` resolves the access cookie *before* the guest
  cookie, so with both in Postman's jar you are always the user. Folders `06` and `07` clear the jar
  in a pre-request script and log back in at the end. Any new guest-facing request must sit inside
  one of those folders, or it will silently assert the host's behaviour.
- **Folder 07 runs against a table with history.** Folder 05 left a bot at seat 3 and released seat
  1, so the claim journey uses seat **2** — which is worth knowing before adding a seat assertion
  anywhere. And the seat map's `memberId` is what makes the headline claim assertion possible over
  REST at all: the collection captures it before the claim and demands the same value after.
- **No CSRF token anywhere, correctly.** Postman sends no `Origin`/`Referer`, so the double-submit
  token is not demanded. Adding an `Origin` header by hand requires `X-CSRF-Token` too.
- **It found a real bug on its first run** — see the alphabet row in the Phase D decisions.
- **★ Folder 07 is why `/_probe/tables/:id/seats` still exists.** S24 dated those routes for
  deletion once `table:takeSeat` shipped, and it has — but **Newman cannot speak Socket.IO**, and
  folder 07 uses them to seat a guest before asserting that `memberId` and `joinedAt` survive the
  claim. That is the one assertion distinguishing an *updated* seat from a delete-and-reinsert, and
  therefore the headline check of journey J2. Re-dated for S37. If you ever do delete them, delete
  folder 07's seat setup in the same commit and say out loud what coverage went with it.
- **Phase F added no REST routes**, so the collection is unchanged — and was re-run against Phase F
  to prove nothing broke: **71 requests, 99 assertions, 0 failures**. The socket surface is verified
  by `backend/requests/socket.md` and by 60 socket tests instead.
