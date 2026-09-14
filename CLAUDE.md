# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository State

**M0 Phases A–J (S01–S44) are built.** `backend/` and `frontend/` exist, with **1707 backend
tests** and **154 frontend tests** green: TS-strict scaffolds and the architecture lint guards, the
Zod-validated environment, the `contracts/` mirror + drift guard, the full Prisma schema and
idempotent seed, the repository set behind one contract suite run against both fakes and SQLite,
cookie auth with refresh rotation and table-bound guest tokens, the game catalog, table/invite/seat
lifecycle, the wallet ledger with derived idempotency and caps, the guest→user claim transaction,
the Socket.IO gateway with the room model / presence / chat / optional Redis, the append-only event
log (the `_fixture` engine, seed commitment, `GameSessionService`'s move pipeline, snapshots and
resync, per-viewer projection), turn enforcement (absolute deadlines that survive a restart, the
private warning, the strike ladder, ejection with bot substitution, seat reclamation), the economy
(the pure reward formula, per-seat idempotent settlement with forfeiture, live repeat-matchup decay
and the premium multiplier, wallet reads plus the public rate card, the row-locked debit path,
guest forfeiture, and a reconciliation job that detects a corrupted balance and refuses to repair
it), and — as of Phase J — **the frontend**: the single-flight refresh interceptor, the
`contracts/`-schema-driven auth forms, the "Aurora Glass" token system with self-hosted fonts, full
`en`/`fa` i18n with real RTL, the registry-driven welcome page, the one-socket manager with `seq`
recovery, the invite landing and guest join, and the shared `TableShell`.

**All three of M0's headline exit criteria run, and the third is now clickable:** an idle player is
warned, struck twice, ejected, replaced by a bot, and the table plays on; **an ejected player on a
winning team earns 0 while their partner earns in full**; a corrupted `Wallet.balance` is detected
and alerted; and the welcome page renders its cards from `GET /api/v1/games`, so a sixth game needs
no frontend deploy.

No `admin-frontend/` yet (that is milestone MA). The next session is **S45** — Dockerfiles, dev
compose and CI, which starts Phase K. See `.claude/context/build/context.md`, which is the live
cursor and is read first, every session.

`Documents/` holds the complete, cross-referenced PRD set for the platform **plus its admin
console**; `Documents/08-roadmap.md` and `Documents/11-build-plan.md` drive the work.
`Documents/13-design-system.md` is the adopted visual language and governs any UI change.

`Documents/README.md` is the entry point: it holds the document index, the **Decisions Already
Locked** table, a requirement→document coverage map, and the **Status** table of open questions.
Read it before proposing any change to the specs.

**Document authority:** `02-technical-prd.md` wins every conflict. If another document disagrees
with it, the other document is wrong and should be corrected — do not "average" the two.

## Detailed Docs

