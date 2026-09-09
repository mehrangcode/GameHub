Phase E (S21–S22) of M0 is built and green.

**829 backend tests · typecheck · lint · prettier · contracts:check — all green.** Up from 708. The
ledger that pays people, and journey J2: a friend who joined with no account signs up mid-hand and
keeps both their seat and their coins — or neither.

## What shipped

**S21 — the credit path.** `WalletService.credit` implements `10` §2.4 step for step: look the
derived key up, apply the caps, and either append the row (which writes the cached balance in the
same transaction) or append a **zero-amount `CAP_REJECTED` row with a reason**. Alongside it:
`balanceFor`, `balances`, `statement`, and `recompute` — the reconciler's view, which S38's nightly
job calls. The caps themselves are a pure function in `domain/economy/caps.ts`, the derived keys are
pure builders in `domain/economy/idempotency.ts`, and both are read from data: `IRewardRuleRepository`
is new, and the `_global` `RewardRule` row is where every number lives.

**S22 — the claim transaction.** `POST /auth/guest/claim`, all twelve steps of `03` §6.1 inside one
`uow.run`: verify the session, create the user, carry the preferences over, grant the default
cosmetics, **transfer the seat by UPDATE**, re-attribute the event log, the chat and the
participations, create the vested wallets, **vest the coins with a matched negative row**, claim the
guest session conditionally, and issue a refresh token in a new family. It returns
`{ identity, redirectTo, vestedCoins, forfeitedCoins, seatPreserved }` — and `redirectTo` comes from
the server, decided by the same transaction that preserved the seat.

Supporting work the two sessions needed: `IMatchParticipantRepository` (narrow, deliberately),
`IChatRepository.reattributeActor`, `IGuestSessionRepository.claimIfUnclaimed` replacing
`markClaimed`, two cap-window queries on `IWalletRepository`, `contracts/dto/wallet.ts`,
`scripts/dev-credit.ts`, `requests/wallet.http`, and a dev-only `GET /_probe/wallet` dated for
deletion in S37.

## Five things worth your attention

**1. The seat is *updated*, and the test is about identity rather than equality.** Step 5 is the
whole session. `TableMember` keeps its own `id`, `seat`, `team` and `joinedAt`, so no seat is
vacated, nothing is re-taken, and once S24 lands there is no `table:seatVacated` for the other four
players to see. From their point of view nothing happened except a name badge losing its "guest"
marker. A test that only checked *"the new user is at seat 2"* would pass against a
delete-and-reinsert implementation — which is exactly the bug, and it flashes an empty seat across
four screens mid-trick. So the assertion captures the row id before the claim and demands the same
value back afterwards. The Postman folder does it too, over HTTP, using the seat map's `memberId`.

**2. E1 is enforced by the shape of the interface, not by a test on a call site.** `11` S21 asks for
"a test asserting no code path calls `bumpCachedBalance` without appending a row". This codebase
answers a step earlier: **there is no `bumpCachedBalance`.** `IWalletRepository.append` writes the
ledger row and the cached balance together or not at all, and the interface exposes no other
mutation — so `balance == Σ transactions` is not a rule anyone has to remember, it is a sentence
nobody can write. `tests/unit/wallet/ledger-invariant.test.ts` therefore guards the *design*: the
interface declares no setter under any of seven plausible names, the Prisma repository writes
`balance:` only inside `append`, only `append` and `markVested` touch the wallet row at all, and the
sum is re-checked after every single append in a sequence (checking only at the end would let a path
that wrote the balance twice net out invisibly).

**3. `sumCreditsSince` counts positive amounts only, and that clause is the whole cap.** If the
window netted debits against credits, a player could **spend their way back under the daily cap and
keep earning** — the store would become a cap bypass. A cap is on earning *rate*, and spending is not
negative earning. There is a contract test named after it, run against both the fakes and SQLite.

