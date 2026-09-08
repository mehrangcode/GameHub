# Technical PRD — Board Game Platform

> **Status:** Draft · **Audience:** implementer (you) · **Read after:** [01-business-prd.md](./01-business-prd.md)

This is the architectural spine. Every other technical document elaborates one box in the
diagrams below. If a decision here conflicts with another document, **this document wins** and
the other should be corrected.

---

## 1. Guiding Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **The server is the only authority on game state.** | The client never computes legality, never holds hidden cards, never decides a winner. It sends *intent*; it renders what it is told. See [07-security-and-anticheat.md](./07-security-and-anticheat.md). |
| P2 | **Game rules are pure functions.** | Engines have no I/O, no clock, no database, no randomness except an injected seeded RNG. Makes them exhaustively unit-testable — the highest-ROI tests in the project. |
| P3 | **Hidden information is removed by projection, not by obscurity.** | A payload that leaves the server for player B has *already had* player A's cards deleted from it. Nothing is "hidden by the UI". |
| P4 | **The event log is the source of truth.** | Reconnection, replay, dispute resolution, and cheat auditing all fall out of one mechanism instead of four. |
| P5 | **Adding game #6 must not require touching game #1..5.** | Games are plug-ins behind a single `GameEngine` interface plus a registry. |
| P6 | **Zero friction for invited guests.** | No signup wall before play. Ever. The signup nudge is a suggestion, not a gate. |
| P7 | **Fail fast, loudly, at the boundary.** | Zod-validate every inbound REST body, socket payload, and env var at startup. No silent coercion, no `any`. |
| P8 | **Balances are ledger-derived, never mutated.** | Every coin movement is an append-only `WalletTransaction` with a derived idempotency key. A cached balance is a cache. See [10-economy-and-rewards.md](./10-economy-and-rewards.md) E1/E2. |
| P9 | **Table chips and wallet coins never touch.** | Poker/Blackjack stacks are ephemeral per-match tokens. Enforced by a lint rule barring wallet imports from `domain/games/**` — because crossing this line turns a card game into gambling ([10](./10-economy-and-rewards.md) E5). |
| P10 | **Time and money live outside the engine.** | Turn timers and reward policy are services. An engine that read a clock or a balance would break P2. |

---

## 2. Technology Stack

### 2.1 Backend

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS | Native `crypto.randomInt`, stable `fetch`, good ESM support |
| Language | **TypeScript 5.x**, `strict: true` | `noUncheckedIndexedAccess` on — card arrays are indexed constantly |
| HTTP | **Express 5** | Express 5 finally handles async errors natively; no `express-async-errors` shim needed |
| Real-time | **Socket.IO 4.x** | Chosen over raw `ws` for rooms, auto-reconnect, ack callbacks, and the Redis adapter — all of which we would otherwise hand-roll |
| ORM | **Prisma 6.x** | Per requirement |
| DB (dev) | **SQLite** | Zero-setup local development |
| DB (prod) | **PostgreSQL 16** | Provider switched by env — see §6 |
| Cache / pubsub | **Redis 7** | Socket.IO adapter, presence, rate limits, timer coordination. Optional in dev (in-memory fallback) |
| Validation | **Zod 3.x** | Single source for runtime validation *and* inferred TS types |
| Auth | `jsonwebtoken` + `argon2` | argon2id for passwords — not bcrypt |
| Logging | **Pino** | Structured JSON, `pino-http` request logging, redaction of tokens/cookies |
| Testing | **Vitest** + **Supertest** + `socket.io-client` | Same test runner as frontend = one mental model |
| Chess rules | **`chess.js`** | Battle-tested; reimplementing chess legality is a needless bug farm |
| Process | **PM2** or Docker restart policy | See §9 |

### 2.2 Frontend

| Concern | Choice | Notes |
|---|---|---|
| Build | **Vite 6** | Per requirement |
| UI | **React 19** + TypeScript | |
| Global state | **Zustand 5** | Per requirement. Slice-per-domain, see [06-frontend-architecture.md](./06-frontend-architecture.md) |
| HTTP | **Axios** | Per requirement. Single configured instance, interceptor-based refresh |
| Real-time | `socket.io-client` | Must match server major version |
| Routing | **React Router 7** | Data-router mode for route-level loaders/guards |
| i18n | **react-i18next** + `i18next-browser-languagedetector` | EN + FA, full RTL — see §8 |
| Styling | **CSS Modules + CSS custom properties** | Custom properties are non-negotiable: the whole cosmetics/theming system is variable swaps at runtime. A utility-first framework would fight this |
| Animation | **Framer Motion** | Card deal/flip/slide; must respect `prefers-reduced-motion` |
| Forms | `react-hook-form` + Zod resolver | Reuses the same Zod schemas the backend validates with |
| Testing | **Vitest** + React Testing Library + **Playwright** | Playwright covers the invite→guest→signup journey |

### 2.3 Explicitly Rejected

| Rejected | Why |
|---|---|
| Next.js | SSR buys nothing for an authenticated, socket-driven game client, and complicates the Socket.IO story |
| Redux Toolkit | Zustand chosen per requirement; RTK's ceremony is unjustified here |
| GraphQL | Two consumers, one client. REST + sockets is less machinery |
| tRPC | Would be excellent — but it assumes a monorepo with shared types. Rejected as a consequence of the two-project layout (§4) |
| Client-side rules engines | Violates P1. This is the entire point of the project |
| Real-money anything | Out of scope forever. Keeps the app clear of gambling regulation |

