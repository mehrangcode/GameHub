# Live Context — read this first, every session

**Last updated:** 2026-09-14

## Where we are

| | |
|---|---|
| **Milestone** | M0 — Platform Skeleton |
| **Last session completed** | **S01–S44 (Phases A–J) built and green — Phase J not yet verified by Mehrang** |
| **Next session** | **S45 — Dockerfiles, dev compose, CI** (3 h, 🖥️) — starts Phase K, ship |
| **Blocked on** | Nothing in code. The two older environment items only (port 3000, Playwright deps) |
| **Repo state** | `backend/` and `frontend/` exist. **1707 backend tests**, **154 frontend tests**. No `admin-frontend/` (MA) |

Session spec for S45: `Documents/11-build-plan.md` §12.

**All three of M0's headline exit criteria run, and the third one is now
clickable** — the welcome page renders its cards from `GET /api/v1/games`.

*An idle player is warned, struck twice, ejected, replaced by a bot, and the table
plays on to a finish* — `tests/integration/ejection.test.ts` walks that sentence,
and `requests/socket.md`'s Phase H section walks it by hand in two terminals.

*An ejected player on a winning team earns 0; their partner earns in full* —
`tests/integration/reward-settlement.test.ts` walks that one, and its last block
runs the whole real pipeline: nobody in that test calls `settle`, the move
pipeline does it.

*A corrupted balance is detectable* — `scripts/dev-corrupt-balance.ts` breaks
invariant E1 on purpose and `scripts/dev-reconcile.ts` catches it. **This one is
worth doing by hand**; it is two commands and it is the whole economy's
foundation.

## Phase J — what to verify (the gate for S39–S44)

**The design direction is settled.** Mehrang chose `Samples/04-aurora-glass.html`
on 2026-09-14; its tokens are now `frontend/src/styles/tokens.css` and
`Documents/13-design-system.md` explains the system and the rules for extending
it. Fonts are **self-hosted** (`frontend/scripts/fetch-fonts.mjs` regenerates
them) so no page load reaches a third party.

```bash
cd frontend
npm run typecheck && npm run lint && npm test        # 154 tests, 12 files
npm run build                                        # ~150 kB gzip entry chunk
```

**The names to read, in order of what they protect:**

| Test | What breaks without it |
|---|---|
| `★ five concurrent 401s trigger EXACTLY ONE /auth/refresh` | S14 **rotates** refresh tokens and kills the family on reuse, so five parallel refreshes are read as a stolen-token replay — and the user is signed out for loading a page with five widgets |
| `★ a sixth game the frontend has never heard of appears — P5 on the client` | The welcome page quietly becomes a hard-coded list, and game #6 needs a frontend deploy |
| `★ every en key in "<ns>" has a fa counterpart` | Persian rots **silently**: nobody on the team reads the Persian build, so a failing test is the only thing that notices |
| `★ every i18nKey the backend can emit renders in en` / `…and in fa` | Greps the **backend source** for the keys it actually sends. A key the server sends and the client cannot render is untranslatable prose in front of a user |
| `★ renders the true remaining time when the device clock is 10 minutes fast` | The highest-stakes number in the UI. A skewed clock shows a player time they do not have, and that deadline costs them the seat *and* the coins |
| `★★ a forfeited zero is EXPLAINED, with its reason and a link to the rule` | A silent zero is indistinguishable from a broken payout — and a player who assumes a bug is *correct* to, because a bug looks the same |
| `★ /table/:tableId is RequireIdentity, NOT RequireUser — guests may play` | The signup wall comes back, silently, via a well-meaning refactor |
| `★ /t/:inviteCode has NO guard` | Journey J1→J2 dies: the link stops working in a private window |
| `renders the same message for an expired code and an unknown one` | The UI undoes the server's own care and becomes an oracle for enumerating live invite codes (07 §5.2) |
| `★ switching to fa sets BOTH <html lang> and <html dir>` | Nothing mirrors. Every piece of layout assumes this one attribute is right |
| `★ the no-derivation rule (P1)` | Reads `gameStore`'s own source and fails on `reduce`, `52 -`, `% 4`, `trump`. Crude, and the only thing that catches "I just needed the remaining card count" before it ships |
| `★ creates EXACTLY ONE socket across many acquires` | StrictMode opens a second and fast refresh a third; everything then works *twice*, which is miserable to debug |
| `★ consumes NO invite use — a refresh must not burn the link` | A signed-in user refreshing the invite page burns two uses of a `maxUses: 2` link and locks out the friend it was for |

```bash
# S39 — the refresh, and the shared-schema forms.
npx vitest run tests/api/client.test.ts tests/features/auth.test.tsx --reporter=verbose

# S40 — parity, and the backend-key sweep. Delete a fa key and watch it fail.
npx vitest run tests/i18n tests/stores/themeStore.test.ts tests/lib --reporter=verbose

# S41 — registry-driven, including the sixth game.
npx vitest run tests/features/welcome.test.tsx --reporter=verbose

# S42 — seq handling and the one-socket rule.
npx vitest run tests/stores/gameStore.test.ts tests/socket --reporter=verbose

# S43 + S44 — the invite screen and the table shell.
npx vitest run tests/features/invite.test.tsx tests/features/table.test.tsx --reporter=verbose
```

### Live — the part worth doing by hand

```bash
cd backend && PORT=3999 npm run dev        # port 3000 is occupied on this machine
# then, in frontend/, point the proxy at 3999 or free 3000, and:
cd frontend && npm run dev                  # :5173
```

1. **`/` — the welcome page.** Five cards, all *Coming soon*, each with its
   published coin rate from the **public** `GET /rewards/rules`.
   ★ Then add a fake sixth game to `backend/src/domain/games/registry.ts`,
   restart the backend, and **refresh the browser**: a sixth card appears with
   no frontend change at all.
2. **The فا button.** The whole layout mirrors — nav, forms, spacing, the timer
   ring's drain direction. DevTools should show `<html dir="rtl" lang="fa">`.
   Reload: the choice persists. ★ Nothing should be clipped or half-mirrored;
   if something is, find the physical CSS property rather than adding an
   override.
3. **`/register`.** Type a 5-character password → the message is
   *"Use at least 10 characters."*, which is the **server's own key**
   rendered client-side. Switch to Persian and do it again.
4. **Reload while signed in** — still signed in. DevTools → Application →
   Cookies: `access`/`refresh` are `httpOnly`, and **localStorage holds no
   token** (only `preferences`, `locale`, `guestName`, `dismissedNudges`).
5. **★★ The invite journey, in a private window.** Create a table and an invite
   (see `requests/tables.http`), open `/t/<CODE>` in a private window, type a
   name, click **Play now**. You are at the table with **no account**. Reload —
   still there. Then use the signup nudge and land **back in the same seat**.

## Phase I — what to verify (the gate for S35–S38)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 1657 tests
```

**The names to read, in order of what they protect:**

| Test | What breaks without it |
|---|---|
| `★★ seat 1 is ejected on the WINNING team — 0 coins, forfeited; seat 3 gets the full amount` | **The M0 reward criterion.** Asserted from *both* ends on purpose: a settlement that paid nobody would satisfy the zero alone, and a broken reward path looks identical to a correctly-applied penalty from the punished seat |
| `★★ a hand-corrupted balance is caught, reported, and ALERTed` | E1 stops being a measurement and goes back to being a claim |
| `★ …and does NOT repair it — a silent self-heal erases the evidence` | The job "fixes" the symptom and the write path that lied is never found |
| `★★ two concurrent debits, one item's worth of coins ⇒ exactly one succeeds` | The real double-spend. A read-then-write without the row lock passes every other test in the file |
| `★★ EJECTED_TIMEOUT earns 0 at RANK 1 — the exit criterion, in one line` | The rule becomes conditional on rank, which is the one case it exists for |
| `★ the forfeit is RECORDED, never silent — a CAP_REJECTED row saying why` | "Why did I get no coins?" is unanswerable, and a player who cannot see why assumes a bug — correctly, because a bug looks the same |
| `★ settling twice credits NOTHING twice, and writes no second set of rows` | A retried finish pays the table twice |
| `★ a throw mid-loop rolls the WHOLE match back — no result, no partial credits` | A half-paid match, which has no correct repair |
| `★ a bot seat produces a participant row and NO wallet transaction of any kind` | A ledger row that belongs to nobody, which the reconciliation job then has to reason about |
| `★ a guest is refused: a statement is an account feature` / `★ a guest cannot spend` | Farmed provisional coins become convertible before signup, and the vesting cap bounds nothing |
| `★ §3.5 — the same four people meeting a third time inside 30 minutes decay to 0.6×` | The farming guard is a constant in a document rather than a query |
| `★ E3 — the breakdown exposes no gameplay field for premium to buy` | Premium starts drifting toward pay-to-win one convenient field at a time |
| `★ a second result for the same game THROWS` | The match-level half of idempotency, which the per-seat key cannot provide |

