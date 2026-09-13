# Verifying the socket by hand — Phase F (S23–S27)

The `.http` files in this folder cover REST. Sockets need a client, and that
client is **`scripts/dev-socket.ts`** — the tool every "You verify" step from
S23 to S42 leans on. This file is its manual.

```bash
cd backend && npm run dev            # tsx watch, :3000 (or PORT=3999 — see below)
npx tsx scripts/dev-socket.ts --help
```

> **Port 3000 is occupied on this machine** by another Express process. Every
> command below uses `--url http://localhost:3999`; drop it if your port 3000 is
> free. Start the API with `PORT=3999 npm run dev` to match.

---

## 0. The cookie jars

`dev-socket` reads a **curl cookie jar** — the same `-c /tmp/c.txt` file every
other verification step in `11-build-plan.md` already produces. Set up a host, a
table, an invite and a guest first:

```bash
API=localhost:3999/api/v1

curl -sc /tmp/c.txt -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"correct-horse-battery","displayName":"Mehrang"}' >/dev/null

TID=$(curl -sb /tmp/c.txt -X POST $API/tables -H 'content-type: application/json' \
  -d '{"gameSlug":"fixture","seatCount":4,"options":{}}' | jq -r .id)

CODE=$(curl -sb /tmp/c.txt -X POST $API/tables/$TID/invites \
  -H 'content-type: application/json' -d '{}' | jq -r .code)

curl -sc /tmp/g.txt -X POST $API/auth/guest -H 'content-type: application/json' \
  -d "{\"inviteCode\":\"$CODE\",\"displayName\":\"Sara\"}" | jq
```

**Two traps this cost real time on**, both now handled and both worth knowing:

- The jar marks httpOnly cookies with a **`#HttpOnly_`** prefix on the _domain_
  field. A parser that skips `#` comment lines reads an empty jar and every
  connection comes back `UNAUTHORIZED` from a file that is perfectly good.
- **`withCredentials: true` must not be set in Node.** It is the browser's way
  of saying "attach your own cookie jar"; in Node there is no jar, and setting
  it stops `engine.io-client` applying `extraHeaders` on the websocket
  transport — so, again, `UNAUTHORIZED` from a good jar. See the comment on the
  `io(...)` call in `dev-socket.ts`.

---

## S23 — the three identity outcomes

```bash
npx tsx scripts/dev-socket.ts --url http://localhost:3999
#   → ✗ connect_error UNAUTHORIZED { code: 'UNAUTHORIZED', … }, then it exits.
#     No cookies means no identity, and there is nothing to subscribe to
#     without one (04 §1.1).

npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt
#   → ← connected { serverTime, protocolVersion: 1, clientProtocolVersion: 1 }

npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt
#   → the same, and `join $TID` below will show `you` bound to that one table
```

**The protocol-version warning**, which is otherwise hard to see happen:

```bash
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --protocol 99
#   → ← connected …, immediately followed by
#     ← error { code: 'VALIDATION_FAILED', i18nKey: 'errors.protocolVersionMismatch',
#                details: { server: 1, client: 99 } }
#   Reported, not refused: a connect error is a dead screen, and an out-of-date
#   page needs a live socket to be told to refresh.
```

**★ The assertion that eliminates the seat-impersonation class.** Type this in
any connected client:

```
raw table:takeSeat {"tableId":"<TID>","seat":3,"userId":"somebody-else"}
```

```
→ ✗ table:takeSeat VALIDATION_FAILED errors.validationFailed
    { userId: ['errors.field.unknownKey'] }
```

_Rejected_, not ignored. Every inbound schema in `contracts/events.ts` is
`.strict()` and none of them has a `userId`, `playerId`, `guestSessionId` or
`memberId` field — so there is nothing to claim to be somebody else _with_.

---

## S24 — two terminals, one table

This is the session's whole point, and it takes two windows.

```bash
# ── terminal 1 ────────────────────────────────────────────────────────────
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID

# ── terminal 2 ────────────────────────────────────────────────────────────
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt --join $TID
```

In **terminal 1**, type `takeSeat 1`. Terminal 2 must print:

```
← table:seatChanged { tableId, seat: 1, occupant: { kind: 'user', displayName: 'Mehrang' } }
← chat:message      { kind: 'SYSTEM', body: 'table.system.seatTaken', params: { name: 'Mehrang', seat: 1 } }
```

Then in **terminal 2**, type `takeSeat 1` → `✗ SEAT_TAKEN` with
`{ reason: 'SEAT_OCCUPIED' }`. Then `takeSeat 2` → terminal 1 sees it.