---

## 3. System Architecture

```mermaid
graph TB
    subgraph Client["Browser"]
        SPA["React SPA (Vite)<br/>Zustand stores"]
        AX["Axios instance<br/>(REST, withCredentials)"]
        SIO["socket.io-client<br/>(gameplay)"]
        SPA --> AX
        SPA --> SIO
    end

    subgraph Server["Node.js API Process"]
        subgraph Interface["Interface Layer"]
            REST["Express 5 routers<br/>controllers"]
            WS["Socket.IO gateway<br/>event handlers"]
        end
        subgraph App["Application Layer"]
            SVC["Services / use cases<br/>AuthService, TableService,<br/>GameSessionService, ChatService"]
        end
        subgraph Domain["Domain Layer — zero infra imports"]
            ENG["Game engines<br/>(pure, deterministic)"]
            REG["Game registry"]
            RepoI["Repository interfaces"]
        end
        subgraph Infra["Infrastructure Layer"]
            RepoP["Prisma repositories"]
            UOW["Unit of Work"]
            RedisA["Redis adapter / presence"]
        end
        REST --> SVC
        WS --> SVC
        SVC --> ENG
        SVC --> REG
        SVC --> RepoI
        RepoP -.implements.-> RepoI
        SVC --> UOW
        UOW --> RepoP
        WS --> RedisA
    end

    DB[("SQLite (dev)<br/>PostgreSQL (prod)")]
    RD[("Redis")]

    AX -->|"HTTPS /api"| REST
    SIO <-->|"WSS"| WS
    RepoP --> DB
    RedisA --> RD
```

### 3.1 Two Transports, One Rule

| Transport | Carries | Never carries |
|---|---|---|
| **REST** (Axios) | Auth, table lifecycle *before* play, invite resolution, game registry, profile, cosmetics, stats, match history | Anything that happens during a live game |
| **WebSocket** (Socket.IO) | Joins, seat changes, every move, every state projection, chat, presence, timers | Authentication credentials (the handshake reads the cookie/guest token, then the socket is trusted for its bound identity) |

**The rule:** if a friend sitting at the table would see it happen live, it goes over the socket.
Otherwise REST. This prevents the classic mess of half the game state arriving by polling.

### 3.2 What Redis owns (and what it must never own)

Redis moved from "nice to have" to load-bearing once matchmaking and turn timers arrived.

| Redis holds | Why Redis | Loss on restart |
|---|---|---|
| Socket.IO adapter pub/sub | Cross-node broadcast | Reconnect handles it |
| Presence / online sets | High-churn, disposable | Recomputed from sockets |
| Sliding-window rate limits | Fast counters, TTL-native | Limits reset — acceptable |
| **Matchmaking queue** (`mm:pool:*`) | Sub-second reads, inherently ephemeral | **Tickets dropped and every queued socket told so** ([09](./09-matchmaking.md) §3) |
| **Turn deadlines** (`game:{id}:timer`) | Fast expiry checks | **Re-armed at startup from the persisted `PHASE` event** — nobody is gifted time |

| Redis must NEVER hold | Why |
|---|---|
| Wallet balances or any ledger state | P8. Money lives in Postgres, in a transaction, or it doesn't exist |
| Matchmaking cooldowns | A penalty that evaporates on deploy is not a penalty ([03](./03-data-model.md) §3.8) |
| Game state | The event log is the truth (P4) |
| Reward idempotency keys | The unique constraint is the mechanism; a cache would let a restart double-pay |

> The dividing line: **Redis is for things that are cheap to lose and expensive to compute.**
> Anything a player would be upset to lose belongs in the database, in a transaction.

The admin control channel (`admin:control`) obeys the same line: Redis carries a *notification
containing a row id*, never the command's authority. The `ControlCommand` row is the truth, so
turning a game off works with Redis down — see [12](./12-admin-console.md) §6.

### 3.3 The admin process

The same codebase boots a **second Node process** from `src/admin-main.ts` on `ADMIN_PORT`
(default `3100`), mounting only `src/interface/admin/**`. It shares `domain/`, `application/`, and
`infrastructure/` with the public API — one ledger implementation, one set of repositories — but is
never published to the internet and never mounted on `:3000`.

That isolation is structural, not conventional: an ESLint import ban, a boot-time router-stack
assertion, and a permanent integration test. Full specification: [12](./12-admin-console.md) §2.

---

## 4. Repository Layout — Three Separate Projects

Per your decision, `backend/`, `frontend/`, and `admin-frontend/` are independent projects with
independent `package.json`, lockfile, tsconfig, and CI. `admin-frontend/` talks only to the admin
entrypoint of the *same* backend — it is a third **frontend**, not a second backend
([12](./12-admin-console.md) §2.2 records why a fourth project was rejected).