**4. Coins are *moved*, never conjured.** Vesting is two rows, not one: `+min(provisional, 500)` on
the new user's wallet and `−same` on the guest's, both under the key `vest:{guestSessionId}`. When
the cap bites — 900 provisional, 500 vested — a third row, `GUEST_FORFEIT` for −400 reasoned
`GUEST_VEST_CAP`, empties the guest wallet and *explains* the shortfall rather than leaving it
merely absent. Σ across both wallets is conserved and the guest wallet lands on exactly zero. That
difference between "explained" and "absent" is the difference between a bounded incentive and a
support conversation.

**5. The refusal reasons differ here, and that is deliberate — unlike the invite endpoint.** `GET
/invites/:code` has one byte-identical 410 for every way a link can be dead, because any difference
makes it an oracle. The claim endpoint distinguishes `GUEST_EXPIRED` from `ALREADY_CLAIMED`, because
the caller is presenting a cookie *we issued to them*: possession is already proof, and the two send
the player to two different screens. What stays undifferentiated is a token that resolves to nothing
— malformed, forged, unknown and swept all answer `NO_GUEST_SESSION`, where the difference *would* be
information about which tokens exist.

## Structural decisions

- **The cap windows are rolling, not calendar.** A cap that resets at a wall-clock instant can be
  straddled: 2 000 coins at 23:50 and 2 000 more at 00:10 is 4 000 in twenty minutes, which is
  precisely the rate E7 exists to refuse. Same reasoning as S12's sliding-window limiter. The one
  calendar-keyed thing stays calendar-keyed — the daily bonus, whose `daily:{holder}:{YYYY-MM-DD}`
  key *is* its once-a-day guarantee.
- **`applyCaps` is pure.** The interesting cases are boundaries — exactly at the cap, one coin over,
  three caps binding at once, a cap an operator lowered below a holder's current spend — and each
  would otherwise need ledger rows written at controlled times. 23 unit tests, no database, no clock.
- **A partial cap credits what fits.** 100 requested against 30 of headroom writes a 30-coin
  `MATCH_REWARD` reasoned `CAP_PER_HOUR:100`; only a zero becomes `CAP_REJECTED`. Refusing the whole
  reward because part of it exceeded a cap would be punitive, and recording the cap on the *paying*
  row lets one row render "earned 100, credited 30, hourly limit".
- **`reason` is a machine code carrying the requested amount.** Same discipline as `i18nKey`: the
  statement renders in Persian with no round-trip through the server (`02` §8.1). Two facts, neither
  otherwise recoverable — which cap bound, and what was originally earned.
- **Four kinds are exempt from the caps,** each for a reason. `GUEST_VEST` moves coins between
  wallets rather than minting them, so charging it against the daily cap would mean a guest who
  earned right up to the limit could not keep their own balance. `ADMIN_ADJUST` is an operator
  correcting a mistake, and a cap silently eating the correction is worse than the mistake.
  `REFUND` returns coins the holder already had. And a negative amount is not an earn.
- **`WalletService` has two entry points.** `credit()` opens its own transaction; `creditWithin(repos,
  …)` joins one the caller already opened. Prisma cannot nest `$transaction`, and S22 and S36 must
  credit as *part of* a larger all-or-nothing transaction — a vested wallet with no transferred seat
  is as broken as the reverse. The seam is a requirement, not a convenience, and there is a test that
  a throw after `creditWithin` leaves no ledger row.
- **`recompute` reports drift and refuses to repair it.** A silent self-heal would hide the write path
  that lied, which is the only interesting question. S38 raises an `ALERT`; it does not fix.
- **The caps fall back to `10` §3.7's numbers when the `_global` row is missing.** An unseeded
  developer database must not fail its first credit — and an *uncapped* economy is the worse of the
  two failures.
- **`capMultiplier` is declared now and unused until M7.** It scales the hourly and daily ceilings
  only, never the guest cap (a guest holds no subscription) and never to infinity. E3: premium buys
  earn *rate*, never immunity. Declaring it now gives the multiplier one home instead of two.