| Doc | What | When |
|---|---|---|
| `Documents/README.md` | Index, locked decisions, open questions, requirement coverage | First, every session |
| `Documents/01-business-prd.md` | Vision, 5 personas, 5 user journeys (J1–J5), scope, metrics, risks | Before any product/scope decision |
| `Documents/02-technical-prd.md` | **Architectural spine** — stack, layers, repository pattern, contract sync, REST surface, DB switching, i18n/RTL, deploy, testing | Before writing any code; authority on conflicts |
| `Documents/03-data-model.md` | Prisma schema, ERD, event sourcing, guest→user claim transaction, wallet ledger | Schema, persistence, match history |
| `Documents/04-realtime-protocol.md` | Socket.IO handshake, room model, full event catalog, projection, `seq`, reconnection, **§6 turn limits & ejection** | Anything real-time or timer-related |
| `Documents/05-game-engine-spec.md` | `GameEngine` interface, invariants I1–I5, shared card/trick/betting modules, RNG, **§7 per-game checklist** | Before implementing any game |
| `Documents/06-frontend-architecture.md` | Vite/React setup, routes + guards, Zustand slices, Axios interceptors, socket discipline, theming tokens, `/customize` | Client work |
| `Documents/07-security-and-anticheat.md` | Threat model, hidden-info defense, move integrity, provable shuffle, guest-token binding, §11 economy integrity, accepted risks | Auth, projections, anything tamperable |
| `Documents/08-roadmap.md` | Milestones M0–M8 + MA (admin console) with scope + exit criteria, backlog order, cross-milestone Definition of Done | Start of every work session |
| `Documents/11-build-plan.md` | **Session layer under the roadmap** — M0 as 50 numbered 2–3 h sessions (goal, build, tests, *You verify* steps, done-when); M1–M8 and MA outlined. §0 has the daily protocol | Start of every work session, with the cursor below |
| `Documents/12-admin-console.md` | **The second application** — admin entrypoint on an unpublished `:3100`, `admin-frontend/`, moderation, ledger oversight, game on/off, reports, TOTP + append-only audit log. §11 is the delivery split | Anything admin-facing |
| `Documents/13-design-system.md` | **The adopted visual language** — "Aurora Glass" (sample 04): token reference, the `.glass` primitive, button variants, the RTL mirror/do-not-mirror table, numerals and dates, and the rules for extending it | Any UI work |
| `.claude/context/build/{plan.md,context.md}` | The live cursor: last session, next session, decisions, blockers, inherited open questions | **Read `context.md` first, before anything else** |
| `Documents/09-matchmaking.md` | Queue pools, presets, 120 s timeout release, bot fill, parties, backfill, farming guards, cooldowns | Matchmaking work |
| `Documents/10-economy-and-rewards.md` | Wallet + append-only ledger, reward formula, forfeiture on ejection, guest vesting, store, sinks, premium, legal boundaries | Anything involving coins |
| `Documents/games/*.md` | Per-game rule specs: `sudoku` (M1), `blackjack` (M2), `shelem` (M4, ⭐ flagship), `poker-holdem` (M5), `chess` (M6), `backlog-games` (later) | Implementing that game |

Conventions inside the docs: Mermaid diagrams, relative links only,
`> **Open question:**` callouts for genuinely undecided items (grep the folder to find all of
them), `[C##]` markers in `shelem.md` tying rules to its §0 sourcing table. Code samples in the
docs are **illustrative shape and intent**, not final code.

## Commands (once `backend/`, `frontend/`, and `admin-frontend/` exist)

```bash
# backend — first run
cd backend && npm install && npx prisma db push && npm run seed && npm run dev   # tsx watch, :3000

# frontend — separate terminal
cd frontend && npm install && npm run dev    # vite :5173, proxies /api and /socket.io to :3000

# admin backend (from S48) — same codebase, second entrypoint, never published
cd backend && npm run dev:admin              # tsx watch, admin routers only, :3100

# admin frontend (from MA) — separate terminal
cd admin-frontend && npm install && npm run dev   # vite :5273, proxies /admin/api to :3100
```

Three **independent** projects — `backend/`, `frontend/`, `admin-frontend/` — with separate
`package.json`, lockfile, tsconfig, and CI pipeline each. There is no root workspace, no monorepo
tooling. `admin-frontend/` talks only to `backend`'s admin entrypoint; it is a third *frontend*, not
a second backend. Redis is optional in dev (`REDIS_URL` unset → in-memory socket adapter +
in-process rate limiter + `CONTROL_TRANSPORT=poll` for the admin control outbox).

Contract sync (see §4.1 of the technical PRD) — one script, two destinations:

```bash
cd backend && npm run contracts:sync     # backend/src/contracts → frontend/src/contracts
                                         # backend/src/contracts/admin → admin-frontend/src/contracts
npm run contracts:check                  # every project; exits non-zero on drift. Runs in CI + pre-commit
```

Tests use **Vitest** everywhere (`npx vitest run path/to/file.test.ts` for a single file,
`-t "name"` for a single test). Backend integration adds Supertest + `socket.io-client`; E2E is
Playwright in `frontend/e2e/` and `admin-frontend/e2e/`.

`postman/` holds a hand-maintained collection of the REST surface plus a local environment, for
importing into Postman. **Every session that adds or changes a route must extend it and run it** —
`npx newman run postman/Template.postman_collection.json -e postman/Template.local.postman_environment.json`
against a live API — as part of the session, not afterwards. One folder per phase, an assertion on
every request. `.claude/context/build/context.md` has the how-to (including why `npm run dev` cannot
serve it from WSL) and the guest-cookie trap.

## Architecture

### Layers (backend) — dependencies point inward only