**★ Look hardest at the SYSTEM message.** `body` is `table.system.seatTaken`
and the name is in `params`. If you ever see `"Mehrang took seat 1"` there, one
row has just become untranslatable, and the transcript a Persian reader loads
next month is in English. There is a test asserting every `SYSTEM` body matches
a dotted-key pattern — which forbids whitespace, so no sentence can pass it.

**The guest binding**, from terminal 2:

```
join <some-other-table-id>
→ ✗ table:join FORBIDDEN { reason: 'GUEST_TABLE_BINDING' }
```

…and an `ALERT`-severity `SEAT_IMPERSONATION` row appears in `npm run db:studio`.
A guest reaching for another table is not a mistake to tolerate; it is the shape
of a privilege-escalation attempt.

**Host-only events**, from terminal 2 (the guest):

```
bot 3 easy        → ✗ FORBIDDEN { reason: 'HOST_REQUIRED' }
kick 1            → ✗ FORBIDDEN { reason: 'HOST_REQUIRED' }
options {"target":3}  → ✗ FORBIDDEN { reason: 'HOST_REQUIRED' }
```

The same three from terminal 1 (the host) all succeed, and terminal 2 watches
each one land.

---

## S25 — presence, and the countdown

With both terminals joined **and seated**:

```bash
# Ctrl-C terminal 2.
```

Terminal 1 prints, within a moment:

```
← table:presence { seat: 2, state: 'disconnected', graceEndsAt: '2026-…T…Z' }
```

`graceEndsAt` is **absolute**, not a duration (04 §5.4): the client renders the
countdown from this minus the clock offset it measured at handshake, so a device
with a wrong system clock still sees the true deadline — and that deadline can
cost somebody their seat. The `fixture` game's window is 15 s; Shelem's is 90 s.

Restart terminal 2 inside the window and rejoin → terminal 1 prints
`state: 'online'`, and terminal 2 receives a **full `table:snapshot`**, not a
delta. `full` is always correct and is the fallback whenever anything is
ambiguous; never guess at reconciliation.

**★ Multi-tab.** Open a _third_ client with the **same cookies as terminal 1**,
join, then close only one of the two:

```bash
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID
```

Terminal 2 must print **nothing**. Presence is tracked per identity holding a
set of sockets, so closing one of two tabs is a non-event — the person is still
there. Getting this wrong produces the most annoying possible bug: a permanent
"reconnecting…" badge on somebody who is sitting there playing.

In `npm run db:studio`, `TableMember.disconnectedAt` is set while away and null
again after the reconnect. That one column is the only persisted piece of
presence, and it is what lets an API restart re-arm the timer from where it
actually stood instead of gifting a fresh 90 seconds.

---

## S26 — chat both ways

```
# terminal 1
chat hello everyone
# terminal 2
chat hi from Sara
```

Each appears in the other, with `author.displayName` and no account id anywhere
in the payload. Then:

```
spam 20     → the first few succeed, then ✗ RATE_LIMITED with a retryAfterMs
emote clap  → ✓ still works — emotes are an independent bucket (04 §8)
```

A throttled message leaves **no row**: a transcript containing messages nobody
ever saw is worse than one that lost a line. Check in `db:studio` that
`ChatMessage` holds only the ones that were acked.

```
chat that was shit, well played
→ 'that was ███, well played'
chat greetings from Scunthorpe
→ unchanged — the mask matches whole tokens, not substrings
```

Now open a **third** client and `join $TID`. Its `table:snapshot` carries the
prior conversation, oldest first.

---

## S27 — with and without Redis

The app runs **without** Redis, and that is the ordinary single-process
configuration, not a degraded one:

```bash
curl -si localhost:3999/ready | head -1        # → 200
curl -s  localhost:3999/api/v1/ready           # → checks: { database }, no redis key
```

With it:

```bash
docker compose up -d redis                     # from the repository root
REDIS_URL=redis://localhost:6379 PORT=3999 npm run dev

curl -s localhost:3999/api/v1/ready            # → checks: { database, redis }
redis-cli KEYS 'bg:ratelimit:*'                # → counters appear as you make requests
redis-cli KEYS 'bg:presence:*'                 # → one hash per table with someone in it

# ★ THE ONE TO LOOK HARDEST AT
redis-cli KEYS '*wallet*'                      # → MUST be empty
redis-cli KEYS '*ledger*'                      # → MUST be empty
redis-cli KEYS '*cooldown*'                    # → MUST be empty
```