```
Template/
├── Documents/                  # this PRD set
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts
│   ├── src/
│   │   ├── contracts/          # ★ CANONICAL socket + REST contracts (see §4.1)
│   │   │   ├── events.ts
│   │   │   ├── dto/
│   │   │   ├── admin/          # ★ admin DTOs — mirrored to admin-frontend ([12] §8.2)
│   │   │   └── index.ts
│   │   ├── domain/             # NO imports from infrastructure/ or prisma
│   │   │   ├── entities/
│   │   │   ├── value-objects/  # Card, Suit, Rank, Deck, SeatId, ChipAmount
│   │   │   ├── errors/         # IllegalMoveError, NotYourTurnError, ...
│   │   │   ├── games/
│   │   │   │   ├── GameEngine.ts        # the interface
│   │   │   │   ├── registry.ts
│   │   │   │   ├── shared/              # deck, shuffle, trick-taking, betting-round
│   │   │   │   ├── sudoku/
│   │   │   │   ├── blackjack/
│   │   │   │   ├── shelem/
│   │   │   │   ├── poker/
│   │   │   │   └── chess/
│   │   │   └── repositories/   # interfaces ONLY
│   │   ├── application/
│   │   │   ├── services/
│   │   │   └── dto-mappers/
│   │   ├── infrastructure/
│   │   │   ├── prisma/
│   │   │   │   ├── client.ts
│   │   │   │   ├── repositories/        # PrismaUserRepository, ...
│   │   │   │   └── UnitOfWork.ts
│   │   │   ├── redis/
│   │   │   ├── auth/           # jwt.ts, password.ts, guestToken.ts
│   │   │   └── logger.ts
│   │   ├── interface/
│   │   │   ├── http/           # public — MUST NOT import interface/admin/**
│   │   │   │   ├── routes/
│   │   │   │   ├── controllers/
│   │   │   │   └── middleware/          # auth, error, rateLimit, requestId
│   │   │   ├── socket/
│   │   │   │   ├── gateway.ts
│   │   │   │   ├── handlers/
│   │   │   │   └── middleware/
│   │   │   └── admin/          # ★ mounted ONLY by admin-main.ts ([12] §2.4)
│   │   │       ├── routes/
│   │   │       ├── controllers/
│   │   │       └── middleware/          # adminAuth, requireRole, requireStepUp, auditContext
│   │   ├── config/             # env.ts (Zod-validated), constants.ts
│   │   ├── container.ts        # dependency wiring (see §5.4)
│   │   ├── app.ts              # public Express app
│   │   ├── admin-app.ts        # ★ admin Express app
│   │   ├── main.ts             # public entrypoint  :3000
│   │   └── admin-main.ts       # ★ admin entrypoint :3100, unpublished
│   ├── tests/
│   │   ├── unit/               # engines — the bulk of the suite
│   │   ├── integration/
│   │   └── fakes/              # InMemory*Repository
│   └── scripts/
│       └── sync-contracts.mjs  # ★ see §4.1 (plain node — it runs from a git hook)
├── frontend/
│   ├── public/
│   │   └── assets/             # card backs, avatars, table felts
│   ├── src/
│   │   ├── contracts/          # ★ MIRROR of backend/src/contracts — generated, do not edit
│   │   ├── api/                # axios client + one module per resource
│   │   ├── socket/             # connection manager, typed emit/on wrappers
│   │   ├── stores/             # zustand slices
│   │   ├── routes/
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   ├── welcome/        # game preview cards
│   │   │   ├── table/          # shared table shell: seats, chat, timers
│   │   │   ├── games/          # one folder per game — RENDER ONLY
│   │   │   ├── customize/      # cosmetics page
│   │   │   └── profile/
│   │   ├── components/         # design-system primitives
│   │   ├── i18n/
│   │   │   └── locales/{en,fa}/
│   │   ├── styles/
│   │   │   ├── tokens.css      # CSS custom properties = the theming system
│   │   │   └── themes/
│   │   └── main.tsx
│   ├── tests/
│   └── e2e/                    # Playwright
├── admin-frontend/             # ★ third project — English/LTR only, no theming, no game code
│   ├── src/
│   │   ├── contracts/          # ★ MIRROR of backend/src/contracts/admin — generated
│   │   ├── api/                # axios, ADMIN base, withCredentials
│   │   ├── stream/             # EventSource (SSE) manager
│   │   ├── stores/             # adminAuth, users, ledger, games, tables, metrics, audit
│   │   ├── routes/
│   │   ├── features/           # auth, dashboard, users, economy, platform, audit
│   │   ├── components/         # DataTable (cursor-only), ReasonDialog, ConfirmDestructive
│   │   └── main.tsx
│   ├── tests/
│   └── e2e/                    # Playwright
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env.example
```

Full admin-frontend specification: [12-admin-console.md](./12-admin-console.md) §8.

### 4.1 The Contract Drift Problem (and its fix)

Two separate projects means the socket event and DTO types are **duplicated**. This is the one
real cost of the two-project choice, and it must be managed explicitly or the two sides will
silently diverge — the failure mode being a runtime payload mismatch that TypeScript happily
compiles on both sides.

**The mechanism:**

1. `backend/src/contracts/` is **canonical**. It contains only types, Zod schemas, and constants —
   never runtime logic, never Node-only imports (no `crypto`, no `fs`).
2. `frontend/src/contracts/` is a **generated mirror**, header-stamped
   `// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT`.
3. `backend/scripts/sync-contracts.mjs` copies the directory and stamps a SHA-256 of its contents
   into `contracts.hash`.
4. Both projects get scripts:
   - `npm run contracts:sync` — backend only; copies and re-stamps.
   - `npm run contracts:check` — recomputes the hash and **exits non-zero on mismatch**.
5. `contracts:check` runs in CI for **all three** projects and in a `pre-commit` hook. A drifted
   contract fails the build rather than shipping.

`backend/src/contracts/admin/` mirrors to `admin-frontend/src/contracts/` by the same mechanism
and the same script — one more destination, not a second mechanism.

> **Note:** if this friction becomes annoying, the escape hatch is publishing
> `backend/src/contracts` as a private npm package (or a git submodule) consumed by both. The
> file layout above is deliberately compatible with that migration — the directory is already
> self-contained with no outward imports.