```
interface/ (Express routers, Socket.IO gateway, admin routers)
   → application/ (services: Auth, Table, GameSession, Reward, Matchmaking, Store, admin/*, …)
      → domain/ (game engines, registry, entities, value objects, repository *interfaces*)
infrastructure/ (Prisma repos, UnitOfWork, Redis, auth primitives) --implements--> domain interfaces
```

**Two entrypoints, one codebase.** `main.ts` serves the public API on `:3000`; `admin-main.ts`
serves `/admin/api/v1` on `:3100`, mounting only `interface/admin/**`, bound internally and never
published. Same `container.ts`, same repositories, same ledger — so the money rules cannot fork.
Isolation is enforced three ways: an ESLint import ban, a boot-time router-stack assertion, and a
permanent test that `:3000/admin/*` is 404 (`12-admin-console.md` §2.4).

`domain/` and `application/` must not import `infrastructure/**` or `@prisma/client`. This is
enforced by ESLint `no-restricted-imports`, not by discipline — it is what keeps game rules
unit-testable without a database. `src/domain/games/**` is additionally barred from importing
anything named `wallet`/`reward`/`matchmaking`.

Wiring is a single explicit `src/container.ts` composition root — no DI framework. Tests build the
same container with `InMemory*Repository` fakes.

### The five things that make this codebase what it is

1. **The server is the only authority.** The client sends *intent* and renders what it is told. No
   game logic, no legality checks, no hidden cards, no winner determination in the frontend —
   `frontend/src/features/games/**` is RENDER ONLY.
2. **Hidden information is removed by projection, not obscurity.** `projectState(state, viewer)` is
   called **once per viewer**, producing N different payloads from one state. There is deliberately
   no "broadcast the state" code path. Public state → `table:{id}` room; private state →
   `seat:{tableId}:{seat}` room. The classic bug to hunt for: projecting `deck: Card[]` (leaks the
   entire future of the game) instead of `deckCount: number`.
3. **Game engines are pure functions.** No `Date.now()`, no `Math.random()`, no I/O, no globals —
   time and randomness are injected. Invariants I1–I5 (`05` §2): pure/deterministic, immutable,
   totally legal, projection-complete, JSON-serializable. `legalMoves()` is a *convenience for the
   UI*; `applyMove()` is the enforcement point and must throw for anything not in `legalMoves`.
4. **The event log is the source of truth.** `GameEvent` rows with `seq` are truth; snapshots are a
   cache. State is rebuilt from snapshot + delta on every move, never held in a mutable process
   map — which is why an API restart loses zero games. Reconnection, replay, dispute resolution,
   and cheat auditing all fall out of this one mechanism.
5. **Balances are ledger-derived.** `balance == Σ WalletTransaction.amount`. `Wallet.balance` is a
   cached column written only inside the same transaction that appends the ledger row. Every credit
   carries a derived idempotency key enforced by a DB unique constraint.

### Transport split

REST (`/api/v1`, Axios) carries auth, table lifecycle *before* play, invite resolution, the game
registry, profile, cosmetics, stats, wallet reads. WebSocket (Socket.IO) carries joins, seat
changes, every move, every projection, chat, presence, timers, matchmaking queue.

**The rule:** if a friend at the table would see it happen live, it goes over the socket.
Socket events are named `domain:action`; client→server use ack callbacks, server→client are
fire-and-forget with a `seq`. Both sides Zod-parse inbound payloads — types catch mistakes at
compile time, Zod catches a hostile client at runtime.

### Adding a game (P5: game #6 must not touch games #1–5)

Implement `GameEngine<S, M>` in `backend/src/domain/games/<slug>/`, register it in
`domain/games/registry.ts`, add the renderer in `frontend/src/features/games/<slug>/`, and work
through the checklist in `05-game-engine-spec.md` §7. `GET /api/v1/games` is registry-driven, so
the welcome page's preview cards need **no frontend deploy** for a new game — only the renderer.

Reuse `domain/games/shared/`: `rng`, deck/card utilities, `trick.ts` (trick-taking — Shelem, then
Hokm), `betting.ts` (Poker + Blackjack), and the phase machine. `Card` is the 2-char string type
`` `${Rank}${Suit}` `` (`'AS'`, `'TD'`) — chosen so I5 holds trivially and I4 is testable by
substring assertion on a serialized projection.

### Frontend state