Money never lives in Redis (02 §3.2), because Redis is not durable and a lost
ledger row is lost money. `tests/unit/redis-keys.test.ts` enforces this two
ways — no key builder can produce a forbidden name, and nothing outside
`infrastructure/redis/` builds a Redis key at all — so the `redis-cli` above is
a confirmation rather than the control.

Then pull it out from under a running server:

```bash
docker compose stop redis
curl -si localhost:3999/ready | head -1        # → 503, honestly reported
#   …but the socket keeps working, chat keeps working, and the rate limiter
#   falls back in-process. Losing Redis degrades; it does not crash.
docker compose start redis
curl -si localhost:3999/ready | head -1        # → 200 again
```

---

# Phase G (S28–S30) — the game itself

Everything above establishes who is at the table. This is where cards appear —
and where the two terminals stop agreeing, on purpose.

The setup is the same as §0, with **one change**: `fixture` is playable by 2, 3
or 4, and `game:start` validates the _occupied_ seats, so create a 2-seat table
and fill both.

```bash
API=localhost:3999/api/v1

curl -sc /tmp/c.txt -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"correct-horse-battery","displayName":"Mehrang"}' >/dev/null

TID=$(curl -sb /tmp/c.txt -X POST $API/tables -H 'content-type: application/json' \
  -d '{"gameSlug":"fixture","seatCount":2,"options":{"target":3}}' | jq -r .id)

CODE=$(curl -sb /tmp/c.txt -X POST $API/tables/$TID/invites \
  -H 'content-type: application/json' -d '{}' | jq -r .code)

curl -sc /tmp/g.txt -X POST $API/auth/guest -H 'content-type: application/json' \
  -d "{\"inviteCode\":\"$CODE\",\"displayName\":\"Sara\"}" | jq -r .identity.displayName
```

---

## S30 — ★ the two terminals that must disagree

```bash
# ── terminal 1 — the host, seat 0 ─────────────────────────────────────────
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt \
  --join $TID --seat 0

# ── terminal 2 — the guest, seat 1 ────────────────────────────────────────
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt \
  --join $TID --seat 1
```

**Terminal 1:** `start`

Both terminals print, in this order:

```
← game:started { gameId, gameSlug: 'fixture', seedCommit: '<64 hex>', seating: […] }
  store this commit now: …    verify it against the seed in game:finished
← game:state { seq: 0, phase: 'PLAYING', view: { …, secret: … }, toAct: 0, legalMoves: … }
```

### ★★ THE ONE THING TO LOOK HARDEST AT

Put the two `game:state` payloads side by side.

|                 | terminal 1 (seat 0) | terminal 2 (seat 1)            |
| --------------- | ------------------- | ------------------------------ |
| `view.secret`   | a 7-digit number    | **a different** 7-digit number |
| `legalMoves`    | `[{press},{pass}]`  | **`null`**                     |
| everything else | identical           | identical                      |

Neither terminal's payload contains the other's number **anywhere** — not
nested, not in a key, not in a debug field. That difference is produced by one
server-side state passing through `projectState` twice, once per viewer, and it
is the entire anti-cheat architecture made visible. If the two `secret` values
are ever equal, or either payload contains both, stop and read
`GameSessionService.broadcastState`.

`legalMoves` being `null` for seat 1 is the same idea in miniature: it is a
convenience for whoever is to act, and harmless here only because this game has
nothing to hide in it. In Poker, "can you raise?" answers "how much is in front
of you?".

### Then play

```
# terminal 1
press            # → ✓ { seq: 1, replayed: false }
                 #   both terminals: ← game:event { seq:1, descriptor:{ key:'games.fixture.move.press' } }
                 #   both terminals: ← game:state  { seq:1, toAct: 1 }

press            # → ✗ NOT_YOUR_TURN   (and ← game:moveRejected on this socket only)
move {"kind":"detonate"}
                 # → ✗ ILLEGAL_MOVE

# terminal 2
press            # → ✓ { seq: 3 }  ← note the 3: the rejected move above is an
                 #   AUDIT row in the same ordered stream, so it cost a seq.
                 #   It did not cost a turn.
```

**The descriptor is the thing to check in `game:event`.** It must be
`{ key: 'games.fixture.move.press', params: { seat: 0 } }` — an i18n key and
parameters. If you ever see `"Mehrang pressed the button"` there, the move log
has become untranslatable and a Persian reader gets English forever.

### The impersonation attempts, both shapes

```
raw game:move {"gameId":"<GID>","move":{"kind":"press"},"clientMoveId":"x","seat":0}
→ ✗ VALIDATION_FAILED { seat: ['errors.field.unknownKey'] }
```