```bash
# S35 — the formula, checked against 10 §3.2–3.6 row for row. No database at all.
npx vitest run tests/unit/rewards/compute.test.ts --reporter=verbose

# S36 — ⭐ the exit criterion, idempotency, rollback, bots, guests, decay, premium.
npx vitest run tests/integration/reward-settlement.test.ts --reporter=verbose

# S37 — the three access levels, and the CAP_REJECTED row that stays visible.
npx vitest run tests/integration/wallet/reads.test.ts --reporter=verbose

# S38 — the double-spend race and the corrupted balance.
npx vitest run tests/integration/wallet-debit.test.ts tests/integration/reconciliation.test.ts \
  --reporter=verbose

# And the two new repositories, against the fakes AND SQLite (every name twice).
npx vitest run tests/unit/repositories/contract/matches.test.ts --reporter=verbose
```

### Live — the one that is worth doing by hand

```bash
cd backend
npm run db:reset          # re-seeds the RewardRule rows the whole economy reads
PORT=3999 npm run dev

API=localhost:3999/api/v1

# 1. the rate card, with no cookie at all. THIS IS DELIBERATE (10 §11).
curl -s $API/rewards/rules | jq '{premiumMultiplier, caps, integrityFactors}'
curl -s $API/rewards/rules | jq '.rules[] | {id, base}'
#   ★ Shelem 80 is the best rate in the list. That is product design, not an
#     accident: it asks for 45 minutes and three other people.
#   ★ integrityFactors.EJECTED_TIMEOUT is 0 — forfeiture is a PUBLISHED rule
#     somebody could have read beforehand, not a surprise after the fact.

# 2. a wallet, and a statement
curl -sc /tmp/c.txt -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"correct-horse-battery","displayName":"Mehrang"}' >/dev/null
curl -sb /tmp/c.txt $API/wallet | jq
#   → three wallets, all VESTED. `/_probe/wallet` is GONE — this is the real route.

npx tsx scripts/dev-credit.ts --email me@test.dev --amount 500
curl -sb /tmp/c.txt 'localhost:3999/api/v1/wallet/transactions?limit=10' \
  | jq '.items[] | {kind, amount, balanceAfter, reason}'
#   ★ `reason` is a machine code, never an English sentence. A Persian reader
#     renders the statement without a round-trip through the server.

curl -s -b /tmp/c.txt "$API/wallet/transactions?holder=somebody-else" | jq .code
#   → VALIDATION_FAILED. There is no field with which to ask for another
#     person's statement, and supplying one is refused rather than ignored.

# 3. ★★ THE ONE TO ACTUALLY DO: break E1 and watch it be caught.
npx tsx scripts/dev-corrupt-balance.ts --email me@test.dev --set 999999
npx tsx scripts/dev-reconcile.ts
#   → ALERT: wallet <id> cached 999999, computed 500, drift +999499
#   → exit code 1, so a cron entry can page on it directly

npm run db:studio
#   SecurityEvent: a LEDGER_DRIFT row, severity ALERT, with both numbers in
#   detailsJson.
#   ★★ AND THE THING TO LOOK HARDEST AT: Wallet.balance is STILL 999999.
#      The job did not repair it, deliberately. "What is the balance" was never
#      the interesting question — the ledger always answered that. "Which write
#      path produced 999999" is, and a silent self-heal would have erased it.

npx tsx scripts/dev-corrupt-balance.ts --email me@test.dev --repair
npx tsx scripts/dev-reconcile.ts          # → clean, exit 0
```

**And the forfeiture, end to end, if you want to see coins not arrive:** run the
Phase H walk in `requests/socket.md` (go idle on seat 1, get ejected, let the bot
finish the match), then in Studio:

```
MatchParticipant     seat 1 → coinsAwarded 0, rewardForfeited true, outcome EJECTED_TIMEOUT
                     the other seat → the full amount
WalletTransaction    the ejected seat holds ONE row: CAP_REJECTED, amount 0,
                     reason 'EJECTED_TIMEOUT', refKind 'match'
```

That zero-amount row is the point. A reward silently not granted is
indistinguishable from a bug; a row with a reason makes "why did I get nothing?"
answerable from the ledger alone.

**Or in Postman:** folder `08 Rewards & the wallet (S35–S38)` covers the REST
surface with assertions attached. The collection is now **81 requests** across
eleven folders — folders `08` and `09` were renumbered to `09` and `10` to make
room, and folder 07's two `/_probe/wallet` calls now hit the real `GET /wallet`.

## Phase H — what to verify (the gate for S31–S34)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 1503 tests
```

**`backend/requests/socket.md` now carries a Phase H section** with the whole
escalation in real time. Read that rather than this summary if you are actually
sitting down to do it — it is about a minute of deliberately doing nothing.

**The names to read, in order of what they protect:**

| Test | What breaks without it |
|---|---|
| `★★ two strikes eject seat 0, a bot takes over, and the table plays on to a finish` | **The M0 exit criterion.** Everything else in Phase H is the fairness around this one sentence |
| `★★ reaches the acting seat and NOBODY else` | A private warning becomes a public shaming — and tells the other players exactly when to expect a free trick |
| `★★ re-arms the IDENTICAL absolute deadline after a fresh container` | A deploy becomes a way to buy thinking time. Asserts the *same instant*, never "roughly 30 seconds" |
| `★ EJECTED_TIMEOUT and EJECTED_ABANDON stay distinct` | 04 §5.2's explicit warning, and 10 §5.1 pays the two differently. One `EJECTED` value would erase it forever |
| `★ ejection is idempotent — a second expiry does not double-eject` | Both timers point at one seat and can genuinely both fire. A double ejection resets the reclaim window and makes the player's own seat final |
| `★ a returned player is REPLACED_RETURNED even though the ejection is still logged` | A reclaim *clears* the member row, so the log is the only thing that remembers. Without it, coming back pays the same as never leaving |
| `★ strikesResetOnAction: true — a real move clears the count` | Strikes become a lifetime record, and one lapse now plus one twenty minutes ago ejects somebody mid-match |
| `★ its default action is PASS, never PRESS` | The per-game version of 04 §6.5. M2 and M5 reuse this shape for "never auto-hit" and "never auto-call" |
| `★ the bot never plays an illegal move — 300 seeds` | A bot is *our* code and gets no more trust than a client |
| `★ rejects an engine importing the turn timer service` | An engine that can reach a timer can read a clock, and invariant I1 stops being checkable |
| `★ and the two Phase H additions send no game state down that channel` | The seat-room allowlist grew by two files; this is what keeps growing it cheap and safe |

```bash
# S31 + S32 — deadlines, the private warning, and the strike ladder.
npx vitest run tests/integration/turn-timer.test.ts --reporter=verbose

# S33 + S34 — the exit criterion, the two reasons, the reclaim matrix, the restart.
npx vitest run tests/integration/ejection.test.ts --reporter=verbose

# The pure half: the options schema, the outcome mapper, the narration vocabulary.
npx vitest run tests/unit/turn-enforcement.test.ts --reporter=verbose

# And over a real socket, where the privacy actually lives.
npx vitest run tests/integration/socket/turn-enforcement.test.ts --reporter=verbose
```

### Live — two terminals, and a minute of doing nothing

```bash
PORT=3999 npm run dev
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID --seat 0
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt --join $TID --seat 1
```

`start`, then `idle` in terminal 1. At t−10 s terminal 1 alone prints
`game:ejectionWarning`; at t−0 **both** print `game:event { kind: 'TURN_TIMEOUT',
strikes: 1 }` and play moves on. Press once from terminal 2, lapse again, and
terminal 1 is ejected, replaced by a bot, and told it will earn nothing. Keep
pressing in terminal 2 until the bot finishes the match.

**★★ The one thing to look hardest at:** terminal 2 never sees the warning or the
reward preview. Both are seat-private (04 §6.2, §6.6); everything else is public.

Then `reclaim` inside 120 s (→ `REPLACED_RETURNED`, 0.5×) and after it (→
`SEAT_NOT_RECLAIMABLE`). Finally, note an `endsAt`, kill the server, wait ten
seconds, restart, and confirm the re-armed deadline is the **same instant**.

## Phase G — what to verify (the gate for S28–S30)

```bash
cd backend
npm run typecheck && npm run lint && npm test          # 1427 tests
```

**`backend/requests/socket.md` now carries a Phase G section** with the whole two-terminal walk.
Read that rather than this summary if you are actually sitting down to do it.

**The names to read, in order of what they protect:**

| Test | What breaks without it |
|---|---|
| `★ seat 0 receives its own secret; seat 1 receives a different payload without it` | **The entire point of the project.** One state, N payloads — if this ever passes by both being empty, check the next row too |
| `★ two viewers of one state receive different payloads` | An engine that hides everything from everybody passes every leak test and is unplayable |
| `★ the leak suite: no seat, and no spectator, sees another seat's secret` | The generic harness M1–M6 reuse unchanged. A per-game leak test written five times is written well once and badly four times |
| `★ rngSeed appears in no payload before finishedAt` | The deal becomes predictable from a broadcast, and the commitment proves nothing |
| `★ seedCommit is sha256(rngSeed + gameId), recomputed here by hand` | The provable shuffle stops being provable |
| `★ a server restart loses nothing` | The reason there is no `Map<gameId, state>` anywhere. A deploy mid-hand costs a reconnect, not a game |
| `★ rebuilding from a snapshot agrees with rebuilding from event 0` | A snapshot quietly changes the game — which is what a shared, position-dependent RNG would have caused |
| `★ the same clientMoveId twice → one event` | A socket retry plays a second card |
| `★ the rejected key is in the payload, never in the clientMoveId column` | A player whose move was refused can never retry a corrected one under the same key |
| `★ a payload that names a seat is REJECTED, not merely ignored` | The seat-impersonation class re-opens at the one event that matters |
| `★ advance() terminates` | A request hangs instead of failing |
| `★ replayFixture is byte-identical across two runs` | `(seed, moves[])` stops reproducing a hand, and every bug report stays a story |
| `★ removes old snapshots and zero events` | The log is the match. Pruning it deletes the history that pays people |