---

## 5. Backend Design — Layers & Repository Pattern

### 5.1 Dependency Direction

Dependencies point **inward only**:

```
interface  →  application  →  domain
                    ↑              ↑
             infrastructure ────────┘  (implements domain interfaces)
```

Enforced mechanically, not by discipline, via ESLint `no-restricted-imports`:

```jsonc
// .eslintrc — excerpt
"rules": {
  "no-restricted-imports": ["error", {
    "patterns": [
      { "group": ["**/infrastructure/**", "@prisma/client"],
        "message": "domain/ and application/ must not import infrastructure or Prisma." }
    ]
  }]
}
```
…scoped by `overrides` to `src/domain/**` and `src/application/**`. The single most valuable
lint rule in the project: it is what keeps game rules testable without a database.

A third `overrides` block scoped to `src/app.ts`, `src/main.ts`, `src/interface/http/**`, and
`src/interface/socket/**` bans `**/interface/admin/**`. That is what keeps the admin surface off
the public port — one of the three guards in [12](./12-admin-console.md) §2.4.

### 5.2 Repository Interfaces (domain layer)

```ts
// src/domain/repositories/IRepository.ts
export interface IRepository<T, ID = string> {
  findById(id: ID): Promise<T | null>
  create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T>
  update(id: ID, data: Partial<T>): Promise<T>
  delete(id: ID): Promise<void>
}
```

```ts
// src/domain/repositories/ITableRepository.ts
import type { Table, TableMember, SeatId } from '../entities'

export interface ITableRepository extends IRepository<Table> {
  findByInviteCode(code: string): Promise<Table | null>
  findWithMembers(id: string): Promise<(Table & { members: TableMember[] }) | null>
  findOpenTablesForUser(userId: string): Promise<Table[]>
  /** Atomically claims a seat; returns null if the seat was taken (race-safe). */
  claimSeat(tableId: string, seat: SeatId, occupant: OccupantRef): Promise<TableMember | null>
  releaseSeat(tableId: string, seat: SeatId): Promise<void>
  countActiveMembers(tableId: string): Promise<number>
}
```

Full interface set: `IUserRepository`, `IGuestSessionRepository`, `IRefreshTokenRepository`,
`ITableRepository`, `IInviteRepository`, `IGameInstanceRepository`, `IGameEventRepository`,
`IGameSnapshotRepository`, `IChatRepository`, `IStatsRepository`, `ICosmeticRepository`,
`IPreferencesRepository`.

### 5.3 Prisma Implementation (infrastructure layer)

```ts
// src/infrastructure/prisma/repositories/PrismaTableRepository.ts
import type { PrismaClient, Prisma } from '@prisma/client'
import type { ITableRepository } from '../../../domain/repositories'

export class PrismaTableRepository implements ITableRepository {
  /** Accepts a tx client so the same repo works inside a Unit of Work. */
  constructor(private readonly db: PrismaClient | Prisma.TransactionClient) {}

  async findByInviteCode(code: string) {
    return this.db.table.findFirst({
      where: { invites: { some: { code, revokedAt: null, expiresAt: { gt: new Date() } } } },
    })
  }

  async claimSeat(tableId: string, seat: SeatId, occupant: OccupantRef) {
    try {
      return await this.db.tableMember.create({
        data: { tableId, seat, role: 'PLAYER', ...occupantFields(occupant) },
      })
    } catch (e) {
      if (isUniqueViolation(e)) return null   // (tableId, seat) unique → seat already taken
      throw e
    }
  }
  // ...
}
```

Two details that matter:

- **Constructor takes `PrismaClient | Prisma.TransactionClient`.** This is what makes a single
  repository class usable both standalone and inside a transaction, without a second code path.
- **Seat claiming relies on a DB unique constraint**, not a read-then-write check. Two friends
  clicking the same seat simultaneously is a real race; the constraint is the only correct fix.

### 5.4 Unit of Work

Needed because several operations write multiple aggregates and must be atomic — e.g. *guest
claims account*: create `User`, transfer `TableMember`, rewrite `GameEvent.actorId`, delete
`GuestSession`.

```ts
// src/infrastructure/prisma/UnitOfWork.ts
export interface Repositories {
  users: IUserRepository
  tables: ITableRepository
  games: IGameInstanceRepository
  events: IGameEventRepository
  // ...
}

export class UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => work(buildRepositories(tx)))
  }
}
```

Usage in a service:

```ts
await this.uow.run(async (repos) => {
  const user = await repos.users.create(input)
  await repos.tables.transferSeat(guestSessionId, user.id)
  await repos.events.reattributeActor(guestSessionId, user.id)
  return user
})
```

### 5.5 Dependency Wiring

No DI framework. A single `container.ts` composition root — explicit, greppable, and trivially
overridable in tests:

```ts
// src/container.ts
export function buildContainer(prisma: PrismaClient, redis: RedisClient) {
  const uow = new UnitOfWork(prisma)
  const repos = buildRepositories(prisma)
  const registry = buildGameRegistry()        // domain
  const wallet = new WalletService(repos.wallets, repos.rewardRules, uow)
  const rewards = new RewardService(wallet, repos.rewardRules, repos.subs, repos.results)
  const timers = new TurnTimerService(redis)               // owns every deadline (04 §6)
  return {
    repos, uow, registry, wallet, rewards, timers,
    auth: new AuthService(repos.users, repos.refreshTokens, repos.guestSessions, wallet),
    tables: new TableService(repos.tables, repos.invites, uow),
    games: new GameSessionService(repos.games, repos.events, repos.snapshots,
                                  registry, timers, rewards, uow),
    matchmaking: new MatchmakingService(redis, repos.tickets, repos.cooldowns,
                                        repos.blocks, registry, uow),
    store: new StoreService(repos.store, repos.purchases, wallet, uow),
    premium: new SubscriptionService(repos.subs, wallet, paymentProvider),
    chat: new ChatService(repos.chat, redis),
    stats: new StatsService(repos.stats, uow),
  }
}
export type Container = ReturnType<typeof buildContainer>
```

Tests build the same container with `InMemory*Repository` fakes — no database, no Prisma, fast.

### 5.6 Error Taxonomy

```ts
// src/domain/errors/AppError.ts
export abstract class AppError extends Error {
  abstract readonly code: string        // stable machine code, e.g. 'ILLEGAL_MOVE'
  abstract readonly httpStatus: number
  readonly i18nKey: string              // e.g. 'errors.illegalMove' → localized client-side
  readonly details?: Record<string, unknown>
}
```

| Error | code | HTTP | Socket ack |
|---|---|---|---|
| `ValidationError` | `VALIDATION_FAILED` | 400 | `{ ok:false, code, fieldErrors }` |
| `UnauthorizedError` | `UNAUTHORIZED` | 401 | triggers client refresh attempt |
| `ForbiddenError` | `FORBIDDEN` | 403 | — |
| `NotFoundError` | `NOT_FOUND` | 404 | — |
| `SeatTakenError` | `SEAT_TAKEN` | 409 | client re-renders seat map |
| `IllegalMoveError` | `ILLEGAL_MOVE` | 422 | **audit-logged** (see security doc) |
| `NotYourTurnError` | `NOT_YOUR_TURN` | 422 | audit-logged |
| `InviteExpiredError` | `INVITE_EXPIRED` | 410 | — |
| `RateLimitError` | `RATE_LIMITED` | 429 | includes `retryAfterMs` |

A single Express error middleware and a single socket ack wrapper map `AppError → response`.
Anything that is *not* an `AppError` is logged at `error` with a request id and returned as an
opaque `INTERNAL` — never a stack trace to the client.

The admin process extends this table with six codes (`STEP_UP_REQUIRED`, `MFA_REQUIRED`,
`MFA_ENROLLMENT_REQUIRED`, `ADMIN_LOCKED`, `REASON_REQUIRED`, `SELF_TARGET_FORBIDDEN`) —
[12](./12-admin-console.md) §5.1. Same `AppError` base, same middleware.

---

## 6. Database Strategy — SQLite → PostgreSQL

### 6.1 Provider switching

```prisma
// backend/prisma/schema.prisma
datasource db {
  // Managed by backend/scripts/prisma-provider.mjs from DATABASE_PROVIDER.
  provider = "sqlite"   // "sqlite" (dev/test) | "postgresql" (prod)
  url      = env("DATABASE_URL")
}
```

> **Corrected during S04 (2026-09-08).** This section originally specified
> `provider = env("DATABASE_PROVIDER")`. **Prisma rejects that** —
> *"A datasource must not use the env() function in the provider argument"*
> (P1012). The provider must be a string literal.
>
> The intent survives without forking the schema: `DATABASE_PROVIDER` is still
> the single switch, and `backend/scripts/prisma-provider.mjs` rewrites that one
> line to match it. Every `db:*` npm script runs it first, so the schema always
> matches the environment it is about to be applied to. One canonical schema, one
> machine-managed line, and `tests/unit/schema-portability.test.ts` asserts the
> literal is always one of the supported pair.
>
> The alternative — a SQLite copy and a Postgres copy of the schema — was
> rejected: two files that would drift the first time a column is added under
> time pressure.

| Env | `DATABASE_PROVIDER` | `DATABASE_URL` |
|---|---|---|
| dev | `sqlite` | `file:./dev.db` |
| test | `sqlite` | `file:./test.db` (or `file::memory:?cache=shared`) |
| prod | `postgresql` | `postgresql://user:pass@postgres:5432/boardgames?schema=public` |

> **Open question / caveat:** Prisma allows `provider = env(...)`, but **migrations are
> provider-specific** — a `migrations/` folder generated against SQLite will not apply cleanly
> to PostgreSQL. Two viable approaches:
>
> - **(Recommended)** Keep **two migration folders**: `prisma/migrations-sqlite/` for local dev
>   and `prisma/migrations/` for Postgres, selected by `--schema`/`--migrations` flags in npm
>   scripts. Prod deploys only ever run the Postgres set.
> - Or: use `prisma db push` locally (no migration history, fine for a personal project's dev
>   loop) and generate proper migrations **only** against Postgres.
>
> The second is less machinery and is what I'd suggest for a solo project. Confirm your
> preference before `M0`.

### 6.2 Schema must target the intersection of both engines

SQLite lacks native enums, arrays, and JSON operators. Therefore, project-wide rules:

| Don't | Do |
|---|---|
| `enum GameKind { ... }` | `String` + a TS union in `contracts/` + Zod validation |
| `String[]` | Join table, or a JSON-encoded `String` |
| Postgres JSON path queries | Store `String` (JSON), parse in app code. **Never query into it** |
| `@db.Uuid` / native types | `String` `@default(cuid())` |
| `Decimal` for chips | `Int` — chips are whole units. Avoids float and cross-engine decimal differences |
| `DateTime` arithmetic in SQL | Compute in app code |