_Rejected_, not ignored: there is no `seat` field on `game:move` and every
schema is `.strict()`, so there is nothing to claim to be somebody else _with_.

```
# from terminal 2, when it is NOT its turn:
move {"kind":"press","seat":0}
→ ✗ NOT_YOUR_TURN
```

The seat inside the `move` body is accepted as _data_ — `move` is opaque to the
transport, because its grammar belongs to the engine — and then simply not read.
The acting seat came from the socket. Both defences are real; the first is
structural and the second is architectural.

### Finish it, and verify the deal

Press until somebody reaches `target` (3 by default here).

```
← game:finished { reason: 'NORMAL', standings: [...], seedRevealed: '<64 hex>', seedCommit: '<64 hex>' }
  ✓ deal verified — sha256(seed + gameId) matches the commit from game:started
```

`dev-socket` runs that check itself, which is exactly what the browser will do
on the match summary (04 §7). And the operator's copy:

```bash
npx tsx scripts/dev-verify-commit.ts --latest
#   or --game <gameId>, or --table $TID
```

---

## S29 — the restart, and the resync

**This is the one to actually watch.** Start a game, play a few moves, then:

```bash
# terminal 1, mid-game:
press
press
seq              # → game=<gameId>  lastSeq=2

# ── now kill the server. Ctrl-C the `npm run dev` terminal. ────────────────
# Both sockets print  ○ disconnected  and start reconnecting.

PORT=3999 npm run dev        # restart it
```

The clients reconnect on their own. Then, in terminal 1:

```
join <TID>       # the sockets are new, so re-join the rooms
sync 0           # → ✓ { mode: 'delta', fromSeq: 1, toSeq: 2 }
                 #   ← game:event ×2, then ← game:state — the state you had
sync             # ★ no argument → ✓ { mode: 'full', fromSeq: null, toSeq: 2 }
                 #   ← game:started (the commit again), then ← game:state
press            # and the game carries on from exactly where it was
```

**Nothing was lost, and nothing was in memory to lose.** State is rebuilt from
`snapshot + events` on every single move, which is why a deploy mid-hand costs
players a reconnect rather than a game. Look at the `counts` in that
`game:state` after the restart: they are the presses from before it.

`sync` with no argument is deliberately _not_ `sync 0`. No `lastSeq` at all
means "I cannot be reconciled" and gets a **full** — the mode that is always
correct. `sync 0` means "I am at the beginning", which is a delta of everything
and only cheaper while the game is short.

```
sync
sync
sync
sync             # → ✗ RATE_LIMITED { bucket: 'requestSync' }, retryAfterMs
```

3 per 10 s (04 §8). A client needing a fourth sync in ten seconds has a bug, and
serving it faster would hide the bug under load.

---

## S28 — the log, in Prisma Studio

```bash
npm run db:studio
```

| Table           | What to look for                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GameInstance`  | `seedCommit` 64 hex; `rngSeed` 64 hex; `seedRevealedAt` **null while ACTIVE**, set on FINISHED; `seq` equal to the newest event's; `seatingJson` naming who sat where                                     |
| `GameEvent`     | **contiguous `seq`, no gaps**; one `MOVE` per press; an `AUDIT` row for each rejected move, carrying `code` and the attempted move in its payload; `clientMoveId` set on moves and **null on AUDIT rows** |
| `GameSnapshot`  | a row every 25 events, and always one at `FINISHED`. Delete them all and replay still works — they are a cache, the log is the truth                                                                      |
| `SecurityEvent` | `ILLEGAL_MOVE` / `NOT_YOUR_TURN` at `INFO`, escalating to `ALERT` on the sixth in thirty seconds                                                                                                          |

**The AUDIT row's `clientMoveId` column being null is worth a second look.** The
key lives in the _payload_ instead, because `(gameId, clientMoveId)` is the
unique constraint that recognises a retry — a rejected move holding that slot
would make the player's corrected retry come back "already applied", and they
would be stuck with no way to play.

---

## Phase H — the turn clock, the strikes, and the bot (S31–S34)

Everything below is **real time**. `fixture` declares a 30-second turn limit and
a 10-second warning, so the whole escalation takes about a minute per seat and
is meant to be watched rather than raced.

Set up as for Phase G — a host, a 2-seat `fixture` table, an invite, a guest —
then open two terminals:

```bash
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID --seat 0
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt --join $TID --seat 1
```

### S31 — the deadline is absolute, and it is written down

`start` in terminal 1. **Both** terminals print `game:turnTimer`, byte-identical:

```
← game:turnTimer { "seat": 0, "endsAt": "2026-09-12T18:04:31.000Z",
                   "strikes": 0, "ejectAfterStrikes": 2, "serverTime": … }
  seat 0 has 30s (strike 0 of 2)