```bash
# S28 — the log, the ordering, and the commitment.
npx vitest run tests/integration/event-log.test.ts --reporter=verbose
#   The `prisma:error  Unique constraint failed on … (gameId, seq)` lines in
#   that output are the retry loop working, not a fault — same as S20's.

# S29 — rebuild, snapshots, resync, and the restart.
npx vitest run tests/integration/game-rebuild.test.ts --reporter=verbose

# S30 — the pipeline over a real socket, with two real clients.
npx vitest run tests/integration/socket/game.test.ts --reporter=verbose

# The engine, and the five invariants by name. This file is the template every
# real engine's suite is copied from at M1.
npx vitest run tests/unit/games/fixture-engine.test.ts --reporter=verbose

# And the guard that changed shape this phase:
npx vitest run tests/unit/socket/projection-boundary.test.ts --reporter=verbose
```

### Live — two terminals, and the thing they must disagree about

```bash
PORT=3999 npm run dev
# set up a host, a 2-seat fixture table, an invite and a guest —
# see requests/socket.md, the Phase G section, which has the exact curls
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID --seat 0
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt --join $TID --seat 1
```

Terminal 1: `start` → both print `game:started` with a 64-hex `seedCommit`, **then** `game:state`.

**★★ The one thing to look hardest at:** put the two `game:state` payloads side by side.
`view.secret` is a 7-digit number in each, and they are **different**; neither payload contains the
other's number anywhere. `legalMoves` is populated for seat 0 and `null` for seat 1. Everything else
is identical. That difference is one server-side state through `projectState` twice — the whole
anti-cheat architecture, visible.

Then `press` in terminal 1 (both see `game:event` + a fresh `game:state`), `press` again (→
`NOT_YOUR_TURN` plus a `game:moveRejected` on that socket alone), and:

```
raw game:move {"gameId":"<GID>","move":{"kind":"press"},"clientMoveId":"x","seat":0}
→ ✗ VALIDATION_FAILED { seat: ['errors.field.unknownKey'] }
```

**Then kill the server mid-game and restart it** — `PORT=3999 npm run dev`. Re-`join`, then `sync 0`
(→ `delta`, the missed events then one state) and `sync` with no argument (→ `full`). The presses
from before the restart are still in `counts`. That is the property; nothing was in memory to lose.

Finish the game and watch `dev-socket` print `✓ deal verified`, then confirm it yourself:

```bash
npx tsx scripts/dev-verify-commit.ts --latest
```

`npm run db:studio` → `GameEvent` has contiguous `seq`, one `MOVE` per press, an `AUDIT` row per
rejection whose **`clientMoveId` column is null** (the key is in the payload), and `GameSnapshot` has
a row every 25 events plus one at `FINISHED`.

## ⚠ `backend/node_modules` is now **WSL**-owned (flipped 2026-09-09 by S23)

Phase F added four dependencies — `socket.io`, `ioredis`, `@socket.io/redis-adapter`, and
`socket.io-client` (dev) — and the install ran from **WSL**, so `esbuild`/`rollup` swapped to their
Linux binaries. `npm run db:generate` was re-run afterwards, so both Prisma engines are present.

**To run `npm test` in `backend/` from Windows, re-run `npm install` there first.** Nothing else
needs doing — the Prisma client is dual-target and `argon2` ships prebuilds for both.

### ⚠ Update, 2026-09-12 (S31–S34): `backend/` is **Windows**-owned again, and now runs from both

Something re-ran `npm install` from Windows between Phase G and Phase H, so `esbuild` and `rollup`
had swapped back to their win32 binaries and Vitest would not start under WSL. Rather than flip the
whole tree a third time, the two **Linux** binaries were unpacked *alongside* the Windows ones:

```bash
npm pack @rollup/rollup-linux-x64-gnu@4.63.1 @esbuild/linux-x64@0.28.2   # in a temp dir
tar xzf rollup-…tgz -C node_modules/@rollup/rollup-linux-x64-gnu --strip-components=1
tar xzf esbuild-…tgz -C node_modules/@esbuild/linux-x64      --strip-components=1
```

`node_modules/@rollup/` and `node_modules/@esbuild/` now hold **both** platforms, exactly as
`.prisma/client` already holds both query engines, so `npm test` runs from Windows *and* from WSL
with no further work. **Any future `npm install` from either OS will drop the other platform's
binaries again** — the two commands above restore them in about ten seconds, and the versions must
match `node_modules/rollup/package.json` and `node_modules/esbuild/package.json` exactly.

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
including the `memberId`/`joinedAt` comparison. 82 requests, 120 assertions, 0 failures expected —
see the note at the bottom of this file about its **budget**, which Phase I made tight in two
places at once (`auth:create` at 9 of 10, and 82 requests against a 100/min global limit).

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
`backend/` back to Windows is the likelier need, since that is where the 1427 tests are.

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

## Decisions made while building Phase J (2026-09-14)

