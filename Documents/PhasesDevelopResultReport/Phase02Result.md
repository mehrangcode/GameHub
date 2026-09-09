Phase B (S07–S10) of M0 is built and green.

**392 backend tests · typecheck · lint · format · contracts:check — all green.** Up from 90.

## What shipped

**S07 — Domain vocabulary** · `domain/value-objects/` (`Card` as the 2-char `` `${Rank}${Suit}` ``
string, `SeatId` and `ChipAmount` as branded ints, `IdentityRef`/`OccupantRef`/`HolderKey`),
`domain/entities/` (plain shapes for all 20 persisted models — **not** Prisma types, which is what
keeps the lint boundary meaningful), `domain/errors/` (a class for every one of the 14
`ERROR_CODES`), and `domain/games/shared/rng.ts` (xoshiro128\*\* seeded by SHA-256, `crypto.randomInt`
for production, Fisher–Yates over `rng.int(i+1)`).

The RNG tests are the ones that matter later: seeded RNG is byte-reproducible, `shuffle` never
mutates its input, and χ² over 60 000 draws catches bias in both generators. A separate test shuffles
three items 60 000 times and checks all six permutations land within a few percent of each other —
that one fails loudly if anyone "simplifies" `int(i+1)` to `int(n)`.

**S08 — 14 repository interfaces + in-memory fakes + one shared contract suite.** 91 assertions,
written once.

**S09 — 14 Prisma repositories + `UnitOfWork`.** The same 91 assertions, now **182 = 91 × 2**. S09's
only edit to the suite was appending `prismaHarness()` to `tests/harnesses.ts` — zero expectations
changed. That is the whole point: a fake that quietly behaves differently from the real repository is
worse than no fake, and this is the only way to know it doesn't.

**S10 — `container.ts`, the `02` §7 middleware chain, Pino redaction, `/health` + `/ready`,
`requests/health.http`.**

## Three things worth your attention

**1. Four error codes needed HTTP statuses the spec never assigned.** `02` §5.6 tables only the nine
REST errors; `ILLEGAL_PHASE_TRANSITION`, `INSUFFICIENT_FUNDS`, `CAP_REJECTED` and
`SEAT_NOT_RECLAIMABLE` surface mainly as socket acks. I chose 409 / 409 / 429 / 409 and wrote the
reasoning into the docblock. The one worth arguing about: `INSUFFICIENT_FUNDS` is deliberately **not**
402 Payment Required — coins are earned, never bought (`10` §6.5), and 402 would imply the purchasable
currency the platform refuses to have. Change it if you disagree; it's one line and one test row.

**2. The live smoke test caught two things the unit tests could not.** Running the server for real
showed (a) every 404 emitting a ten-frame stack trace into the log, burying the one line a human
wants, and (b) the `x-pending-middleware` dev header — which lists `helmet,cors,rateLimit,
authenticate,authorize` as *not yet in force* — being served in production mode. That header is a
reconnaissance gift. Both fixed: 4xx logs without a stack, and the header is suppressed when
`NODE_ENV === 'production'`. Verified in both modes.

**3. `/ready` counts a table instead of running `SELECT 1`.** On SQLite the driver *creates* a missing
database file, so `SELECT 1` would report ready against a `DATABASE_URL` typo while every real query
failed. `prisma.rewardRule.count()` proves the schema is actually there — which is what your S10
verify step is really testing.

## Structural decisions

- **`IWalletRepository` exposes no way to set `balance`.** `append()` is the only mutation, and it
  writes the ledger row and the cached balance inside one transaction. E1 becomes structural instead
  of a convention someone eventually forgets.
- **`IGameEventRepository` and `ISecurityEventRepository` do not extend `IRepository`** — no `update`,
  no `delete`. An append-only log with an update method is not an append-only log.
- **`PrismaRepositoryBase.atomically()`** detects whether it is already inside a transaction
  (a `TransactionClient` has no `$transaction`), so `wallets.append` and `events.append` are atomic
  standalone *and* flat inside `uow.run` — one code path, no transactional twin to drift.
- **`events.append` retries a lost `seq` race** (bounded, 5 tries, on P2002). `MAX(seq)+1` is a
  read-modify-write; the unique constraint catches the collision and the retry makes concurrent
  appends produce a gapless log. You can watch it happen — the test logs the P2002 and still asserts
  `[1, 2, 3, 4]`.
- **Unbuilt middleware are named no-op stubs in the exact `02` §7 order.** Order is the security
  property; S12 fills in bodies rather than re-deriving the chain.
- Added **`ICosmeticRepository.upsertItem`**, which `02` §5.2 doesn't list. Without it the catalog was
  unreachable through the interface and untestable by the contract suite.

## The assertions I'd read first

```
★ two simultaneous claims for one seat: exactly one wins, the loser gets null
★ two simultaneous credits with the same key pay exactly once
★ rolls back BOTH writes when the second one throws
★ rolls back a wallet credit — the ledger row and the balance together
★ a retried move with the same clientMoveId returns the original event
★ turns an unexpected error into an opaque 500 with no stack in the body
★ returns 503 when the database is not there
```

Each of these is a property the rest of M0 assumes. The claim transaction (S22) and reward settlement
(S36) are only trustworthy because the rollback one holds.

## Unchanged from Phase A

Port 3000 is still occupied on this machine by another Express process — everything above was verified
on `PORT=3999`. Playwright still can't launch (missing `libnspr4`/`libnss3`, needs sudo). Neither
blocks Phase B.

I left every checkbox in `plan.md` unticked — those are yours after the "You verify" pass. The full
command list is in `.claude/context/build/context.md`, which also records the smaller decisions.

Commit message when you're ready:

```
feat(m0): domain, repositories, and app assembly through Phase B (S07–S10)

Domain vocabulary: Card/SeatId/ChipAmount/IdentityRef value objects, plain
entity shapes for all 20 models, an AppError class for every ERROR_CODES
member, and an injectable Rng (xoshiro128** seeded, crypto.randomInt secure)
with reproducibility and chi-square uniformity proofs.

Fourteen repository interfaces with in-memory fakes and Prisma implementations,
both held to ONE shared contract suite — 91 assertions run twice, 182 total.
UnitOfWork over $transaction, with rollback and concurrency asserted against
real SQLite: one winner per seat race, one payment per idempotency key, a
gapless event log under concurrent appends.

Composition root, the 02 §7 middleware chain with named stubs holding the
unbuilt positions, Pino redaction configured at the logger, and /health vs
/ready as genuinely different questions.

02 §5.6 leaves four socket-oriented error codes without an HTTP status;
assigned 409/409/429/409 with the reasoning recorded in domain/errors.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```
