Phase D (S17–S20) of M0 is built and green.

**708 backend tests · typecheck · lint · prettier · contracts:check — all green.** Up from 561. The
catalog the welcome page will render, the table lifecycle, the invite link the whole product hangs
on, and the seat race — decided at the database, not in a service.

## What shipped

**S17 — the game registry.** `domain/games/GameEngine.ts` is the full interface from `05` §1, types
only, so everything after this is built against the real shape rather than an ad-hoc one that has to
be reconciled at M1. `registry.ts` holds `GameMeta` for the five v1 games — all `comingSoon` — plus
the dev-only `fixture`. `GET /api/v1/games` and `/games/:slug` are public, in-memory, and carry
i18n keys only. A Zod meta-schema validates every entry *at registry construction*, and
`mappers/jsonSchema.ts` publishes each game's `optionsSchema` as JSON Schema for the S39 form.

**S18 — table CRUD.** `POST /tables` (options parsed by the engine's own schema, `seatCount` checked
against `playableCounts`), `GET /tables/mine`, `GET /tables/:id` with the full seat map,
host-and-`WAITING`-only `PATCH`, and a `DELETE` that closes rather than deletes. The **H** access
level arrived as `requireHost`, and S16's `_probe/table/:tableId` stand-in is gone — the guest
binding now lives on the real route.

**S19 — invites.** Host-only mint and revoke, and **`GET /invites/:code` with no authentication at
all**. Codes are 8 characters over a 30-symbol alphabet with `I L O U 0 1` removed. Abuse controls
per `07` §5.2: a per-IP budget of its own, an `INVITE_ABUSE` event per bad code, and one
byte-identical 410 for every way a link can be dead.

**S20 — seats.** `claimSeat`, `releaseSeat`, spectators, bots, teams and the capacity check — with a
`Promise.all` test proving that two claims on one seat produce exactly one occupant. Exposed over
HTTP through three `/_probe` routes that are marked for deletion in S24, because the service is the
deliverable and seat changes are socket traffic.

## Five things worth your attention

**1. The seat claim contains no `SELECT`, and that absence is the correctness argument.** Two friends
clicking seat 2 in the same millisecond is a real event. There is no "is the seat free?" read: the
insert goes in and the `(tableId, seat)` unique constraint picks the winner (`03` §6.3). Which of the
three constraints fired is worked out *after* the failure, so `SEAT_OCCUPIED` and `ALREADY_SEATED`
can be different answers without reintroducing the race. `seat-claim.test.ts` runs two racers and
then four; both leave one occupant.

**2. `GET /tables/:id` is tested for what it does *not* contain.** The transport split (`02` §3.1)
erodes one convenient field at a time — a `deckCount` here, a `turn` there — and each addition looks
harmless. So the test asserts the response has no `state`, `deck`, `hand`, `cards`, `board`, `turn`,
`legalMoves`, `seed` or `snapshot` key, and that its key set is exactly `TableDetailSchema`'s. The
leak-test suite in M1 guards the socket; this guards the door beside it.

**3. Revoked, expired, exhausted, dangling and unknown are one answer.** All five exits from
`InviteService.resolve` produce the same `410 INVITE_EXPIRED` with an identical body — there is
literally one `refuse()` in the file. Any difference between them (a distinct code, an extra
`details` field, even a different message) turns the one public endpoint that takes a secret into an
oracle for enumerating live codes. The reason is recorded in the audit row instead, where it is
useful and invisible to whoever supplied the code. A test builds all five causes and asserts there
is exactly one distinct response body.

**4. The invite resolve route is a separate router, so nobody can accidentally protect it.** The
friend opening your link is in a private window with an empty cookie jar; if that endpoint ever asks
who they are, journey J1→J2 dies and a thirty-second join becomes a signup funnel. Keeping it out of
`tables.routes.ts` means a `requireIdentity()` added to the tables router cannot reach it, and every
test that resolves a code uses a bare `request(app)` rather than an agent.

**5. Creating a table does not seat the host.** It would be convenient and it is wrong: sitting down
has its own authorization, its own race, and — from S24 — its own socket event that everyone at the
table watches happen. A host auto-seated at seat 0 could then never move to seat 2, because one
identity holds one seat per table.

## Structural decisions

- **The meta-schema checks what TypeScript cannot.** `playableCounts ⊆ [minPlayers..maxPlayers]`,
  every localisable string a dotted i18n key rather than English, a matchmaking preset whose options
  its own game would reject, `defaultOptions` that satisfy `optionsSchema`. It runs in
  `buildGameRegistry`, so a malformed entry is a boot failure naming the slug and the field — not an
  empty preview card nobody notices for a week.