| Decision | Value | Why |
|---|---|---|
| **★ Direction 04 "Aurora Glass" adopted whole** | `frontend/src/styles/tokens.css` + `Documents/13-design-system.md` | **Mehrang's choice.** All five samples declared the same token *names*, so picking one was a values decision rather than an architecture one — which is exactly what made the promotion a copy of two `:root` blocks instead of a restyling exercise |
| **Tokens landed BEFORE S39, not at S40 as scheduled** | Mehrang's call | The alternative was building the auth forms against the S02 placeholder styling and restyling them a session later. The build plan's order assumed the design was still open; it was not |
| **★ Fonts are self-hosted, not CDN** | `scripts/fetch-fonts.mjs` → 15 woff2, 584 KB | No third-party request on page load, the container builds offline, and Vazirmatn ships only the subsets a Persian reader needs. Each face is `unicode-range`-scoped, so an English reader downloads none of the Arabic ones. **Mehrang's choice** |
| **★ `:root:lang(fa)` swaps the WHOLE font stack** | not just a fallback append | Outfit and DM Sans have no Arabic coverage. Leaving them first falls back per-glyph and mixes two faces inside a single Persian word — a subtle, ugly bug that only a Persian reader would report |
| **★ `themeStore` resolves `'system'`; `tokens.css` has ONE dark block** | no `prefers-color-scheme` duplicate | The store stamps a concrete `data-theme`, so the dark palette has exactly one selector. Duplicating it under a media query is how the two copies drift, and the drift is invisible until somebody toggles |
| **★ The i18next namespace IS the first segment of every server key** | `errors.*`, `table.*`, `games.*` | `errors.field.tooBig` splits into `errors:field.tooBig` with no mapping table to maintain. `translateServerKey` is the one place a wire key becomes words, and an unknown key degrades to the generic message rather than printing raw debug output at a user |
| **★ `ZOD_ISSUE_KEYS` moved into `contracts/`** | `contracts/validation.ts` | The forms validate with the **same schemas** the server does, so they must produce the **same message**. A third consumer appeared (the browser) and the table had to stop living behind the REST boundary. `i18nKeyFor` stayed in `interface/`, since `contracts/` may not declare functions |
| **★ A hand-written localized Zod resolver, not `@hookform/resolvers`** | `lib/zodResolver.ts` | Configuring that library's error map to reach the same table would hide the one thing this file exists to guarantee. The mapping is four lines; the alternative is four lines of indirection |
| **★ Gap detection tolerates a hole of exactly ONE** | `SEQ_GAP_TOLERANCE = 1` | `seq` is **not contiguous on any channel**: the server persists a turn deadline as an event and deliberately does not narrate it (`isTimerEvent`), so a one-number hole is the ordinary case *once per turn*. A strict `seq === last + 1` rule would resync on every single turn of every match |
| **…and the heuristic is not what makes recovery correct** | resync on `connect` + on `game:syncRequired` | On a live socket.io connection delivery is ordered and reliable, so the only way to miss a message is a disconnect — and the transport tells us when one ends. The seq rule is a belt to that braces |
| **★ `game:state` is applied even when a gap is detected** | newest state wins | It is a *complete* projection, not a delta. Holding it back to wait for a narration backfill would freeze the board to preserve a move log |
| **★ The socket is reference-counted and never closed on release** | `socketManager.acquire/release` | Navigating table → lobby → table must not renegotiate a websocket. An idle connection costs the server almost nothing; a reconnect costs the player a resync |
| **★ `axios.isAxiosError`, never `instanceof AxiosError`** | caught by the test suite | The class identity check fails silently whenever two copies of axios exist, and the failure mode is *every* server error becoming an opaque INTERNAL with no refresh ever attempted. It cost an hour to see, and it would have cost far more in production |
| **★ `GET/PUT /me/preferences` had to be BUILT — S40 assumed it existed** | `me.routes.ts`, level **U** | The build plan says "wired"; the route did not exist. `IPreferencesRepository` and the Prisma model already did, so it was small. **`requireUser`, not `requireIdentity`**: a guest has no row, their choices live in `localStorage`, and they arrive with the claim (03 §6.1 step 3) |
| **★ `POST /invites/:code/redeem` had to be built too** | `invites.routes.ts`, level **U** | S43 asks for "a signed-in-user path" and there was none: `resolve` withholds `tableId` from *everyone* (correct — a leaked code must not leak the table id), which left a user with no way in short of becoming a guest and stranding their coins in a provisional wallet |
| **★★ …and it consumes NO invite use** | corrected mid-session | The first version consumed one, guarded by an "already a member?" check. **That guard never fires**: membership is created by `table:join` over the *socket*, not by this route. So a user refreshing the invite page would burn two uses of a `maxUses: 2` link and lock out the friend it was minted for. `maxUses` counts guest *identities* minted against a link; this route mints none, so it consumes none — same as the public resolve |
| **Failures answer byte-identically to the public resolve** | the same `refuse` | An account must not be a cheaper oracle for enumerating live codes than anonymity is (07 §5.2). Asserted by comparing the two bodies directly |
| **★ `formatNumber` keeps fractions for multipliers** | `maximumFractionDigits`, default 0 | Caught by a test: the integer default rendered a 1.5× premium as **"×2"** and a 0.6× decay as "×1", so the reward breakdown contradicted the total it existed to explain — on the one screen whose whole job is making the arithmetic checkable (10 §11) |
| **★ Ids and codes are never converted to Persian digits** | structural, not a flag | `format.ts` exposes no function that would convert an identifier. An invite code in Persian digits is untypeable and unsearchable |
| **★ Route guards are components, not loaders** | `RequireIdentity` / `RequireUser` | A loader runs once, at navigation. Identity can be lost **mid-session** — a refresh that fails while the tab sits open — and a component re-renders when the store changes, so the redirect happens then too |
| **A guest hitting `RequireUser` goes to `/register`, not `/login`** | `guards.tsx` | They have no account to sign into. "Sign in" is a dead end that reads as a rejection at the exact moment we are asking them to convert |
| **★ `themeStore` is the ONLY thing that writes `document.documentElement`** | one `subscribeWithSelector` | That is what makes a cosmetic a variable swap with no re-render (06 §6.1), rather than a prop threaded through forty components |
| **Bootstrap runs at module scope, not in a `useEffect`** | `main.tsx` | It starts during module evaluation instead of after first paint, and StrictMode's double-invoke cannot double it. `status: 'unknown'` holds the guards until it resolves, so a valid session never flashes the signed-out chrome |
| **★ No optimistic game updates; chat IS optimistic** | `markPending` only | Not an inconsistency: a chat line is adjudicated by nothing, a card is adjudicated by an engine. An optimistic play the server rejects is worse than 80 ms of latency |
| **`socket.io-client` is its own chunk** | `vite.config.ts` | The welcome page, the login form and the invite landing page never open a socket. Entry chunk: **150 kB gzip**, inside 06 §8's 200 kB budget |
| **The stylelint-guard timeout was raised, not the test weakened** | 30 s | Stylelint's first `lint()` loads its whole rule set (~2 s) and exceeded the 5 s default under parallel load. It was the intermittent frontend failure noted since S02; it is a startup cost, not a slow assertion |

## Decisions made while building Phase I (2026-09-13)