This costs a little expressiveness and buys a genuinely portable schema. Full schema:
[03-data-model.md](./03-data-model.md).

### 6.3 Connection & migration ops

- `prisma migrate deploy` runs as a **separate one-shot container** in the prod compose file,
  before the API starts — not on API boot, so a failed migration doesn't crash-loop the app.
- Postgres pool sized modestly (`connection_limit=10`); this app is socket-heavy, not
  query-heavy.
- Nightly `pg_dump` to a mounted volume; documented restore procedure.

---

## 7. REST API Surface

All routes under `/api/v1`, served on `:3000`. `Auth` column: **P**ublic · **G**uest-or-user ·
**U**ser · **H**ost-of-table.

> **There are no admin routes on this port.** The admin surface lives under `/admin/api/v1` on the
> separate, unpublished `:3100` process — catalogued in [12](./12-admin-console.md) §5. A request
> for `/admin/*` here returns **404**, asserted by a permanent integration test
> ([12](./12-admin-console.md) §2.4).

### Auth & identity

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | P | Create account (argon2id). Optional `inviteCode` → post-signup redirect target |
| POST | `/auth/login` | P | Sets `access` + `refresh` httpOnly cookies |
| POST | `/auth/refresh` | P (refresh cookie) | Rotates refresh token, issues new access token |
| POST | `/auth/logout` | G | Revokes refresh token, clears cookies |
| GET | `/auth/me` | G | Current identity — `{ kind: 'user' \| 'guest', ... }` |
| POST | `/auth/guest` | P | Issues a **table-bound** guest token for `{ inviteCode, displayName }` |
| POST | `/auth/guest/claim` | G(guest) | **The key endpoint.** Converts the current guest into a real account, preserving seat + history. Returns the table to redirect to |

### Tables & invites

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/tables` | U | Create a table for a `gameKind` with options |
| GET | `/tables/mine` | U | Tables I'm seated at or hosting (for "resume") |
| GET | `/tables/:id` | G | Table metadata + seat map (no game state — that's the socket) |
| PATCH | `/tables/:id` | H | Change options while `WAITING` |
| DELETE | `/tables/:id` | H | Close table |
| POST | `/tables/:id/invites` | H | Mint an invite link |
| DELETE | `/tables/:id/invites/:code` | H | Revoke |
| GET | `/invites/:code` | P | **Resolve an invite without auth** — returns game name, host display name, seats free, whether the game is in progress. Powers the pre-join screen |

### Games & content

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/games` | P | **Game registry** — powers the welcome page preview cards. Server-driven so a new game needs no frontend deploy |
| GET | `/games/:slug` | P | Detail: rules summary, player counts, options schema, i18n keys |

### Profile, cosmetics, stats

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/me/profile` | U | Profile |
| PATCH | `/me/profile` | U | Display name, avatar selection |
| GET | `/me/preferences` | G | Theme, locale, card back, felt, animation speed, sound |
| PUT | `/me/preferences` | G | Persist (guests → in-token/localStorage only; see frontend doc) |
| POST | `/me/avatar` | U | Upload custom avatar (validated, re-encoded, resized) |
| GET | `/cosmetics` | G | Catalog + which are unlocked for me |
| GET | `/me/stats` | U | Per-game W/L, rating, streaks |
| GET | `/me/matches` | U | Paginated match history |
| GET | `/matches/:id` | G | Match detail + replay event stream |

### Matchmaking — [09-matchmaking.md](./09-matchmaking.md)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/matchmaking/presets` | P | Queueable presets + live `humansWaiting`. Powers the queue picker and the welcome page's "N playing now" |
| GET | `/matchmaking/status` | G | My active ticket, so a page reload doesn't look like a lost queue |
| POST | `/reports` | G | Report a player from a matchmade table |
| GET/POST/DELETE | `/blocks` | U | Manage blocked identities |

> Joining and leaving the queue are **socket** events, not REST — a queue needs push updates.
> These endpoints exist for the picker and for reload survival.

### Economy — [10-economy-and-rewards.md](./10-economy-and-rewards.md)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/wallet` | G | Balances per asset + vesting status. **Guests included** |
| GET | `/wallet/transactions` | U | Paginated ledger — the player's own statement |
| GET | `/store` | G | Catalog with owned / affordable / locked flags |
| POST | `/store/purchase` | U | Buy an item. **Guests rejected** — provisional balances cannot be spent |
| GET | `/rewards/rules` | P | Public reward rates. Transparency is deliberate ([10](./10-economy-and-rewards.md) §11) |
| GET | `/achievements` | G | Definitions + my progress |
| GET | `/premium/plans` | P | Tiers and pricing |
| POST | `/premium/subscribe` | U | Start checkout (provider redirect) |
| POST | `/premium/cancel` | U | Cancel at period end |
| POST | `/premium/webhook` | — | Provider webhook. **Signature-verified**, idempotent by provider event id, exempt from the CSRF check and the global rate limit |

**Cross-cutting middleware order:** `requestId → pino-http → helmet → cors → cookieParser →
rateLimit → zodValidate → authenticate → authorize → controller → errorHandler`.

---

## 8. Internationalization & RTL

Both locales ship in v1: **English (LTR)** and **Persian / فارسی (RTL)**.

### 8.1 Mechanics

