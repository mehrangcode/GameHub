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