- **The Zod → JSON Schema converter is ours, ~160 lines, and it throws.** Five games × ~15 options is
  a lot of form to hand-write twice, and hand-writing it twice is how the form and the validator
  drift. It covers exactly the node types the catalog uses and refuses anything else rather than
  truncating; a test converts every registry entry, so an inexpressible option shape fails the build
  instead of shipping a form with a missing field.
- **`fixture` is registered only outside production, and never listed anywhere.** S18–S20 need a slug
  that is actually playable, and the welcome page has no business advertising a test rig. In
  production its 404 is identical — but for the slug you yourself typed — to a game that never
  existed.
- **Stored options are the parsed output.** Defaults filled in, unknown keys refused. A table
  therefore records the options the game will actually be played with, which is what keeps it
  replayable a year later after a default moves.
- **`requireHost` stashes the row on `req.table`.** It is the only access level that needs a database
  read, so the handler reuses it — one read per request, and no window in which the row the guard
  approved differs from the row the handler edits. A matchmade table has `hostUserId: null` and
  therefore no host, so every H-level route on it refuses; nobody owns a table the matchmaker
  assembled (`09` §2).
- **A guest on an H-level or U-level route is 403, not 401.** 401 means "refresh and retry", which a
  guest can never win. Same reasoning as Phase C's `requireUser`.
- **The seat map carries display names and `isSelf`, never ids.** It is shown to spectators and to
  anyone holding the invite link, so it is the wrong place to hand out account identifiers. "Which
  seat is mine?" is a boolean.
- **`team` is written in the same insert as the seat.** For a partnership game the team is part of who
  you are at that table; a follow-up update could fail and leave a seated player on no team, which
  has no correct mid-match repair.
- **Release behaves differently either side of the deal.** `WAITING` deletes the row and frees the
  seat. `IN_PROGRESS` keeps it and stamps `disconnectedAt`, because the seat belongs to the *match*
  now — it holds the player's cards, chips and reward eligibility (`04` §5.2). Vacating it would
  delete a hand mid-play.
- **Invite code generation is a port.** `application/` may not import `infrastructure/`, and the seam
  pays for itself at once: a test hands in a generator that returns the same code twice and proves
  `mint` survives the collision — something real randomness cannot be made to do. Minting retries on
  the constraint rather than checking whether a code is free first, for the same reason the seat
  claim does.
- **Revocation and closing are tombstones.** `revokedAt` and `closedAt`, both idempotent. The event
  log, match results and ledger rows all reference the table, and a cascade would erase the history
  that pays people.
- **`requireApproval` is a refusal, not a queue, at M0.** There is no pending-member state in the
  schema and inventing one now would be guessing at the socket flow S24/S43 actually needs. The
  leaked-link defence still works today: a stranger cannot sit down.
- **Three new env vars,** all in `.env.example`: `INVITE_TTL_HOURS=24`, `INVITE_RESOLVE_MAX=30`,
  `INVITE_RESOLVE_WINDOW_SEC=60`.

## The assertions I'd read first

```
★ two claims on the same seat: exactly one wins
★ four rivals racing for one seat still produce one occupant
★ one identity cannot hold two seats at one table
★ IN_PROGRESS keeps the row and stamps disconnectedAt — the seat belongs to the match
★ unseating someone else is a host act — and an audited refusal otherwise
★ carries no game state — the transport rule, pinned
★ resolves with no cookie at all
★ the bodies are byte-identical, so codes cannot be enumerated
★ leaks no PII, no ids and no game state
★ a guest cannot claim a seat at a table it is not bound to — 403 plus an audit row
★ a guest reads its own table and is 403 on any other
★ rejects literal English where an i18n key belongs
★ is absent from a production registry entirely
★ does not seat the host — sitting down is a separate act
★ only the host may seat a bot
★ seat identity comes from the socket/cookie, never from the payload
```

The first three are the reason two friends can click the same seat. The invite trio is the reason the
link works in a private window without becoming a code oracle.

One line in the seat-claim output looks like a failure and is not: `prisma:error  Unique constraint
failed on the fields: (tableId, seat)`. That is the mechanism working — the claim path inserts and
catches.

## The Postman collection, and the bug it found

`postman/Template.postman_collection.json` (+ `Template.local.postman_environment.json`) covers the
whole REST surface as it stands: **58 requests, 77 assertions, 9 folders**, `00 Health` through
`08 Teardown`. Import both files, pick the *Template — local* environment, run the collection top to
bottom. Every request asserts something, so a run is a smoke test rather than a pile of saved URLs.
It grows with every phase from here — that is now step 5 of the session protocol in `context.md`.

Verified by actually running it, not by inspection: `newman run` against a live API on `:3999`,
against a throwaway copy of the database so `prisma/dev.db` was never touched. **58/58 requests,
77/77 assertions, 0 failures.**