| Decision | Value | Why |
|---|---|---|
| **★ `integrityFactorOf('RESIGNED')` corrected from 1 to 0.25** | `application/mappers/outcomes.ts` | A defect from S33, caught at S35 when the function got its first consumer. 10 §5.2 rule 2 is explicit: *"resigning pays a little, being ejected pays nothing"* — conceding a lost position promptly gives the other three their evening back, and the gap between 0.25 and 0 is exactly how much that courtesy is worth. `KICKED` stays at **1**, against 10 §5.1's own table, because CLAUDE.md's hard rule wins: a platform-initiated removal forfeits nothing (12 A8) |
| **★ `RewardService.compute` is `static` and takes a plain record** | no clock, no repositories, no instance state | `11` S35 asks for a pure function; making it static is what makes the purity *checkable* rather than asserted. `tests/unit/rewards/compute.test.ts` has no database, no container and no `beforeEach` — which is also the proof that reward policy lives outside the engines (10 §5.3) and therefore that invariant I1 still holds. The three lookups the formula needs (`ruleFor`, `premiumMultiplierFor`, `repeatIndexFor`) are instance methods, deliberately kept out of it |
| **★ A reward of zero always carries a reason, and the reason is written down twice** | machine code on the ledger, i18n key on the socket | 10 §5.2 rule 6 spells the forfeiture row out as `reason: 'EJECTED_TIMEOUT'` and that is the right shape for the ledger — it is read by operators, by the admin console and by the reconciliation job, none of which should reverse a translation key. The i18n key (`games.reward.forfeitedTimeout`) travels on `game:rewardSettled` instead, where a human is reading it. Two audiences, two vocabularies, one decision |
| **★ `forfeited` is only true when there was something to lose** | `integrity === 0 && cleanAmount > 0` | `MatchParticipant.rewardForfeited` means *"the match paid, and this seat alone was zeroed"*. A seat that would have earned 0 anyway — an ineligible table, a 30-second match — has not been punished, and marking it forfeited would make the post-match screen accuse the platform of a penalty it never applied |
| **★ §3.5's matchup signature is identities only, never the game** | `sha256(sorted(human holder keys))` | 10 §3.5 says "the same set of identities", and reading it literally is also the only reading that cannot be gamed: keying by game would hand a farmer a bypass so cheap it is an accident waiting to happen — alternate two games and every match pays 1.0× forever. Honest play never reaches the tail either way, because four people cannot finish three real Shelem matches in half an hour. **Mehrang chose this explicitly** over the per-game alternative |
| **…and the lookup is scoped to one player, so it needs no signature column** | `listRecentHolderSetsFor(holder, since)` | Asking "which matches did *this person* finish in the last 30 minutes" returns a handful of rows on any platform; asking "which matches finished platform-wide" would have needed a column, an index, and a query that grows with the whole user base to answer a question about four people |
| **★ Premium is read for real at M0, and that is not payment code** | `ISubscriptionRepository`, read-only | `11` says no payment code before M7 and that still holds: no Stripe, no webhook, no checkout, no provider SDK. A `Subscription` row is, from here, one column saying whether the perks are live. It also finally consumes `CreditInput.capMultiplier`, declared unused at S21 — §3.7's "premium raises the caps by its multiplier, never removes them" would otherwise have stayed a comment |
| **`findActive` checks `currentPeriodEnd`, and honours `PAST_DUE` inside grace** | 10 §6.3 | Two departures from `status === 'ACTIVE'`, both deliberate: a row left `ACTIVE` by a webhook that never arrived would pay 1.5× forever, and taking somebody's earn rate away the hour their card expired punishes an administrative failure as if it were a lapse |
| **★ Settlement runs AFTER the move's transaction commits, in its own** | `GameSessionService.settle`, errors swallowed | Both directions matter. A failed wallet write must not un-play the last card — the log is the truth (P4), and a game that finished, finished. And a failed settlement must not turn a played card into a 500. The error is logged, `MatchResult` does not exist, so `reconcileActive()` picks the game up at the next boot and `settle` is idempotent besides. *Within* settlement a partially-paid match is still impossible, which is the property `11` S36 actually asks for |
| **★ Idempotency at two levels, doing different jobs** | `MatchResult.gameId` unique + `match:{id}:{seat}` | The seat key alone would let a replay write duplicate participants and stats while paying once; the match check alone is a read that two concurrent finishes can both pass. Between them a settlement can be attempted any number of times and land exactly once |
| **The preview is computed outside the transaction, then handed to it** | plan → `game:rewardPreview` → `uow.run(plan)` | 10 §11's ordering: a player sees the arithmetic *before* the number moves, so a forfeit reads as a rule rather than as a wallet that failed to change. Computing it twice would risk two answers; computing it inside the transaction would mean announcing after the fact |
| **★ A bot gets a `MatchParticipant` row and no ledger row at all** | not even a zero-amount one | 10 §12 case 9. A bot has no wallet to credit and nobody to explain a zero to; a `CAP_REJECTED` row for a bot would put money-shaped evidence in the ledger belonging to nobody, which the reconciliation job then has to reason about forever |
| **`Rating` and `RatingChange` stay empty; `PlayerStats` is written** | deferred to M1+ | ELO for a four-handed partnership game is a real design question — per seat or per team, against what expected score — and M0's only engine is `_fixture`. Designing the rating model against a test rig and redesigning it at M4 against Shelem is worse than not having one. **Mehrang's call.** `played`/`won`/`lost`/`drawn`/`forfeited`/streaks are unambiguous and land now |
| **A guest gets no `PlayerStats` row** | the model is keyed by `userId` | Inventing a guest-shaped stats table would be building the other half of an account for somebody who has not made one. Their history arrives with them at signup instead, through the claim's re-attribution of `MatchParticipant` (03 §6.1 step 7) — the same data, counted when it becomes permanent |
| **★ `holderRoom` joins the four room builders, and it *is* the holder key** | `user:{id}` / `guest:{id}` | `wallet:updated` has to reach a guest: they accrue coins (10 §3.4) and are entitled to watch them arrive. A notification path that worked only for accounts is how the guest experience quietly rots. Reusing `holderKey` means the room name and the wallet's owner are the same string by construction, not by convention |
| **`wallet:updated` is announced after the transaction, and its failure is swallowed** | `WalletService.announce` | A client told its balance rose by a write that then rolled back has been lied to in the one part of the product where that matters. And a notification that did not arrive is a stale screen and a refresh, whereas throwing here would turn a *successful payment* into a failed request |
| **★ `game:rewardSettled` is seat-private** | added to the `projection-boundary` allowlist | It carries somebody's coins and, when they earned nothing, the reason. `game:finished` already told the table who won; how much each seat was paid is between the platform and that player. Fourth entry on a list that is meant to be expensive to extend |
| **`GET /rewards/rules` publishes the integrity factors, and withholds `guestVestCap`** | `application/mappers/rewards.ts` | The integrity table is what makes "you were removed for inactivity, so you earned nothing" a rule the player could have read beforehand rather than a surprise (10 §11). `guestVestCap` is not a rate — it is the bound on what a farming run is worth, and the only thing publishing it changes is how efficiently somebody runs up to it |
| **★ The reconciliation job reports drift and does not repair it** | `ReconciliationService` | The design decision this whole phase turns on. A self-healing job would set the column to the computed value and destroy the only evidence that a write path is broken. "What is the balance" was never the interesting question — the ledger has always answered that. "Which code path wrote a number that disagreed with the row it was supposed to accompany" is, and that is a human's question |
| **★ No scheduler, anywhere** | two services + two scripts | `ReconciliationService.run()` and `GuestForfeitService.run()` are ordinary methods, invoked by `scripts/dev-reconcile.ts` / `dev-forfeit.ts` and by whatever the deployment already schedules. An in-process `setInterval` is simpler today and wrong the moment there are two API instances, since both would sweep the same rows and both would alert. **Mehrang's call** |
| **`dev-reconcile.ts` exits 1 on drift** | so a cron entry can page on it | The alternative is a scheduler parsing stdout, which is how a monitoring rule stops working the first time somebody rewords a log line |
| **`dev-corrupt-balance.ts` uses raw Prisma, and has to** | the only such write in the repository | `IWalletRepository` exposes no balance setter (the Phase B decision), so breaking E1 on purpose means reaching past the whole architecture. That is exactly the right amount of difficulty: **if this script ever becomes writable through a service, something has gone wrong upstairs**, and the comment at the top says so |
| **`allowOverdraft` exists, and has two callers** | `ADMIN_ADJUST` clawback, `GUEST_FORFEIT` | The debit path refuses guests by design — a guest converting farmed coins before signup is the attack the provisional mechanism exists to prevent. Neither of these is that. An operator reversing an erroneous grant must be able to even if the holder already spent some of it (the balance goes negative and is *visible* as such), and expiry is the platform reclaiming a balance rather than the guest spending it. One flag, named after what it permits, at the two call sites entitled to it |
| **`ADMIN_ADJUST` refuses without a written reason** | `ADMIN_ADJUST_REASON_MIN`, a `ValidationError` | 12 §7.2 makes `reason` a column; this makes it a rule. It is the one transaction kind with no causing event to point at, so an adjustment nobody can explain later is indistinguishable from a bug in the credit path. Enforced in the service rather than the console, because a UI is a suggestion |
| **`LEDGER_DRIFT` added to `SECURITY_EVENT_KINDS`, default `ALERT`** | `contracts/enums.ts` | 10 §2.3 asks for an `ALERT` `SecurityEvent` and there was no kind to raise. It is awaited rather than fire-and-forget — unlike every other `record` call, which is deliberately non-blocking so an audit failure cannot fail the audited request. Here there is no request to protect and the alert *is* the product of the job |
| **`/_probe/wallet` deleted, as dated; the seat probes kept indefinitely** | `probe.routes.ts` | S21 dated the wallet probe for S37 and S37 arrived, so it is gone — `GET /wallet` renders the same balances at the real access level. The seat routes were re-dated for S37 too and are now **undated**: the constraint keeping them is not a missing feature a later session supplies, it is that Newman speaks HTTP and the seat protocol is a socket. That will not change, so pushing the date again would have been theatre |
| **The Postman collection grew to 82 requests, and 08/09 were renumbered** | new folder `08 Rewards & the wallet (S35–S38)` | One folder per phase, in order, which meant `08 The boundary` → `09` and `09 Teardown` → `10`. **The budget is now tight**: 82 requests against `RATE_LIMIT_MAX=100/min`, and `auth:create` is at 9 of 10. Two runs inside a minute now 429 in the teardown folder, which reads exactly like a broken collection |
| **★ …and the new folder logs out before joining as a guest** | a correctness step, not housekeeping | Cost a failed Newman run to find. `authenticate` resolves the `access` cookie **first** — correctly, since a player who signs up mid-session *is* a user — so a jar holding both an access cookie and a guest cookie presents as the user. The guest assertions silently ran against a logged-in account: three wallets instead of one, and a 200 where the 403 belongs. Same ordering, same trap, as the one that made `POST /auth/guest/claim` read the guest cookie directly |
| **Eleven Phase I counters added** | incl. `settlements_replayed` | That one is the match-level half of E2 working: a finish that arrived twice and paid once. It should be small and non-zero — a permanent zero probably means the idempotent path stopped being exercised, not that retries stopped happening. `rewards_forfeited` against `matches_settled` is how often the anti-AFK rule actually bites, and `reward_decay_applied` should stay near zero on a platform of friends playing long games |

## Decisions made while building Phase H (2026-09-12)