- `react-i18next` with namespaces: `common`, `auth`, `table`, `errors`, `cosmetics`, and one per
  game (`game.shelem`, `game.poker`, …). Per-game namespaces are lazy-loaded with the game bundle.
- Locale precedence: `?lng=` → user preference (DB) → `localStorage` → `navigator.language` → `en`.
- On locale change, set both `<html lang>` and `<html dir>`; a `themeStore` subscriber does this.
- **Server-side localization:** the API returns `i18nKey` + `details`, never a rendered English
  sentence. The client renders the message. This keeps error text translatable and the API
  locale-agnostic.
- Numerals: Persian-Indic digits (`۰۱۲۳`) as a **user preference**, defaulting on for `fa`. Card
  ranks and chip counts respect it; internal ids never do.
- Dates via `Intl.DateTimeFormat` with the Persian (Jalali) calendar for `fa`.
- Persian typography: `Vazirmatn` webfont, subset, `font-display: swap`, with a system fallback
  stack.

### 8.2 RTL rules (the part that actually breaks things)

1. **Logical CSS properties only.** `margin-inline-start`, not `margin-left`. `inset-inline-end`,
   not `right`. `padding-block`, not `padding-top/bottom`. Enforced by
   `stylelint-plugin-logical-css`. No RTL stylesheet, no `postcss-rtl` — modern logical
   properties make a second stylesheet unnecessary.
2. **Mirror the table, not the board.** Seat layout, hand fan direction, turn-order indicator,
   and chat panel all mirror in RTL.
3. **Do NOT mirror:**
   - **Chess** — a1 stays bottom-left for White regardless of locale. Chess coordinates are
     absolute and mirroring them would be a genuine usability bug for anyone who reads notation.
   - **Sudoku** — the grid is coordinate-addressed; row 1 col 1 stays top-left.
   - **Card faces and suit pips** — art assets, not layout.
   - Playback/media icons and the trick-taking direction arrow (clockwise is clockwise).
   These are marked with a `dir="ltr"` island so they are immune to the ambient direction.
4. **Directional icons** (back, next, undo) come from a paired set selected by `dir`.
5. Every game's screen must be visually reviewed in `fa` before its milestone is called done —
   listed as an exit criterion in [08-roadmap.md](./08-roadmap.md).

---

## 9. Deployment

### 9.1 Dev

```bash
# terminal 1
cd backend  && npm run dev          # tsx watch, SQLite, in-memory socket adapter    :3000
# terminal 2
cd frontend && npm run dev          # vite, proxies /api and /socket.io to :3000     :5173
# terminal 3 — admin backend (from M0's skeleton onward)
cd backend  && npm run dev:admin    # tsx watch, admin routers only, 127.0.0.1       :3100
# terminal 4 — admin frontend (from MA)
cd admin-frontend && npm run dev    # vite, proxies /admin/api to :3100              :5273
```
Redis optional locally; `REDIS_URL` unset → in-memory adapter + in-process rate limiter, and
`CONTROL_TRANSPORT=poll` so admin control commands still land via the outbox sweep
([12](./12-admin-console.md) §6.3).

### 9.2 Prod — Docker Compose on a VPS

```mermaid
graph LR
    Net(("Internet")) --> CAD["Caddy<br/>TLS, reverse proxy"]
    CAD -->|"app.example.com /"| WEB["web<br/>nginx serving Vite build"]
    CAD -->|"app.example.com /api, /socket.io"| API["api<br/>Node 22  :3000"]
    CAD -->|"admin.example.com /"| AWEB["admin-web<br/>nginx serving admin build"]
    CAD -->|"admin.example.com /admin/api"| AAPI["admin-api<br/>Node 22  :3100<br/>NOT published"]
    API --> PG[("postgres:16")]
    AAPI --> PG
    API --> RDS[("redis:7")]
    AAPI --> RDS
    MIG["migrate (one-shot)"] -.->|"runs before api"| PG
    PG --> BK["nightly pg_dump<br/>→ volume"]
```