```

That it reaches **both** is the point: the deadline is public, and the other
player watching your clock run down is most of what makes a turn limit feel
fair. The countdown line is computed from `endsAt − serverTime`, never from this
machine's clock — which is why a laptop whose time is ten minutes out still
renders the right number.

`press` in terminal 1 → the timer cancels and re-arms for seat 1, a fresh 30 s.

Then confirm the two places it is stored:

```bash
redis-cli GET "bg:timer:<gameId>"     # → the same ISO instant (skip if REDIS_URL is unset)
npm run db:studio                     # GameEvent: a PHASE row whose payload is
                                      # { "turnTimer": { seat, endsAt, strikes } }
```

**The `PHASE` row is the record and Redis is the mirror**, in that order — which
is why S34 works on a laptop with no Redis at all. Note the row carries no
`move`, so `isInputEvent` skips it and a replay applies nothing.

> ★ The log is now roughly **twice as long as the move count**: one move row and
> one deadline row per turn. That is the cost of a deadline that survives a
> deploy, and it is why the snapshot boundaries in `game-rebuild.test.ts` moved
> from 25/50/75 to 50/100/150.

### S32 — the warning is private, and the strike is not

In terminal 1, `idle` — that is, do nothing at all — and watch:

```
t-10s  ← game:ejectionWarning { "secondsRemaining": 10, "consequence": "EJECTION_NO_REWARD" }
         ⚠ play within 10s or you are out, with no reward
t-0    ← game:event { "kind": "TURN_TIMEOUT", "seat": 0, "strikes": 1 }
       ← game:state  … and the turn has moved to seat 1
```

**★★ The one thing to look hardest at:** terminal 2 saw the `TURN_TIMEOUT` and
**not** the warning. A warning broadcast to the table would shame somebody in
front of the other players *and* tell them exactly when to expect a free trick.
If it ever appears in terminal 2, 04 §6.2's private channel has been broken.

In Studio, the `TIMEOUT` row carries `move: { kind: "pass" }` — never `press`.
04 §6.5: a default action may cost you the turn and must never spend a resource
you did not authorise, and a press is the only move in this game that can win it.

### S33 — two strikes, a bot, and the table plays on

Let seat 0 lapse a second time (press once from terminal 2 in between, so the
clock comes back round):

```
← game:playerEjected { "seat": 0, "reason": "TURN_TIMEOUT",
                       "replacedByBot": true, "reclaimableUntil": "…" }
← game:rewardPreview { "estimatedCoins": 0, "integrityFactor": 0,
                       "reasonKey": "games.reward.forfeitedTimeout" }
  this match will pay you nothing, and why
```

`game:rewardPreview` prints in terminal **1 only** — the forfeit is yours, not
the table's business. Then keep pressing in terminal 2 and watch the bot answer
for seat 0 until somebody wins. **That is the M0 exit criterion, demonstrated.**

Also try the disconnect path, which is the *other* timer: Ctrl-C terminal 2 and
wait out the 15-second grace. The ejection reason is `ABANDON`, not
`TURN_TIMEOUT`, and 10 §5.1 pays the two differently — if you ever see one
reported as the other, they have been conflated.

### S34 — coming back, and a restart that gifts nobody time

Within the 120-second window, in the ejected terminal:

```
reclaim          → game:playerReturned { outcome: "REPLACED_RETURNED", rewardFactor: 0.5 }
```

Half reward, which is the whole incentive design: coming back beats staying
away, and never leaving beats both. Get ejected again and wait past the window:

```
reclaim          → ✗ SEAT_NOT_RECLAIMABLE { reason: "WINDOW_EXPIRED" }
```

**★★ Then the restart test, which is the headline of S34.** Note the `endsAt`
from a live `game:turnTimer`, kill the server, wait ten seconds, and start it
again:

```bash
PORT=3999 npm run dev
# the boot log prints:  turn deadlines resumed  { settled: 0, rearmed: 1 }
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID
sync
```

The re-armed deadline is the **same absolute instant** as before the restart —
not a fresh 30 seconds. A player who was five seconds from timing out is still
five seconds from timing out, and a deploy is not a way to buy thinking time. A
deadline that passed *during* the downtime fires immediately, for the same
reason: the other players already paid for the outage.