**Its first run failed one assertion, and the assertion was right.** It minted the code `WRQ6UUR6`,
which contains a `U` — while `inviteCode.ts` documented the alphabet as *"upper case only, with
`I L O U 0 1` removed"*. The docblock also contradicted itself: it claimed 31 symbols, and 36
alphanumerics minus those six is 30. `U` was never actually removed, and `U`/`V` is precisely the
confusion the alphabet exists to prevent.

`INVITE_ALPHABET` is now `'23456789ABCDEFGHJKMNPQRSTVWXYZ'` — 30 symbols, ≈6.6 × 10¹¹ codes, 0.3
bits per character cheaper and backward-compatible, since lookup is by exact string and any code
already minted with a `U` keeps working.

**The more useful lesson is about the test.** My own vitest case asserted
`expect(code).not.toMatch(/[ILOU01]/)` against **one** generated code, so it passed roughly four runs
in five with the defect sitting in place — it passed on the run I reported, by luck. A property that
holds "usually" is not a property. It now asserts on the alphabet *constant*, where the check is
total, plus a separate case that minted codes are drawn from it. Worth remembering for the leak-test
suite in M1, where the same trap is waiting: sampling one projection proves nothing.

## What changed in work already done

- **`_probe/table/:tableId` is deleted**, as S16's note said it should be. The three tests in
  `auth-guest.test.ts` that used it now run against `GET /tables/:id`, which carries the same
  `enforceGuestBinding`. `requests/auth.http` points at the real route too.
- **`MetricsRegistry` gained nine Phase D counters.** `invite_resolve_failures` is the interesting
  one: with a single answer for every dead link, that counter and the `INVITE_ABUSE` rows are the
  only place "a friend reloaded a dead link" and "someone is spraying codes" are distinguishable.
- **The `npm install` caveat from Phase C is cleared** and Phase D added no dependencies. Worth
  knowing for future sessions: the suite can be run from WSL against the Windows-installed tree with
  `"/mnt/c/Program Files/nodejs/node.exe" node_modules/vitest/vitest.mjs run` — `tsc`, `eslint`,
  `prettier` and `contracts:sync` are pure JS and never cared.

## Before you verify

Port 3000 is still occupied on this machine, so everything live was checked on `PORT=3999`.
Playwright still can't launch (missing `libnspr4`/`libnss3`, needs sudo). Neither blocks Phase D.

`frontend/`'s 18 tests were not re-run — only its `src/contracts/` mirror changed, which is pure JS
and `contracts:check`-clean, but the tree is Windows-installed. `cd frontend; npm test` from Windows
confirms it.

Every checkbox in `plan.md` is still unticked — those are yours after the "You verify" pass. The
exact commands are in `.claude/context/build/context.md`, and **`requests/tables.http` walks all of
Phase D from your editor**, block by block, saying what each response proves.

Commit message when you're ready:

```
feat(m0): tables, invites and seats through Phase D (S17–S20)

The game registry: GameEngine as the full 05 §1 interface (types only, so the
platform is built against the real shape from here on), GameMeta for the five
v1 games plus the dev-only fixture, and a Zod meta-schema run at registry
construction that catches a bad playableCount, literal English where an i18n
key belongs, or a preset its own game would reject. GET /games and
/games/:slug are public and in-memory, and each game's optionsSchema is
published as JSON Schema by a converter that throws rather than truncate.

Table CRUD with options parsed by the engine's own schema and stored
post-parse, so a table records what will actually be played. The H access
level reads the table once and stashes it on req.table; a matchmade table has
no host and refuses every H route. GET /tables/:id carries the seat map and
no game state — asserted key by key, because that rule erodes one convenient
field at a time. Closing is a tombstone, never a delete.

Invites: host-only mint and revoke, and GET /invites/:code with no
authentication at all — its own router, so nobody can protect it by accident.
Codes are 8 chars over an alphabet with I L O U 0 1 removed. Revoked, expired,
exhausted, dangling and unknown all leave through one refuse() with a
byte-identical 410, or the endpoint becomes an oracle for enumerating live
codes; the reason goes to an INVITE_ABUSE row instead. Resolution has its own
per-IP budget on top of the global limiter.

Seats: claim, release, spectators, bots and teams. The claim path contains no
SELECT — the insert goes in and the unique constraint decides, proven by a
Promise.all of two claims and then four, each leaving exactly one occupant.
Release deletes the row while WAITING and stamps disconnectedAt once
IN_PROGRESS, because by then the seat belongs to the match. Exposed over
three dev-only /_probe routes, dated for deletion in S24.

S16's _probe/table/:tableId stand-in is deleted: the guest binding now lives
on GET /tables/:id, and the three tests that proved it moved to the real
route.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```