- **`markClaimed` is replaced by `claimIfUnclaimed`, which returns `null` on a loss.** The old
  signature could not express an atomic claim: two requests with one guest cookie both read an
  unclaimed session, both build a user, and under PostgreSQL's default isolation both would commit.
  The conditional `updateMany where { claimedAt: null }` makes the database pick a winner, and the
  loser's whole twelve-step transaction unwinds — including the account it created. Same discipline as
  `revokeIfActive` and `claimSeat`. An unknown id also returns `null` rather than throwing, matching
  Prisma, because the caller cannot act on the difference.
- **`GuestSession.prefsJson` is copied through a whitelist.** The blob was written by a client and
  `preferences.upsert` spreads its patch straight into Prisma — an unknown key would crash the claim
  over a *preference*, and a key matching a different column would let a guest set it. Every field is
  named, every enum value checked against `contracts/enums.ts`, and anything unrecognised is
  **dropped rather than rejected**: losing a theme choice must never cost somebody their seat.
- **`POST /auth/guest/claim` carries no `requireIdentity()`.** `authenticate` resolves the access
  cookie *first* — correctly, since a player who signed up mid-session **is** a user — so a browser
  holding both cookies would present as a user and `req.identity` would never be the guest being
  claimed. The route reads the cookie directly and the service refuses. There is an assertion that a
  `tableId` in the body is a 400: that is the field somebody will eventually try to add, and
  accepting it would turn this into a route that can take another table's seat.
- **`clearGuestCookie` was added,** because `clearAuthCookies` would have cleared the two cookies the
  claim had just issued — a bug that would have read as "the claim logs you out".
- **`scripts/dev-credit.ts` grants coins through `WalletService`, never an `INSERT`.** Nothing is
  earnable before S36, so the setup for a hand-walked J2 has to come from somewhere. Going through
  the service means the derived key, the caps, `balanceAfter` and the audit row all happen — teaching
  anyone to insert a ledger row by hand is exactly how a cached balance and its ledger drift apart.
  It refuses to run under `NODE_ENV=production`; `ADMIN_ADJUST` from the audited console (`12` §7.2)
  is the production answer.
- **`IMatchParticipantRepository` is deliberately narrow** — one re-attribution method and two
  counts. Step 7 needs it now and S36 grows it into the settlement repository. Its *populated* case
  is asserted against the database rather than in the contract suite, because a `MatchParticipant`
  row needs a `MatchResult` and no repository can create one yet. An honest gap, not a hidden one.
- **No new dependencies, and no schema change.** Everything Phase E needed was already in
  `prisma/schema.prisma` from S05.

## The assertions I'd read first

```
★ the same idempotency key credits exactly once, and returns the first row
★ holds after a randomized sequence of 500 credits
★ a fully capped reward writes a zero-amount CAP_REJECTED row, never silence
★ a replayed capped reward stays capped — it does not pay later
★ ignores debits — spending is not negative earning
★ a guest is capped tighter than a user, and lands on a PROVISIONAL wallet
★ IWalletRepository declares no way to set a balance
★ the repository writes Wallet.balance in append() and nowhere else
★ a balance move always leaves a row behind — the two are one write
★ the same key twice in ONE transaction still pays once
★ the hourly window rolls: a backdated credit stops counting against it
★ the seat keeps its identity: same id, seat, team and joinedAt
★ provisional 120 becomes vested 120, with a balanced mirror row
★ provisional 900 vests 500 and forfeits 400, explained on its own row
★ duplicate email at step 2: no user, no seat change, no vest
★ expired guest at step 1: 401, and nothing is created
★ a throw at step 6 rolls back the created user
★ a throw at step 9 rolls back BOTH the user and the seat transfer
★ the guest token is dead the moment the claim commits
★ a second claim of the same session loses, and changes nothing
★ redirectTo comes from the server, naming the table the seat is on
```