Services: `caddy` (auto-TLS via Let's Encrypt), `web`, `api`, **`admin-web`**, **`admin-api`**,
`postgres`, `redis`, `migrate` (one-shot, `depends_on: postgres: service_healthy`).

Notes that matter:
- **`admin-api` has no `ports:` entry.** It is reachable only over the Docker network, only from
  Caddy, only on the admin hostname — optionally behind `ADMIN_IP_ALLOWLIST`. `docker ps` showing
  a published `:3100` is a deployment bug ([12](./12-admin-console.md) §2.1).
- **SSE needs `flush_interval -1`** in the `admin.example.com` reverse-proxy block, or the live
  feed buffers and looks broken.
- `api` and `admin-api` run the **same image** with a different command — one build, two processes.
- **WebSocket proxying:** Caddy handles `Upgrade` transparently; no special config beyond
  `reverse_proxy api:3000`. (Called out because this is the #1 first-deploy failure for
  socket apps behind a proxy.)
- **Sticky sessions:** single API container in v1, so not needed. If you ever scale to >1
  replica, the Redis adapter handles cross-node broadcast but you *also* need
  `ip_hash`-style stickiness for the Socket.IO HTTP long-poll handshake — noted here so
  future-you doesn't lose an evening to it.
- Multi-stage Dockerfiles; `node:22-alpine` runtime; non-root user; healthchecks on all
  services.
- Secrets from a `.env` file on the VPS (not in the image, not in git). `.env.example` committed.
- Backups: nightly `pg_dump` + weekly off-box copy. Restore procedure documented and **tested
  once** before you rely on it.

### 9.3 CI (GitHub Actions)

Three workflows, one per project, each: install → `contracts:check` → typecheck → lint → test →
build. Frontend additionally runs Playwright against a compose-spun-up stack on PRs to `main`;
admin-frontend runs its own smaller Playwright suite (login + MFA, disable a user, adjust a
wallet).

---

## 10. Testing Strategy

| Layer | Tool | What | Target |
|---|---|---|---|
| **Game engines** | Vitest | Pure-function rules: legality, scoring, edge cases, full-hand replays from fixtures. **The most important tests in the project** | ≥90% branch coverage on `domain/games/**` |
| Domain services | Vitest + in-memory fakes | Use-case orchestration, guest-claim transaction, seat races | ≥80% |
| REST | Supertest | Status codes, auth guards, validation rejection, cookie behavior | all routes |
| Socket | Vitest + 2× `socket.io-client` | Join/move/broadcast, **projection leakage assertions**, reconnect resync, illegal-move rejection | all events |
| **Anti-cheat** | Vitest | Dedicated suite asserting a projected payload for seat A contains **no** trace of seat B's hidden cards, per game | 100% of games |
| **Economy** | Vitest | Ledger invariants: idempotent credits, balance == Σ transactions, row-locked debits, **ejected-winner earns zero while their partner earns full**, caps, guest vesting inside the claim transaction | 100% of ledger paths |
| **Matchmaking** | Vitest + fake Redis | Match formation, **timeout release**, bot fill, party atomicity, expiry-before-match ordering, farming guards, cooldowns | all documented cases |
| **Turn enforcement** | Vitest | Strike escalation, warning emission, ejection, bot substitution, reclaim window, per-game default actions | all games |
| **Admin** | Vitest + Supertest | **Public-port isolation** (`:3000/admin/*` → 404), audit-completeness over the route manifest, RBAC matrix, step-up expiry, TOTP replay, reason enforcement, **admin live-table leak test**, control-command durability and idempotency, audit-chain verification | [12](./12-admin-console.md) §10 — all 15 |
| E2E | Playwright | invite → guest join → play → signup nudge → claim → land back at table with seat intact **and coins vested**; queue → timeout → release → play with bots; go idle → warned → ejected → zero reward | the 5 headline journeys |

**Determinism:** every engine takes an injected RNG. Tests inject a seeded generator, so any
bug reported as "this Shelem hand scored wrong" is reproducible from `(seed, moves[])`. A
`replayFixture(seed, moves)` helper is part of the test kit from M0.

---

## 11. Observability

- **Pino** structured logs; every log line carries `requestId` (REST) or `socketId` + `tableId`
  + `gameId` (socket). `tokens`, `cookie`, `authorization`, and `password` are redacted at the
  logger level, not by convention.
- **Audit log** (`GameEvent` with `kind: 'AUDIT'` + a `SecurityEvent` table): every rejected
  move, invalid token, rate-limit trip, and seat-impersonation attempt. This is how you'd
  actually catch a friend poking at the API.
- `/health` (liveness) and `/ready` (DB + Redis reachable) endpoints for compose healthchecks.
- Lightweight in-process metrics counters (games started/finished, illegal moves, active sockets,
  reconnects) — enough to spot trouble without running Prometheus. They are **read through the
  admin process**, not from a `/metrics` route on the public port
  ([12](./12-admin-console.md) §5, §7.4).
- **`AdminAuditLog`** is the second audit trail, and it covers the operator rather than the
  players: append-only, hash-chained, written in the same transaction as the action it records
  ([12](./12-admin-console.md) §3.5).

---

## 12. Non-Functional Targets

| Attribute | Target | Rationale |
|---|---|---|
| Move round-trip (p95) | < 150 ms same-region | Card games feel laggy above ~200 ms |
| Concurrent tables | 50 tables / 200 sockets on one small VPS | Comfortably above "me and my friends" |
| Reconnect resync | < 2 s to fully playable | Mobile networks drop constantly |
| Time from link click to seated | < 5 s (guest, no signup) | The core product promise (P6) |
| Cold page load (p95) | < 2.5 s on 4G | Route + per-game code splitting |
| Recovery | Restart with zero lost in-progress games | Event log + snapshots make this achievable |

---

## Related Documents

| Document | Covers |
|---|---|
| [01-business-prd.md](./01-business-prd.md) | Why, for whom, what ships when |
| [03-data-model.md](./03-data-model.md) | Prisma schema, ERD, event sourcing, guest-claim migration |
| [04-realtime-protocol.md](./04-realtime-protocol.md) | Socket event catalog, projection, reconnection |
| [05-game-engine-spec.md](./05-game-engine-spec.md) | The `GameEngine` interface every game implements |
| [06-frontend-architecture.md](./06-frontend-architecture.md) | Vite/React/Zustand/Axios, theming, customization page |
| [07-security-and-anticheat.md](./07-security-and-anticheat.md) | Threat model and defenses |
| [08-roadmap.md](./08-roadmap.md) | Milestones M0–M8 + MA with exit criteria |
| [09-matchmaking.md](./09-matchmaking.md) | Queue, presets, timeout, farming guards |
| [10-economy-and-rewards.md](./10-economy-and-rewards.md) | Wallet, ledger, rewards, store, premium |
| [12-admin-console.md](./12-admin-console.md) | The admin entrypoint, `admin-frontend/`, moderation, economy oversight, game on/off, reports, audit |
| [games/](./games/) | Per-game implementation specs |