One Zustand slice per domain in `src/stores/` (`authStore`, `socketStore`, `tableStore`,
`gameStore`, `matchmakingStore`, `walletStore`, `chatStore`, `themeStore`, `uiStore`) — no
mega-store, no context providers wrapping the tree. `gameStore` holds the server's projection
**verbatim**. There are **no optimistic game updates**: an optimistic card play that the server
rejects is worse than 80 ms of latency. Styling is CSS Modules + CSS custom properties, because
the entire cosmetics/theming system is runtime variable swaps.

## Hard Rules (violations are bugs, not style preferences)

- **No game logic in the client.** Ever. This is the point of the project.
- **Seat identity comes from the socket, never the payload.** A client cannot claim to be seat 2.
- **`Math.floor(Math.random() * n)` must not appear in `domain/`.** Shuffle is Fisher–Yates over
  `rng.int(i + 1)`; production RNG wraps `crypto.randomInt` (unbiased via rejection sampling).
- **Table chips ≠ wallet coins.** Poker/Blackjack stacks are ephemeral per-match tokens with no
  wallet relationship. Crossing this line turns a card game into gambling — enforced by lint and
  test, not intention.
- **Premium never confers gameplay advantage.** Cosmetics, convenience, and earn *rate* only.
- **An ejected player earns zero even if their team wins**; their partner earns in full.
  Reward eligibility is per **seat**, not per team.
- **No Prisma enums, `String[]`, JSON path queries, `Decimal`, or native types** in the schema —
  it must target the SQLite ∩ PostgreSQL intersection (`String` + TS union + Zod instead).
- **No `Set`/`Map`/`Date`/class instances in engine state** (breaks I5). `folded: SeatId[]`, not
  `Set<SeatId>`.
- **Logical CSS properties only** (`margin-inline-start`, not `margin-left`) — enforced by
  stylelint. Full RTL is treated as correctness, not polish. Exceptions that must **not** mirror:
  the chess board, the Sudoku grid, card faces/pips — wrapped in `dir="ltr"` islands.
- **Zod-validate every inbound REST body, socket payload, and env var at startup.** Fail fast at
  the boundary; no silent coercion, no `any`.
- **Redis may never hold** wallet/ledger state, matchmaking cooldowns, game state, or reward
  idempotency keys. Redis is for things cheap to lose and expensive to compute.
- **Errors return `i18nKey` + `details`, never a rendered English sentence.** All errors extend
  `AppError` with a stable machine `code`; anything else becomes an opaque `INTERNAL`.
- **No admin route on the public port, ever.** `interface/admin/**` is mounted by `admin-main.ts`
  alone. If you catch yourself adding a role check to a route on `:3000`, you are building the bug
  the isolation guards exist to prevent.
- **No admin mutation without an audit row in the same transaction.** Every mutating admin service
  call goes through `withAudit(...)`. If the audit write fails, the action fails — same discipline
  as the wallet ledger. `AdminAuditLog` is append-only and hash-chained: no update path, no delete
  path, no exceptions, including for you.
- **The admin console never sees live hidden information.** A live table renders the *spectator*
  projection; the raw event log unlocks only once `MatchResult` exists. A "dump the engine state"
  debug screen is a live view of everyone's cards behind one stolen cookie.
- **Platform-initiated interruption is free.** A console-closed table or an admin kick records a
  neutral `SeatOutcome` and forfeits nothing — unlike ejection. Forfeiture punishes idling, not
  operations.
- **Destructive admin actions require fresh TOTP and a written reason.** `reason` is a column and a
  `REASON_REQUIRED` error, not a UI placeholder.

## Testing Priorities

The highest-ROI tests, in order: (1) **game engine unit tests** — ≥90% branch coverage on
`domain/games/**`, full-hand replays from fixtures; (2) the **leak-test suite** asserting a
projected payload for seat A contains no trace of seat B's hidden cards, per game, for every seat,
for spectators, **and for the admin viewer**; (3) **ledger invariants** including the
ejected-winner-earns-zero case; (4) **turn enforcement** — strike ladder, ejection, bot
substitution, reclaim; (5) **admin isolation and audit completeness** — `:3000/admin/*` is 404, and
a manifest-driven test that fails when any mutating admin route forgets its audit row
(`12-admin-console.md` §10).

Every engine takes an injected RNG, so any bug reduces to `(seed, moves[])`. The
`replayFixture(seed, moves)` helper is part of the test kit from M0 and must produce
byte-identical state twice.