The first four are the reason a retried settlement cannot pay twice. The seat one is the reason your
friend does not lose their place. The four rollback cases are `03` §6.1's own list, and each asserts
on what is *absent* afterwards rather than on the error.

Two lines in the output look like failures and are not. `prisma:error  Unique constraint failed on
the fields: (email)` in the claim tests is the duplicate-email rollback working. And the
`recompute reports drift` test deliberately corrupts a cached balance to 7 and then asserts it is
*still* 7 — the point being that nothing self-heals.

**One thing to know about the rollback tests.** The spies go on
`PrismaGameEventRepository.prototype` and `PrismaWalletRepository.prototype`, not on
`container.repos`: `uow.run` builds a fresh repository set bound to the transaction client, so the
container's instances are not the objects the claim uses. That is the design working (`02` §5.4), and
it cost twenty minutes to rediscover — worth knowing before writing the next rollback test in S36.

## The Postman collection

Folder **`07 Wallet & the claim — journey J2`** is new, and folders `07`/`08` renumbered to `08`/`09`.
The collection is now **71 requests, 99 assertions, 10 folders**. Verified by running it, not by
inspection: `newman run` against a live API on `:3999`, against a throwaway copy of the database, on
**default rate limits** — 71/71 requests, 99/99 assertions, **0 failures**.

The folder walks the journey — invite, guest joins, guest sits at seat 2, provisional wallet, a
`tableId` in the body → 400, the host's email → 409 with the seat still the guest's, the claim, the
same `memberId` and `joinedAt` afterwards, three vested wallets, and the dead token → 401.

**Two things it cannot show, said out loud in its description rather than glossed.** Coin *amounts*:
nothing is earnable over HTTP until S36 settles a match, so every balance there is 0 and
`vestedCoins` is 0 — the 120→120 and 900→500 cases live in Vitest and in `requests/wallet.http` with
`dev-credit.ts`. And it runs against a table with history, because folder 05 left a bot at seat 3.

**A finding worth carrying forward: `auth:create` is now the tightest budget in the collection.**
`/auth/register`, `/auth/guest` and `/auth/guest/claim` share one bucket of 10 per minute per IP —
correctly, since each mints an account and burns an argon2 hash, and an attacker must not get ten of
each. A full run spends **8** of those 10, so folder 07 is the *first* place a too-soon rerun 429s,
before the global 100/min limiter ever bites. One check was removed to buy that headroom (a claim
with a five-character password, whose i18n-key contract folder 08 asserts on a route that costs no
budget, and which `guest-claim.test.ts` asserts on this one). If you add a request here that
registers, joins as a guest, or claims, take one out.

**And a mistake worth recording, because it wasted an hour.** Swapping `postman-check.db` with
`rm && cp` **while the server is running** leaves SQLite holding a handle to the deleted inode, so
every request afterwards fails against a database nobody can see. The symptom is a wall of 401s and
`tableId: null` that reads exactly like a broken collection. Copy the file *before* starting the
server; to rerun, stop it, re-copy, start again. That is now written into `context.md`'s runbook.

## What changed in work already done

- **`IGuestSessionRepository.markClaimed` is gone,** replaced by `claimIfUnclaimed`. Nothing called
  it yet, so replacing it beat keeping two ways to claim one session. Its contract test was rewritten
  and two were added — the second-claim race and the unknown id.
- **`Repositories` gained `rewardRules` and `participants`;** `IChatRepository` gained
  `reattributeActor`; `IWalletRepository` gained `sumCreditsSince` and `countCreditsSince`. All five
  are exercised by the shared contract suite, so the fakes and SQLite are held to the same behaviour
  — the count went from 91×2 to 120×2 with no assertion edited.