| Decision | Value | Why |
|---|---|---|
| **★ `ejectAfterStrikes` defaults to 2** | the open question, now closed | 04 §6.3's recommendation, and Mehrang chose it over his own literal rule. A single 30-second lapse — a doorbell, a tunnel — would otherwise eject somebody from a 45-minute Shelem match and forfeit their coins, which is harsh enough to make people avoid the long games. Two strikes still removes a genuinely absent player inside about a minute. **The literal rule is one field away** (`{"ejectAfterStrikes": 1}` on the table) and has its own test |
| **★ `turnEnforcement` gets its own column, not a corner of `optionsJson`** | `Table.turnEnforcementJson String?` | It is platform policy, not game rules: "how long may you think" is the engine's to declare, "how many lapses cost you the seat" is the table's to decide, and it means the same thing in Shelem as in Poker. Putting it in each engine's strict `optionsSchema` would copy four fields six times; putting it *inside* `optionsJson` would change the shape every existing options test and Postman assertion reads. **Null ≠ `{}`**: a table that never expressed a preference follows the defaults *as they move*, one that did keeps what its host chose |
| **★ The two timers both run, and the first to fire wins** | turn deadline + disconnect grace | 04 §5.2 insists they stay distinct and does not say which wins. Grace (15 s on `fixture`) is shorter than the turn limit (30 s), so a dropped player is normally recorded as `EJECTED_ABANDON` — the truthful reason, and 10 §5.1 pays it differently from `EJECTED_TIMEOUT`. `eject()` is idempotent precisely so the loser of that race is a free no-op |
| **★ `TurnObserver` is a port, and `broadcastState` awaits it** | `application/ports/turns.ts` | The dependency genuinely runs both ways — the timer applies a timed-out default action *through* `applyMove` — so a direct reference would be a cycle, and the wrong one: "eject the player" would live inside the file that owns the event log. One line at the end of `broadcastState` covers the deal, a human move, a timeout and a bot move, so there is no second place to remember to re-arm. **Awaiting was a bug fix, not tidiness**: fire-and-forget put the timer's `PHASE` append in flight while the next move opened its transaction, and the two raced for a `seq` — absorbed by the retry loop, but only after a wall of unique-constraint errors |
| **…and the attachment order is load-bearing** | `seats` first, `turnTimers` second | `SeatEnforcementService` clears the acting seat's strike count; `TurnTimerService` reads that count for the countdown it broadcasts. Run concurrently, the ring would sometimes show the strike the player just cleared — a cosmetic bug in the one place a player is most likely to be looking, and an unreproducible one |
| **★ The deadline is written as a `PHASE` event *and* mirrored to Redis** | 04 §6.1, literally | The event is the record and Redis is the convenience, in that order — `REDIS_URL` is unset in development, and a deadline that lived only in Redis would silently stop surviving restarts on exactly the machine where nobody would notice. **It costs one row per turn**: the log is now roughly twice as long as the move count, snapshots land twice as often, and `game-rebuild.test.ts`'s boundaries moved from 25/50/75 to 50/100/150. That is the price of a deadline a deploy cannot reset, and it is paid knowingly |
| **A timer row is skipped by replay *and* by narration** | `isTimerEvent`, in the port | Replay already ignored it (no `move` in the payload, so `isInputEvent` is false). Narration had to be taught: a reconnecting client would otherwise see one "phase changed" line per turn of the whole match in its move log. The live deadline reaches it instead from `announceToSocket`, called by the `game:requestSync` handler — a *stale* deadline would be worse than none, since the client would count down to an instant already passed |
| **★ Ten narrated kinds over six stored ones** | `narrationKindOf` | 03 §4 fixes `GameEvent.kind` at six values; 04 §5.2/§6.2 narrate `TURN_TIMEOUT`, `BOT_TOOK_OVER`, `PLAYER_RETURNED`, `SEAT_ABANDONED`. Both are right and they describe different things: a timeout is *stored* as `TIMEOUT` so `isInputEvent` replays the default action it applied, and *narrated* as `TURN_TIMEOUT` so a client can render "Sara timed out — strike 1 of 2". The mapping is one function, derived from the row, never guessed at by the client |
| **★ Timeouts and bots move through `applyMove`, never around it** | `applySystemMove` | It is what gets them the idempotency key, the `AUDIT` trail, the snapshot policy, the per-viewer broadcast and replay, for free. A quieter second write path for automated moves is how a bot's card ends up missing from a replay eighteen months from now. Keys are server-generated and seq-derived (`timeout:{gameId}:{seq}`, `bot:{gameId}:{seq}`), so two expiries racing one deadline cannot play a seat twice |
| **…and a bot's move records no actor, while a timeout's does** | `anonymous: true` for bots only | The default action **is** the seat's move, applied on their behalf, and the log should read "seat 1 passed, by timeout". A bot's move is not theirs, and attributing it would make the match history claim they played it |
| **A bot-held seat is never given a deadline** | the `isBot || botSubstituted` check in `arm` | Not an optimisation — a correctness rule. A turn timer decides whether a *human* has abandoned the table; pointing one at a bot would strike and "eject" a seat that is already ejected, while the ejected human's strike count climbed with them nowhere near it |
| **"Ejected twice → the seat is final" is counted from the log** | `countEjections`, not a column | The question is about *this match*, and a column would need resetting per game or would follow the player between tables. The log is also the one record that cannot be rewritten — which is the same reason `seatOutcomeOf` reads it to find a `PLAYER_RETURNED` that a cleared member row no longer shows |
| **`seatOutcomeOf` + `integrityFactorOf` shipped now, consumed at S36** | `application/mappers/outcomes.ts` | `GameEngine.result()` reports `COMPLETED` for every seat on purpose (ejection is not the engine's business), so somebody has to overwrite it before settlement. Pure functions taking everything as arguments, so every combination is a unit test with no database. **`REPLACED_RETURNED` deliberately beats the ejection still in the log** — otherwise returning would be worth exactly as much as staying away |
| **A deferred (`HAND_BOUNDARY`) reclaim is held in process** | Poker and Blackjack; `fixture` is `IMMEDIATE` | The *right* to reclaim is durable (`reclaimableUntil` is a column); only the queued intent is lost on a restart, and the player re-sends one event while still inside their window. Persisting the intent would mean a second source of truth about who holds a seat, which is a far worse thing to get wrong |
| **A deadline that expired during downtime fires immediately on boot** | `resume()` schedules it at zero delay | "No free time" cuts both ways. A grace period on boot is a free extra turn for whoever happened to be idling during a restart, and the other three players paid for the outage already |
| **`reconcileActive()` runs before `resume()`** | `main.ts`, after `listen` | A finished game must not have a deadline armed against it. The ordinary path cannot produce a terminal-but-`ACTIVE` row (the finish commits in the move's own transaction) — a restored backup or an older build can, and this turns "that table is stuck forever" into a log line |
| **`Date.now()` and `new Date()` joined `Math.random()` in the domain ban** | ESLint guard 2 | Randomness was banned at S01 and time was not, leaving half of invariant I1 enforced. Phase H is exactly when that gap would be filled by accident — the tempting shortcut is an engine checking how long somebody has been thinking, which would make `(seed, moves[])` stop reproducing a match. `new Date()` is banned for I5 as well: a `Date` in engine state does not round-trip through JSON |
| **The seat-room allowlist grew from one file to three** | `projection-boundary.test.ts` | `game:ejectionWarning` (04 §6.2) and `game:rewardPreview` (04 §6.6) are seat-private by specification. The list is spelled out with a reason per entry rather than pattern-matched, so extending it stays a decision somebody makes in a diff — and a second assertion checks neither new file can emit `game:state` |
| **Helpers left `contracts/`; the schema stayed** | `application/policies/turnEnforcement.ts` | `contracts/` declares and never executes (`contracts-purity.test.ts` bans function declarations outright), so `withTurnEnforcementDefaults` and `reclaimDeadline` moved out. `DEFAULT_TURN_ENFORCEMENT` is a hand-written literal rather than `Schema.parse({})` for the same reason, with a test pinning the two together |
| **`waitFor` added to the test kit** | `tests/helpers/game.ts` | `FakeClock.advance` runs its callbacks synchronously, but an expiry then starts a *detached* chain of real database awaits. Asserting straight after `advance` reads the state from before the strike, and the failure reads as a broken feature rather than an early assertion. Polls on **real** time, deliberately: the fake clock is the game's, and waiting for I/O on it would deadlock |
| **…and every Phase H test file disarms timers in `beforeEach`** | `turnTimers.stop()`, `seats.stop()` | The container is built once per file, so a deadline armed by the previous test is still in the map — and `clock.advance` fires *every* due timer. Without it the warning-privacy assertion sees five warnings for four dead games and reads as a broadcast leak |
| **Eight Phase H counters added** | incl. `turn_warnings_sent` | Against `turn_timeouts` it measures whether the warning works at all: one that almost never converts into a timeout is doing its job. `ejections` (declared since Phase C, finally incremented) against `seats_reclaimed` is 04 §6.4's incentive design measured directly |

## Decisions made while building Phase G (2026-09-12)

| Decision | Value | Why |
|---|---|---|
| **★ Randomness is keyed by the log, not by one generator per game** | `gameRng(rngSeed, seq)` — a fresh `Rng` per input event, seeded `{rngSeed}:{seq}` | A single `Rng` shared across a hand is correct only while every rebuild replays from event 0. A snapshot records the *state* but not the generator's stream position, so rebuilding from `seq 25` and replaying onward would deal different cards than the live game did — a bug invisible until the first game long enough to snapshot. Keying by the event's own `seq` makes a transition reproducible from `(rngSeed, seq)` alone, with or without a snapshot in front of it. `tests/integration/game-rebuild.test.ts` proves the two agree by deleting every snapshot and rebuilding the long way |
| **★ …and deliberately *not* by `clientMoveId`** | the obvious alternative, refused | `clientMoveId` is chosen by the client, and it would have been *easier* — no seq prediction, no concurrency question. It is also a cheat: a player who does not like the card they are about to draw retries the same move under a different id until the deck obliges (07 §4). `seq` is ours. There is a paragraph in `rng.ts` saying so, because this is exactly the shortcut a future session would take |
| **The move's `seq` is predicted before the engine runs, then verified after the append** | mismatch ⇒ roll back with `CONCURRENT_APPEND` | The generator needs the seq; the seq is assigned by `append`. Predicting `lastSeq + 1` inside the transaction is correct on SQLite (one writer) and vanishingly unlikely to race in a turn-based game anywhere. When it does, the state the move was computed from is stale — so the honest answer is to roll the whole transaction back and let the client retry under the same `clientMoveId`, not to commit a move derived from a state that no longer existed |
| **★ `GameInstance.id` is chosen by the caller** | `NewGameInstance.id?`, honoured by both repositories | The commitment is `sha256(rngSeed + id)` and is published *before* the deal, so the id has to exist before the row does. A create-then-update would leave a window in which the committed value on disk was wrong — which is precisely the window the commitment exists to close. The only entity in the schema with this property, and the docblock says why |
| **`SEQ_RETRIES` raised 5 → 12** | `infrastructure/prisma/repositories/games.ts` | The worst case for N simultaneous appenders is N−1 retries for whichever loses every race, and N is bounded by the seat count plus the server's own timeout/phase writes. A budget below the largest table was a limit that would only ever bite under exactly the load it exists for |
| **★ Replay inputs are events carrying a `move`, not events of `kind: 'MOVE'`** | `isInputEvent` | `PHASE`, `DEAL` and the narration are *derived* — replaying them applies a transition twice — and `AUDIT` rows record moves that never happened. Testing the payload rather than the kind is what makes S32's timeout-applied default actions (logged as `TIMEOUT`) replay correctly without a second edit to this function |
| **★ A rejected move's `clientMoveId` goes in the payload, never in the column** | `AUDIT` rows have `clientMoveId: null` | The column is unique per game and is how a retry is recognised. A rejected move holding that slot would make the player's *corrected* retry come back "already applied" — and they would be stuck with no way to play. There is a test that plays a corrected move under the same key |
| **The AUDIT row is written in its own transaction, after the rollback** | `applyMove` catches, then `auditRejection` | The rejection must survive precisely because the move did not. Writing it inside the transaction that is about to roll back would erase it. It also swallows its own failure: an audit problem must not turn a refused move into a 500 |
| **A rejected move still consumes a `seq`** | the press after a rejection is event 2 | 03 §4.2 puts rejections "in the same ordered stream", and that is worth the seq: "what did this player try, and when" reads off one log in one order. It cost a sequence number; it did not cost a turn |
| **The illegal-move throttle promotes severity rather than refusing** | 5 in 30 s per seat → `ALERT` (04 §8) | Exceeding it blocks nothing — the engine already refused the move. What changes is whether the audit row is a line nobody reads or a line that pages somebody. The rate limiter is used as a *counter* here, which is a legitimate second use of it and is commented as such |
| **★ `game:started` and `table:statusChanged` are emitted by the service, not the handler** | a deliberate exception to the Phase F rule | Phase F established that seat announcements come from the handler, because that layer knows which socket to exclude and which system message to write. A game start has no per-socket context and *will* happen with no socket at all (matchmaking auto-start, S43) — and two announcement paths are how one of them ends up silent |
| **★ The projection guard now permits `spectatorRoom` for `game:state`** | `tests/unit/socket/projection-boundary.test.ts` | It forbade it when written, and 04 §3.2 settles it the other way: `game:state` goes to `seat:*` **and** `spectators:*`. That is correct rather than a concession — the spectator projection is built from `SPECTATOR`, which by definition holds no seat's hidden information, so one payload to many spectators leaks nothing while one to `table:{id}` would reach the *players*. The syntactic guard narrowed to `tableRoom`; the semantic guarantee moved to `tests/helpers/leak.ts`, which asserts it per seat, per game — a property a regex could never check |
| **…and the canary was replaced, not deleted** | `★ the only thing that projects state is GameSessionService.broadcastState` | Phase F's canary said "nothing emits game state at all yet" and told the next session to delete it here. What replaces it is stronger: game state has exactly **one** emitter, so "where can a hand go?" stays a one-file question |
| **`application/services/GameSessionService.ts` is the one non-socket file allowed to name a seat room** | the `PROJECTION_PATH` exception in the guard | It *is* the mechanism the room exists for. Adding a second entry to that list should feel expensive; that is the point |
| **`phase` and `toAct` are read structurally off the state** | `readPhase` / `readToAct` in `GameSessionService` | Both are public in every game this platform will hold — whose turn it is and which street you are on are things everyone at the table can see — so surfacing them on the envelope saves every client from digging them out of a per-game `view`. An engine that names neither reports `null`, which is what an untimed solo puzzle should say |
| **`legalMoves` is sent only to the seat that is to act** | `null` for everyone else | Harmless in `fixture` and a hand leak in Poker, where "can you raise?" answers "how much is in front of you?". Being consistent costs nothing and removes a judgement call per game |
| **`describeMove` failures are swallowed** | `describeSafely` | Narration runs *after* the transaction committed, against a state the engine has already moved past. An engine that threw there would turn a played card into a 500 after it was written to the log |
| **`advance()` is bounded at 1 000 steps** | throws `ILLEGAL_MOVE` rather than looping | An engine whose `advance` never settles is a bug, and the difference between failing that request and hanging the process is the difference between a stack trace and an outage |
| **`_fixture` has a real `advance()`, not a stub** | winning sets `pendingWinner`; the next `advance` finishes the game | Same shape a real game uses to resolve a trick or deal the next street. Without it the service's advance loop would be written and never exercised, and M1 would be the first time anyone found out |
| **`_fixture` deals a distinct secret per seat, drawn until unique** | 7-digit numbers | The leak assertions are substring searches. Two seats sharing a secret would make them pass by coincidence, which is the worst possible way for a leak test to pass |
| **The leak harness is generic from day one** | `tests/helpers/leak.ts` | Adding Sudoku, Blackjack, Shelem, Poker and Chess should each cost one call to `runLeakSuite` and no new assertion logic. It also carries the *other* half of the pincer — `assertProjectionsDiffer` — because an engine that hid everything from everybody would pass every leak assertion and be unplayable |
| **`replayFixture` keys its rng exactly as the server does** | shares `gameRng` | A replay kit that diverges from production is worse than none: you end up debugging the replayer. One function, two callers, one grep apart |
| **Snapshot policy tests the *crossing* of a multiple of 25, not landing on one** | `shouldSnapshot(from, to, …)` | A transition appending two events must not be able to step over the boundary and skip the snapshot, which would silently double the replay cost of every rebuild after it |
| **Pruning keeps the two newest snapshots using two `findLatest` calls** | no new repository method | `findLatest(gameId, atOrBeforeSeq)` already answers "the newest at or before X", so walking back twice gives the cutoff. Adding a `listByGame` to the snapshot repository for a weekly job would be a method the contract suite has to carry forever |
| **`seatingNameOf` gives bots and vanished accounts key-shaped placeholders** | `bot.medium`, `player.unknown` | `GameInstance.seating` is *history* — a match summary must still read correctly after the player renamed themselves or left. `null` there would make a finished match unattributable, and English prose would make it untranslatable |
| **The 100-append concurrency test runs ten-wide, not 100-wide** | ten waves of ten | Prisma's SQLite datasource holds **one** connection, so a hundred interactive transactions queue behind it and the later ones blow the 5-second acquisition timeout: the test would fail on pool starvation while saying nothing about ordering. Ten-wide is already far past the real ceiling — a table seats at most ten and moves are turn-based — and the assertion is still `[1..100]` exactly |
| **Six Phase G counters added** | incl. `game_states_projected` | That one is *supposed* to be a multiple of `moves_applied`. A value equal to it would mean one payload per move — which is the broadcast-the-state bug this whole architecture exists to make impossible |

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
| `ejectAfterStrikes`: 2 (spec default) or 1 (Mehrang's literal rule) (`04` §6.3) | **S32** | 2, as a table option — set to 1 for the strict rule | **Resolved 2026-09-12 (Mehrang): 2.** Shipped as the default, with `ejectAfterStrikes: 1` available per table and tested both ways |
| Should coins be purchasable for real money? (`10` §6.5) | M7 | No — coins earn-only, money buys the subscription | Open |
| Shelem: match target, all-pass rule, point-card discards (`games/shelem.md` §0.4) | M4-S01 | Unsourced; a real match will settle them | Open |
| Reward rates, prices, caps, multipliers (`10` §3–4) | S06 seeds them | A starting guess; all live in `RewardRule` rows | **Seeded.** `sudoku` `expectedMinMs` (2 min) is the one number with no source in `10` — invented, worth a look |
| `SUPPORT` role — ever used by a solo operator? (`12` §12) | MA | Ship the role + RBAC matrix, seed only `ADMIN` | Open |
| Admin chat visibility (`12` §12) | MA | Report-scoped and audited | Open |
| Account deletion / anonymization (`12` §12) | Not v1 | Anonymize, never `DELETE` | Open |
| Audit-log retention (`12` §12) | Later | Indefinite; the hash chain makes pruning need a checkpoint | Open |
| Alerting channel for `SecurityEvent` and ledger drift (`12` §12) | MA | None in v1 — console only | Open |

## Notes for next session

### Phase H left these for S35–S38 to build on

- **★ `seatOutcomeOf(member, events)` and `integrityFactorOf(outcome)` are what S36
  wants** (`application/mappers/outcomes.ts`). Both are pure. Call them **inside**
  the settlement transaction and write the result to `MatchParticipant.outcome` —
  do not re-derive the outcome later, because a reclaim clears the member row and
  by then it looks like somebody who never left. `integrityFactorOf` is the
  `integrityFactor` S35's formula multiplies by: 0 for an ejected seat (**even
  when their team wins** — eligibility is per seat), 0.5 for a returned one, 1
  otherwise.
- **`MatchResult` is still never written.** Unchanged from Phase G: `applyMove`
  finishes the instance, reveals the seed and broadcasts `game:finished`. S36 is
  where the settlement transaction hangs off that finish path.
- **`game:rewardPreview` already exists and currently sends zeroes.** It is sent
  to an ejected seat at the moment of ejection (04 §6.6). S35 should fill in a
  real `estimatedCoins`; the payload shape and the seat-private addressing are
  done, and `reasonKey` already distinguishes timeout from abandon.
- **Timers and bots both observe `container.turns`.** To react to a state change,
  attach a `TurnObserver` in `container.ts` rather than calling from
  `GameSessionService` — and remember the list is run **in order**, so anything
  that writes state another observer reads must be attached first.
- **`container.turnTimers.resume()` and `container.games.reconcileActive()` are
  boot tasks**, wired in `main.ts` after `listen`. S38's nightly job (ledger
  reconciliation + `pruneSnapshots`) is a different shape — scheduled, not
  one-shot — but it belongs beside them.
- **The log is now ~2× the move count.** One deadline row per turn. Anything that
  counts events, walks a log, or asserts on a `seq` should filter with
  `isTimerEvent(payload)` from `application/ports/turns.js` — `moveRows()` in
  `tests/integration/event-log.test.ts` is the pattern to copy.
- **`tests/helpers/game.ts` grew `waitFor` and `seatMember`**, and `seatTable`
  takes a `turnEnforcement` override. Any test that advances the fake clock must
  call `container.turnTimers.stop()` and `container.seats.stop()` in `beforeEach`
  or it will fire other tests' deadlines.
- **`scripts/dev-socket.ts` grew `reclaim` and `idle`**, and prints the turn clock
  as a countdown computed from `endsAt − serverTime` — the same arithmetic the
  browser does at S44.

### Phase G left these for S31–S34 to build on

- **★ `container.games` is the only thing that may move a game.** `applyMove` is the pipeline;
  `createInstance` deals; `rebuildState` is how anything reads state. S32's timeout-applied default
  action must go **through `applyMove`**, not around it — that is what gets it the idempotency key,
  the AUDIT trail, the snapshot policy and the per-viewer broadcast for free. Give it a
  server-generated `clientMoveId` (`timeout:{gameId}:{seq}` is the obvious shape) so the retry rule
  still applies, and log it as `kind: 'TIMEOUT'` with a `move` in the payload — `isInputEvent`
  already replays it correctly because it tests for the payload, not the kind.
- **`meta.defaultActionOnTimeout(state, seat)` is implemented on `fixture` and returns `{ kind:
  'pass' }`** — and `null` when it is not that seat's turn. S32 applies it on a non-final strike;
  the ladder, the warning and the ejection are S32/S33's, the safest-move decision is already made.
- **`meta.turnTimeoutMs` is 30 s on `fixture` and `disconnectGraceMs` is 15 s.** Both are
  deliberately short so S31–S33 can wait on real deadlines. `turnTimeoutByPhaseMs` exists on the
  interface and no game uses it yet.
- **Timers come from `application/ports/clock.ts`, still.** `GameSessionService` already takes the
  same `Clock`; `TurnTimerService` should share it. Do not reach for `setTimeout`, and do not reach
  for Vitest's fake timers — they replace the global for Prisma, ioredis and Socket.IO too, and the
  failures read as race conditions.
- **`game:turnTimer`, `game:ejectionWarning`, `game:playerEjected`, `game:playerReturned` and
  `game:reclaimSeat` are declared in 04 §3 and do not exist yet.** Adding an event is still four
  edits in this order: the payload schema and the two typed maps in `contracts/events.ts`,
  `npm run contracts:sync`, a handler in `interface/socket/handlers/game.handlers.ts`, and a test.
- **The deadline has to survive a restart (04 §5.4).** The mechanism is already half-built: a
  `PHASE` game event is durable and `rebuildState` replays it. Store the absolute `endsAt` as an
  event (and, when Redis is configured, mirror it at `game:{id}:timer`) — never as a duration, and
  never *only* in Redis, which may not exist.
- **`GameEngine.result()` reports `outcome: 'COMPLETED'` for every seat**, on purpose. Ejection is
  not the engine's business — S33 overwrites the per-seat outcome from `TableMember.ejectionReason`
  before settlement, which is why `MatchParticipant.outcome` is a column rather than something
  derived from the standings.
- **`MatchResult` is still never written.** `applyMove` finishes the instance, reveals the seed and
  broadcasts `game:finished` from `engine.result(state)` — but nothing persists a `MatchResult` or a
  `MatchParticipant` row yet. That is **S36**, and it is where the reward settlement transaction
  hangs. The finish path is the seam it plugs into.
- **`pruneSnapshots(gameId)` exists and nothing schedules it.** S38's nightly job is where it
  belongs, beside the ledger reconciliation.
- **`tests/helpers/game.ts` is the setup every Phase G+ test wants** — `seatTable`, `dealGame`,
  `pressTurns`. `tests/helpers/leak.ts` and `tests/helpers/replay.ts` are the two kits M1 reuses
  unchanged; growing a real engine's suite should start by copying
  `tests/unit/games/fixture-engine.test.ts`, whose five `describe` headings are the five invariants.
- **`scripts/dev-verify-commit.ts` is new** (`--game` / `--table` / `--latest`) and `dev-socket.ts`
  grew `start`, `press`, `pass`, `move <json>`, `sync [lastSeq]` and `seq`. It verifies the deal
  itself on `game:finished`, which is the same four lines the browser will run at S44.

### Phase F left these for S28–S30 to build on

- **★ Broadcast through `container.realtime`, never through `io` directly.** The four room builders
  in `application/ports/realtime.ts` are the only way to name a room, and a test enforces it. S30's
  `broadcastState` loops over seated members and publishes to `seatRoom(tableId, seat)` **once per
  viewer** — there is deliberately no `publishToTable('game:state', …)` to reach for, and
  `tests/unit/socket/projection-boundary.test.ts` will fail the build if one appears.
  **Done at S30** — the canary was replaced by `★ the only thing that projects state is
  GameSessionService.broadcastState`, which pins the emitter list to exactly one file. Converting
  the scan to the ESLint rule 04 §4.1 names is still open and is still free.
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
the **Template — local** environment, and run the collection top to bottom: **82 requests, 120
assertions**, folders `00 Health` → `10 Teardown`. It is a smoke test of the REST surface, not a
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

- **★ `auth:create` is at 9 of 10 after Phase I, and the global limiter is at 82 of 100.**
  `/auth/register`, `/auth/guest` and `/auth/guest/claim` share one bucket of **10 per minute per
  IP**, because each mints an account and burns an argon2 hash and an attacker must not get ten of
  each. One full run now spends nine (register, two guest joins in folder 06, one join and four
  claims in folder 07, and folder 08's guest join). **Both budgets now bite on a too-soon rerun**:
  `auth:create` in folder 07, and the global 100/min limiter in the *teardown* folder — which reads
  exactly like a broken collection and is not. **A full minute between runs is mandatory.** If you
  add a request that registers, joins as a guest, or claims, take one out; the next addition of any
  kind should come with a matching removal, or with `RATE_LIMIT_MAX` raised in `backend/.env` for
  the duration of the API testing.
- **★ A logged-in user masks a guest, and Phase I paid to re-learn it.** `authenticate` resolves
  the access cookie *before* the guest cookie — correctly, since a player who signs up mid-session
  **is** a user — so with both in Postman's jar you are always the user. Folders `06` and `07` clear
  the jar in a pre-request script and log back in at the end; folder `08` does it with an explicit
  `POST /auth/logout` before its guest join, which is a *correctness* step and is documented as one
  in the request's own description. The first run of folder 08 without it asserted guest rules
  against a logged-in account and failed on exactly what you would expect: three wallets instead of
  one, and a 200 where the 403 belongs. **Any new guest-facing request must drop the access cookie
  first**, or it silently asserts the host's behaviour and passes for the wrong reason.
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
  therefore the headline check of journey J2. **Undated at S37**: the constraint keeping them is not
  a missing feature a later session supplies, it is that Newman speaks HTTP and the seat protocol is
  a socket. If you ever do delete them, delete folder 07's seat setup in the same commit and say out
  loud what coverage went with it.
- **Phase F added no REST routes**, so the collection is unchanged — and was re-run against Phase F
  to prove nothing broke: **71 requests, 99 assertions, 0 failures**. The socket surface is verified
  by `backend/requests/socket.md` and by 60 socket tests instead.
- **Phase G added no REST routes either**, for the same reason: a move is socket traffic by the
  transport rule, and `02` §5 lists no REST game routes. Re-run against Phase G, again **71
  requests, 99 assertions, 0 failures**.
- **Phase H added no routes but did change the table contract.** `turnEnforcement` is now accepted
  by `POST /tables` and `PATCH /tables/:id` and returned, resolved, by every table response — so
  folder 03 grew two requests (the strict rule as a table option, and an out-of-range refusal) and
  three assertions elsewhere. **73 requests, 104 assertions, 0 failures** as of 2026-09-12. Note
  this spends no extra `auth:create` budget: both new requests are table creations by the host who
  is already logged in.
- **★ Phase I added a folder and renumbered two.** `08 Rewards & the wallet (S35–S38)` covers
  `GET /wallet`, `GET /wallet/transactions` and the public `GET /rewards/rules`, at all three access
  levels — so `08 The boundary` became `09` and `09 Teardown` became `10`, keeping one folder per
  phase in order. Folder 07's two `/_probe/wallet` calls now hit the real `GET /wallet`, because
  that route is deleted. **82 requests, 120 assertions, 0 failures** as of 2026-09-13. The economy's
  *writes* are not here and cannot be: a match finishes over a socket, so settlement, forfeiture and
  the ledger are covered by `tests/integration/reward-settlement.test.ts` and by the two dev scripts
  in the Phase I verify section above.
- The next session that *will* touch the collection again is **S37** (`GET /wallet`,
  `/wallet/transactions`) — and it should delete `GET /_probe/wallet` and the
  `/_probe/tables/:id/seats*` routes in the same commit, saying out loud what coverage goes with
  them (see folder 07's note above).