- **`MetricsRegistry` gained eight Phase E counters.** `wallet_credits_replayed` is the interesting
  one: it counts idempotency keys that *collided*, which is the mechanism working. A spike means
  something upstream is retrying; a permanent zero probably means the keys stopped being derived.
- **`contracts/dto/wallet.ts` is new** and synced to `frontend/src/contracts/`. S37 renders exactly
  these shapes; defining them beside the service that produces them means the shape is settled by the
  thing that produces it.

## Before you verify

Port 3000 is still occupied on this machine, so everything live was checked on `PORT=3999`.
Playwright still can't launch (missing `libnspr4`/`libnss3`, needs sudo). Neither blocks Phase E.

`frontend/`'s 18 tests were not re-run — only its `src/contracts/` mirror changed (one new file,
`dto/wallet.ts`), which is pure JS and `contracts:check`-clean, but the tree is Windows-installed.
`cd frontend; npm test` from Windows confirms it.

**S23 is the first `npm install` since Phase C** — it needs `socket.io` and `socket.io-client`.
Whichever OS runs it owns the tree, and `npm run db:generate` must follow it or every DB-touching
test fails with a missing Prisma engine. The note is in `context.md`.

Every checkbox in `plan.md` is still unticked — those are yours after the "You verify" pass. The
exact commands are in `.claude/context/build/context.md`, and **`requests/wallet.http` walks the
whole of J2 from your editor**, block by block, saying what each response proves. The one thing to
look hardest at is `memberId` and `joinedAt` on seat 2, before and after the claim: if those two
values change, the seat was recreated rather than transferred, and everything else in this phase is
decoration.

Commit message when you're ready:

```
feat(m0): the wallet ledger and the guest→user claim through Phase E (S21–S22)

The credit path per 10 §2.4: look the derived key up, apply the caps, and
either append the row or append a zero-amount CAP_REJECTED row with a reason,
because a reward silently not granted is indistinguishable from a bug. The
caps are a pure function over usage and limits read from the _global
RewardRule row, so rebalancing the economy is an UPDATE; the windows are
rolling rather than calendar, because a cap that resets at a wall-clock
instant can be straddled for 2x the intended rate. Keys are derived, never
random, and pinned to the spec table character by character.

E1 is enforced by the shape of the interface rather than by a test on a call
site: there is no bumpCachedBalance, so "balance is written only inside the
transaction that appends the row" is a sentence nobody can write. A test
guards that design — no setter on the interface, one balance write in the
repository, and the sum re-checked after every append. sumCreditsSince counts
positive amounts only, or a player could spend their way back under the daily
cap and keep earning.

WalletService has two entry points: credit() opens a transaction and
creditWithin() joins one, because vesting and settlement must be part of a
larger all-or-nothing transaction rather than a separate commit.

The claim transaction, all twelve steps of 03 §6.1 in one uow.run. Step 5
UPDATES the TableMember row — same id, seat, team and joinedAt — so no seat is
vacated and the other players see nothing but a name badge losing its "guest"
marker; a delete-and-reinsert would pass every other assertion and fail that
one. Step 9 moves the coins with a matched negative row and a GUEST_FORFEIT
row for anything above the 500 vesting cap, so the shortfall is explained
rather than absent and the ledger stays balanced. Step 11 is a conditional
write: claimIfUnclaimed replaces markClaimed, so two requests with one guest
cookie cannot both commit, and the loser's whole transaction unwinds.
redirectTo comes from the server, decided by the transaction that kept the
seat.

All four failure modes 03 §6.1 names are tested by what is absent afterwards.
The guest session row survives forever as the audit link and its token is dead
the moment the claim commits.

Supporting: IRewardRuleRepository, IMatchParticipantRepository (narrow until
S36), chat re-attribution, two cap-window queries, contracts/dto/wallet.ts,
scripts/dev-credit.ts, requests/wallet.http, and a dev-only GET /_probe/wallet
dated for deletion in S37. No new dependencies, no schema change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```
