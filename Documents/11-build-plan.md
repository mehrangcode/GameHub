# Build Plan — Session by Session

> **Status:** Draft · **Sits below:** [08-roadmap.md](./08-roadmap.md) · **Session size:** 2–3 focused hours

[08-roadmap.md](./08-roadmap.md) says *what ships in which milestone* and is sized in weeks. This
document says *what we build today*, sized in single evenings. It adds nothing to scope — it only
slices M0–M8 and MA into numbered sessions that each end with something **you can verify yourself**.

If this document and [08-roadmap.md](./08-roadmap.md) disagree on scope, the roadmap wins and this
document should be corrected. If either disagrees with
[02-technical-prd.md](./02-technical-prd.md), the technical PRD wins.

---

## 0. How We Work

### The daily loop

| Step | Who | What |
|---|---|---|
| 1 | Claude | Read `.claude/context/build/context.md` — the live cursor: last session, current session, open decisions, blockers |
| 2 | Claude | State the session id, its goal, and its **You verify** steps *before* writing code, so you know what you're getting |
| 3 | Claude | Build it. Tests written **with** the code, not after |
| 4 | Claude | Run the suite. Report real output — a failing test is reported as failing, never narrated as passing |
| 5 | **You** | Run the **You verify** steps yourself. This is the gate: a session is not done until you have seen it work |
| 6 | Claude | Tick the session's boxes here, update `context.md`, and hand you a conventional commit message |
| 7 | **You** | Commit. Claude never commits on your behalf |

### Session anatomy

Every session below has the same six fields:

| Field | Meaning |
|---|---|
| **Goal** | One sentence. If we can't state it in one sentence, the session is too big |
| **Needs** | Session ids that must be done first |
| **Build** | The concrete deliverables — files, endpoints, functions |
| **Tests** | Exactly which tests get written. These must pass before the session ends |
| **You verify** | The commands you type or the clicks you make to see it working with your own eyes |
| **Done when** | The checklist. All boxes ticked = session complete |

### Verification types

Not every session can be checked in a browser — the first ten sessions have no UI yet. Each session
is tagged so you know what kind of checking to expect:

| Tag | What you do | Honest caveat |
|---|---|---|
| 🖥️ **CLI** | Run a command, read its output | Fastest, least satisfying |
| 🌐 **HTTP** | Send requests with `curl`, Bruno, Postman, or a `.http` file | We keep `backend/requests/*.http` updated so these are click-to-run, not retyped each time |
| 🔌 **Socket** | Run `backend/scripts/dev-socket.ts`, a tiny CLI socket client | Built in S23; before then, sockets don't exist |
| 🖱️ **Browser** | Open `localhost:5173`, click | Real product feel. Available from S39 onward, and for a few earlier sessions |
| 🧪 **Tests only** | `npx vitest run <file>` and read the assertions | Used only where there is genuinely nothing to look at (pure functions, race conditions). Flagged honestly rather than dressed up |

### Two ground rules

1. **A session ends green or it ends unfinished.** Never "mostly working, I'll fix it tomorrow" —
   that is how a 200-session plan rots. If a session can't finish, we shrink it and re-plan the
   remainder as a new session rather than carrying broken code forward.
2. **Never start a session with the previous one at 80%.** Same rule
   [08-roadmap.md](./08-roadmap.md) applies to games, applied to sessions.

### Total shape, honestly

| Milestone | Sessions | At 5 sessions/week |
|---|---|---|
| **M0** Platform skeleton | **50** (specified in full below) | ~10 weeks |
| M1 Sudoku | ~11 (outline) | ~2 weeks |
| M2 Blackjack | ~15 (outline) | ~3 weeks |
| M3 Matchmaking | ~17 (outline) | ~3.5 weeks |
| M4 Shelem | ~26 (outline) | ~5 weeks |
| M5 Poker | ~21 (outline) | ~4 weeks |
| M6 Chess | ~13 (outline) | ~2.5 weeks |
| M7 Store & Premium | ~21 (outline) | ~4 weeks |
| **MA Admin console** | **~16** (outline) | **~3 weeks** |
| M8 Social & stats | ~21 (outline) | ~4 weeks |
| **Total** | **~211** | **~41 weeks** |

Only M0 is specified session-by-session. M1–M8 and MA are outlines (§14) and get expanded into full
sessions when we reach them — detailing M4 today would be fiction, because what M1–M3 teach us
about the engine pipeline will change it.

**MA sits between M7 and M8**, and the admin backend it fronts grows in three earlier slices: Phase
L in M0 (S48–S50), one session in M2, one in M3. The reasoning is in §1.2 and
[12-admin-console.md](./12-admin-console.md) §11.

---

## 1. Two Deliberate Additions to M0 Scope

### 1.1 The `_fixture` engine

[08-roadmap.md](./08-roadmap.md) M0 has this exit criterion:

> *An idle player is warned, struck twice, ejected, and replaced by a bot — the table plays on*

That cannot be tested without **a game**, and the first real engine (Sudoku) is M1. So M0 needs a
throwaway one:

**`backend/src/domain/games/_fixture/`** — a deliberately trivial engine (`fixture` slug: seats
take turns pressing one button; state is a counter; a bot presses it too). It exists to exercise the
event log, projection, turn timers, ejection, and reward settlement before a real game exists.

Rules for it, so it never becomes technical debt:

- It implements the full `GameEngine` interface and obeys **all five invariants** — it is the first
  proof the interface works, and building it is how we discover interface problems while they're
  still cheap to fix.
- It is registered **only** when `NODE_ENV !== 'production'`, asserted by a test.
- Its `projectState` hides one field so the leak-test harness has something real to catch.
- It is **not** deleted at M1. It stays forever as the interface's regression fixture and the
  reference implementation new games are copied from.

It is a means to that document's own exit criteria rather than new product scope.

### 1.2 The admin spine (Phase L, S48–S50)

[12-admin-console.md](./12-admin-console.md) §11.1 puts a **backend-only** admin slice in M0: the
separate entrypoint, admin auth with TOTP, and the `withAudit` transaction wrapper. No UI — that is
milestone MA.

The reason it cannot wait:

- **A3 — no admin mutation without an audit row in the same transaction — is an architectural rule,
  not a feature.** Adding it after twenty admin endpoints exist means reopening all twenty. Adding
  it when there is one read endpoint costs an afternoon.
- **The public-port isolation guard has to exist before the first `/admin` route is written**, or
  the natural thing to do is mount it on `:3000` and add a role check — which is precisely the
  arrangement [12](./12-admin-console.md) §2.4 exists to prevent. S15 is already amended for this.
- **`User.status` touches the auth path and the seat model**, both of which are M0 code. Retrofitting
  a status check into `authenticate` after five games ship is a migration plus five regression risks.

Everything genuinely optional — the console UI, moderation actions, the ledger browser, reports —
is deferred to M2, M3, and MA.

---

## 2. M0 Progress at a Glance

Tick the box when **you** have verified the session, not when the code compiles.

| # | Session | h | Verify | Done |
|---|---|---|---|---|
| | **Phase A — Foundations** | | | |
| S01 | Backend scaffold, TS strict, the three load-bearing lint rules | 3 | 🖥️ | ☐ |
| S02 | Frontend scaffold, Vite proxy, route stubs | 2 | 🖱️ | ☐ |
| S03 | `contracts/` + `contracts:sync` / `contracts:check` | 2 | 🖥️ | ☐ |
| S04 | Prisma schema I — identity, tables, seats, invites | 3 | 🖥️ | ☐ |
| S05 | Prisma schema II — games, chat, results, cosmetics, economy | 3 | 🖥️ | ☐ |
| S06 | Idempotent seed script | 2.5 | 🖥️ | ☐ |
| | **Phase B — Domain & persistence** | | | |
| S07 | Value objects, entities, `AppError` taxonomy | 2.5 | 🧪 | ☐ |
| S08 | Repository interfaces + in-memory fakes | 2.5 | 🧪 | ☐ |
| S09 | Prisma repositories + `UnitOfWork` | 3 | 🧪 | ☐ |
| S10 | `container.ts`, `app.ts`, Pino redaction, `/health` + `/ready` | 2.5 | 🌐 | ☐ |
| | **Phase C — Auth** | | | |
| S11 | argon2id + JWT + cookie helpers | 2.5 | 🧪 | ☐ |
| S12 | Zod validation, error middleware, helmet, CORS, rate limit | 2.5 | 🌐 | ☐ |
| S13 | `POST /auth/register`, `/auth/login`, `GET /auth/me` | 3 | 🌐 | ☐ |
| S14 | Refresh rotation with family revocation + `/auth/logout` | 3 | 🌐 | ☐ |
| S15 | `SecurityEvent` audit log + metrics registry (no HTTP route — see S49) | 2 | 🌐 | ☐ |
| S16 | Table-bound guest tokens — `POST /auth/guest` | 3 | 🌐 | ☐ |
| | **Phase D — Tables & invites** | | | |
| S17 | Game registry + `GET /games`, `/games/:slug` | 2 | 🌐 | ☐ |
| S18 | Table CRUD — create, mine, detail, patch, close | 3 | 🌐 | ☐ |
| S19 | Invites — mint, revoke, `GET /invites/:code` unauthenticated | 2.5 | 🌐 | ☐ |
| S20 | Seat claim/release, race-safe by unique constraint | 3 | 🧪 | ☐ |
| | **Phase E — Wallet & the claim transaction** | | | |
| S21 | Wallet credit path — derived idempotency, caps, `CAP_REJECTED` | 3 | 🧪 | ☐ |
| S22 | ⭐ Guest→user claim transaction, all 12 steps | 3 | 🌐 | ☐ |
| | **Phase F — Sockets** | | | |
| S23 | Socket.IO gateway, handshake identity, `dev-socket.ts` | 3 | 🔌 | ☐ |
| S24 | Room model, `table:join`, `table:snapshot`, seat broadcast | 3 | 🔌 | ☐ |
| S25 | Presence, heartbeat, disconnect grace | 2.5 | 🔌 | ☐ |
| S26 | Chat + emotes, rate-limited, SYSTEM messages as i18n keys | 2.5 | 🔌 | ☐ |
| S27 | Redis adapter, presence sets, sliding-window limits, fallback | 2.5 | 🖥️ | ☐ |
| | **Phase G — Event log** | | | |
| S28 | `GameInstance` + seed commitment + `GameEvent` append with `seq` | 3 | 🧪 | ☐ |
| S29 | Snapshot policy, `rebuildState`, delta/full resync | 3 | 🔌 | ☐ |
| S30 | The `_fixture` engine + `GameSessionService` move pipeline | 3 | 🔌 | ☐ |
| | **Phase H — Turn enforcement** | | | |
| S31 | `TurnTimerService` — absolute deadlines, `game:turnTimer` | 3 | 🔌 | ☐ |
| S32 | Warning, strike ladder, default action, `strikesResetOnAction` | 3 | 🔌 | ☐ |
| S33 | Ejection + bot substitution | 3 | 🔌 | ☐ |
| S34 | Seat reclamation + timer re-arming on restart | 2.5 | 🔌 | ☐ |
| | **Phase I — Rewards** | | | |
| S35 | `RewardService.compute` — the pure policy function | 2.5 | 🧪 | ☐ |
| S36 | ⭐ Settlement transaction — per-seat, idempotent, forfeiture | 3 | 🧪 | ☐ |
| S37 | `GET /wallet`, `/wallet/transactions`, `wallet:updated` | 2.5 | 🌐 | ☐ |
| S38 | Debit path with row lock, `GUEST_FORFEIT`, nightly reconciliation | 3 | 🧪 | ☐ |
| | **Phase J — Frontend** | | | |
| S39 | Axios instance, single-flight refresh, `authStore`, login/register | 3 | 🖱️ | ☐ |
| S40 | `tokens.css`, `themeStore`, i18n en+fa, `dir` switching | 3 | 🖱️ | ☐ |
| S41 | Welcome page — registry-driven preview cards | 2.5 | 🖱️ | ☐ |
| S42 | `socketStore` + socket manager + `seq` gap detection | 3 | 🖱️ | ☐ |
| S43 | ⭐ Invite landing → guest join, the highest-stakes screen | 3 | 🖱️ | ☐ |
| S44 | `TableShell` — seats, presence, chat, countdown ring, nudge | 3 | 🖱️ | ☐ |
| | **Phase K — Ship** | | | |
| S45 | Dockerfiles + dev compose + CI for both projects | 3 | 🖥️ | ☐ |
| S46 | Prod compose, Caddy, Postgres migration, VPS deploy | 3 | 🌐 | ☐ |
| S47 | ⭐ M0 exit-criteria walkthrough + tested backup restore | 3 | 🖱️ | ☐ |
| | **Phase L — Admin spine** ([12](./12-admin-console.md) §11.1) | | | |
| S48 | Admin schema + `admin-main.ts` + the three isolation guards | 3 | 🖥️ | ☐ |
| S49 | Admin auth: TOTP, forced enrollment, step-up, sessions | 3 | 🌐 | ☐ |
| S50 | ⭐ The `withAudit` spine + first read endpoints + admin exit criteria | 3 | 🌐 | ☐ |

⭐ = a session where something genuinely hard happens. Expect these to run long; don't schedule them
on a tired evening.

**50 sessions ≈ 141 hours.** Phase L is last within M0 because it depends on auth (S11–S16), the
wallet (S21), and a deployed environment (S46) to be verifiable — but it is inside M0, not deferred,
because the audit-in-transaction rule cannot be retrofitted (see §1).

---

## 3. Phase A — Foundations (S01–S06)

### S01 — Backend scaffold and the three load-bearing lint rules · 3 h · 🖥️

**Goal:** `npm run dev` starts a typed Express 5 server, and the lint rules that protect the
architecture are proven to actually fire.

**Needs:** —

**Build**
- `backend/package.json`: Node 22, ESM, scripts `dev` (tsx watch), `build`, `start`, `test`,
  `typecheck`, `lint`, `format`
- `tsconfig.json`: `strict: true`, **`noUncheckedIndexedAccess: true`** (card arrays are indexed
  constantly — [02](./02-technical-prd.md) §2.1)
- Full empty folder skeleton per [02](./02-technical-prd.md) §4: `contracts/`, `domain/`,
  `application/`, `infrastructure/`, `interface/`, `config/`, `tests/{unit,integration,fakes}`
- ESLint with the three rules that matter (a fourth, the admin-import ban, arrives in S48 when
  there is an `interface/admin/` to ban):
  1. `no-restricted-imports` — `domain/**` and `application/**` may not import
     `**/infrastructure/**` or `@prisma/client` ([02](./02-technical-prd.md) §5.1)
  2. `no-restricted-syntax` — `Math.random` banned anywhere in `domain/**`
     ([05](./05-game-engine-spec.md) §3)
  3. `domain/games/**` additionally may not import `application/**` or anything matching
     `wallet|reward|matchmaking` — the E5 chips≠coins guard
     ([05](./05-game-engine-spec.md) §2.1)
- `config/env.ts` — Zod-validated env, **parsed at startup, process exits on failure** (P7)
- Prettier, `.editorconfig`, Vitest config
- `app.ts` + `server.ts` with a single `GET /health` returning `{ ok: true, version }`

**Tests**
- `tests/unit/config/env.test.ts` — a missing required var throws; a malformed `PORT` throws
- `tests/integration/health.test.ts` — Supertest `GET /health` → 200
- `tests/unit/lint-guards.test.ts` — asserts the ESLint config *contains* the three rules, so
  nobody silently deletes them later

**You verify**
```bash
cd backend && npm install && npm run dev      # then, in another terminal:
curl -s localhost:3000/health                  # → {"ok":true,...}
npm run typecheck && npm run lint && npm test  # all green

# now prove the guards bite — these MUST fail:
echo "import {PrismaClient} from '@prisma/client'" > src/domain/_probe.ts && npm run lint
echo "export const x = Math.random()" > src/domain/games/_probe.ts && npm run lint
rm src/domain/_probe.ts src/domain/games/_probe.ts
```

**Done when**
- [ ] `npm run dev` serves `/health`
- [ ] `typecheck`, `lint`, `test` all green
- [ ] **Both deliberate violations above are rejected by lint** — the single most important
      outcome of this session (S48 repeats the exercise for the admin-import rule)
- [ ] Deleting a required env var makes the server exit at startup with a readable message

---

### S02 — Frontend scaffold, Vite proxy, route stubs · 2 h · 🖱️

**Goal:** a React app on `:5173` that proxies to the backend same-origin, with every route from
[06](./06-frontend-architecture.md) §2 reachable as a placeholder.

**Needs:** S01

**Build**
- `npm create vite@latest frontend -- --template react-ts`, React 19, TS strict
- `vite.config.ts` exactly per [06](./06-frontend-architecture.md) §1 — `@` alias, and the proxy
  with **`ws: true` on `/socket.io`** (without it, sockets fail in dev only, which is a miserable
  bug to find later)
- React Router 7 data router, all 13 routes as `<h1>` placeholders
- Folder skeleton: `api/`, `socket/`, `stores/`, `routes/`, `features/`, `components/`, `i18n/`,
  `styles/`, `contracts/`
- ESLint + Prettier + Vitest + React Testing Library; Playwright installed, one smoke spec
- Stylelint with `stylelint-plugin-logical-css` — configured now so no non-logical property is
  ever written ([02](./02-technical-prd.md) §8.2)

**Tests**
- `tests/routes.test.tsx` — every route path renders without throwing
- `e2e/smoke.spec.ts` — Playwright loads `/` and finds the placeholder heading
- A stylelint guard test asserting the logical-CSS plugin is enabled

**You verify**
```bash
cd frontend && npm install && npm run dev
```
Open `localhost:5173` and click through `/`, `/login`, `/register`, `/play`, `/customize`,
`/store`, `/wallet`, `/premium`, `/profile`, `/t/abc`, `/table/abc`, `/games/x`, `/nope` — the last
shows the 404 page. Then, with the backend running, open the browser console and run
`await fetch('/api/v1/health').then(r=>r.json())` → the proxy answers, **no CORS error**.

**Done when**
- [ ] All 13 routes render
- [ ] The `/api` proxy works from the browser with no CORS error (this is what makes httpOnly
      cookies behave identically in dev and prod)
- [ ] `npm run lint`, `test`, and `npx playwright test` green
- [ ] Writing `margin-left` in a `.module.css` file is rejected by stylelint

---

### S03 — `contracts/` and the drift guard · 2 h · 🖥️

**Goal:** the mechanism from [02](./02-technical-prd.md) §4.1 works, and a hand-edited mirror fails
the build.

**Needs:** S01, S02

**Build**
- `backend/src/contracts/`: `index.ts`, `events.ts` (empty `ServerToClientEvents` /
  `ClientToServerEvents` maps), `dto/`, and the shared TS unions that replace Prisma enums
  (`TableStatus`, `GameEventKind`, `AssetCode`, `TransactionKind`, `SeatOutcome`, …
  [03](./03-data-model.md) §1 rule 1)
- `backend/scripts/sync-contracts.ts` — copies the directory to `frontend/src/contracts/`, stamps
  every file with `// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT`, writes
  `contracts.hash` (SHA-256 of contents)
- `contracts:sync` (backend) and `contracts:check` (both) npm scripts; check **exits non-zero** on
  mismatch
- A `pre-commit` hook running `contracts:check` in both projects
- A guard test asserting `contracts/**` imports nothing Node-only (`fs`, `crypto`, `path`) — that
  restriction is what keeps the directory publishable as a package later

**Tests**
- `tests/unit/contracts-purity.test.ts` — no Node-only import, no runtime logic (types, Zod
  schemas, and `const` only)
- `tests/integration/contracts-sync.test.ts` — sync then check passes; mutate the mirror, check
  fails with a non-zero exit

**You verify**
```bash
cd backend && npm run contracts:sync && npm run contracts:check   # → exit 0
echo "// tampered" >> ../frontend/src/contracts/index.ts
npm run contracts:check                                            # → exit 1, names the file
cd ../frontend && npm run contracts:check                          # → exit 1 here too
cd ../backend && npm run contracts:sync                            # → back to green
```

**Done when**
- [ ] A tampered mirror fails `contracts:check` in **both** projects with a message naming the file
- [ ] `contracts:sync` restores green
- [ ] The pre-commit hook blocks a commit with drifted contracts
- [ ] `frontend/src/contracts/*` all carry the DO-NOT-EDIT header

---

### S04 — Prisma schema I: identity, tables, seats, invites · 3 h · 🖥️

**Goal:** the identity and table half of [03](./03-data-model.md) exists in SQLite, with the three
load-bearing unique constraints proven.

**Needs:** S01

**Build**
- `prisma/schema.prisma` with `provider = env("DATABASE_PROVIDER")` ([02](./02-technical-prd.md)
  §6.1)
- Models from [03](./03-data-model.md) §3.1–3.2: `User`, `RefreshToken`, `GuestSession`, `Table`,
  `TableMember`, `Invite`
- Every design rule from [03](./03-data-model.md) §1 obeyed: no `enum`, no scalar list, JSON as
  `String`, `Int` for money, `cuid()` ids, soft-delete via nullable `*At`
- `infrastructure/prisma/client.ts` — singleton, query logging in dev
- `.env.example` + `.env` for dev (`DATABASE_PROVIDER=sqlite`, `DATABASE_URL=file:./dev.db`)
- `npm run db:push`, `npm run db:studio` scripts

**Tests**
- `tests/integration/schema-constraints.test.ts` — the constraint suite:
  - two `TableMember` rows with the same `(tableId, seat)` → unique violation
    ([03](./03-data-model.md) §3.2, the seat-race fix)
  - the same `userId` twice at one table → violation
  - the same `guestSessionId` twice at one table → violation
  - **two spectators (`seat = null`) coexist fine** — the documented NULL-distinctness behaviour we
    depend on being identical in SQLite and Postgres
  - `GuestSession.tableId` is non-nullable (the privilege-escalation guard)
- `tests/unit/schema-portability.test.ts` — parse `schema.prisma` as text and assert it contains no
  `enum `, no `[]` scalar list, no `Decimal`, no `@db.`

**You verify**
```bash
cd backend && npm run db:push && npm run db:studio
```
Studio opens on `:5555` — confirm `User`, `RefreshToken`, `GuestSession`, `Table`, `TableMember`,
`Invite` are all there with the expected columns. Then `npx vitest run tests/integration/schema-constraints.test.ts`
and read the assertions — the seat-race one is the one to look at.

**Done when**
- [ ] `db:push` succeeds against a fresh `dev.db`
- [ ] All six models visible in Studio
- [ ] The constraint suite passes, including two coexisting spectators
- [ ] The portability test passes — no engine-specific construct anywhere in the schema

---

### S05 — Prisma schema II: games, chat, results, cosmetics, economy · 3 h · 🖥️

**Goal:** the rest of [03](./03-data-model.md) §3, so no future session needs a migration for a
column that was already specified.

**Needs:** S04

**Build**
- §3.3 `GameInstance`, `GameEvent`, `GameSnapshot` — including **`@@unique([gameId, seq])`** and
  **`@@unique([gameId, clientMoveId])`** (the DB-enforced move idempotency)
- §3.4 `ChatMessage` · §3.5 `MatchResult`, `MatchParticipant`, `PlayerStats`, `Rating`,
  `RatingChange` · §3.6 `CosmeticItem`, `UserCosmetic`, `UserPreferences` · §3.7 `SecurityEvent`
- §3.8 `MatchmakingTicket`, `MatchmakingCooldown`, `Block`
- §3.9 `Wallet`, `WalletTransaction`, `RewardRule` — including
  **`@@unique([walletId, idempotencyKey])`**, the constraint the whole economy rests on
- §3.10 `StoreItem`, `Purchase`, `Subscription`, `SubscriptionEvent`, `Achievement`,
  `UserAchievement` — including `SubscriptionEvent.providerEventId @unique`

> Building all of these now — months before the store or matchmaking is implemented — is
> deliberate. [08-roadmap.md](./08-roadmap.md) M0 says "full Prisma schema", and the reason is that
> retrofitting the wallet's holder columns after five games depend on `GameEvent`'s actor columns is
> exactly the migration [03](./03-data-model.md) §6.1 warns about.

**Tests**
- Extend `schema-constraints.test.ts`:
  - duplicate `(gameId, seq)` → violation
  - duplicate `(gameId, clientMoveId)` → violation (**the idempotency mechanism**)
  - duplicate `(walletId, idempotencyKey)` → violation (**E2**)
  - duplicate `SubscriptionEvent.providerEventId` → violation
  - `Wallet` unique per `(userId, assetCode)` and per `(guestSessionId, assetCode)`
- Re-run the portability text test over the now-complete schema
- `tests/unit/schema-money-types.test.ts` — every money-ish field (`amount`, `balance`,
  `priceAmount`, `coinsAwarded`, `score`, `pricePaid`, `baseAmount`, `cap*`) is `Int`; the **only**
  `Float` in the whole schema is `MatchParticipant.playedFraction`
  ([03](./03-data-model.md) §1 rule 4)

**You verify**
```bash
cd backend && npm run db:push && npm run db:studio     # all ~28 models present
npx vitest run tests/integration/schema-constraints.test.ts tests/unit/schema-money-types.test.ts
```

**Done when**
- [ ] Every model from [03](./03-data-model.md) §3 exists
- [ ] All four idempotency/ordering constraints proven by a failing insert
- [ ] No `Float` anywhere except `playedFraction`
- [ ] Portability test still green

---

### S06 — Idempotent seed script · 2.5 h · 🖥️

**Goal:** `npm run seed` gives a database you can actually develop against, and running it twice
changes nothing.

**Needs:** S05

**Build**
`prisma/seed.ts` per [03](./03-data-model.md) §7 — **all `upsert` on stable ids**, never `create`:
- `CosmeticItem` — card backs (classic, Persian tile, minimal), avatar presets, felts (green, blue,
  burgundy, charcoal), card faces (classic + Persian)
- `StoreItem` — prices per [10](./10-economy-and-rewards.md) §4.1 bands
- `RewardRule` — one row per game slug plus `_global` carrying the caps. Base rates from
  [10](./10-economy-and-rewards.md) §3.2 (Shelem 80, Poker 60, Chess 30/50, Blackjack 25,
  Sudoku 10/20); placement multipliers §3.3; caps §3.7. **This is the economy's tuning surface**
- `Achievement` — the initial milestone set
- Admin `User` from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, with a funded wallet
- Dev-only: a demo table per game, and **finished matches with mixed `SeatOutcome` including an
  ejected winner** — so the forfeiture path is visible in Studio from day one without waiting for
  someone to go AFK
- `npm run db:reset` = drop + push + seed

**Tests**
- `tests/integration/seed.test.ts` — run seed twice; row counts identical, no throw
- Every seeded `RewardRule.placementJson` parses and covers ranks 1..seatCount for each declared
  seat count
- The dev demo data contains **at least one `MatchParticipant` with `outcome: 'EJECTED_TIMEOUT'`
  and `rewardForfeited: true` on a winning team** — the fixture every later reward session leans on
- Seeding with `NODE_ENV=production` creates catalog rows but **no** demo tables or matches

**You verify**
```bash
cd backend && npm run db:reset && npm run seed && npm run db:studio
```
In Studio: `RewardRule` has a `shelem` row with `baseAmount` 80 and a `_global` row with the caps;
`MatchParticipant` contains a row with `outcome = EJECTED_TIMEOUT`, `rewardForfeited = true`,
`coinsAwarded = 0` **whose team won**. Then run `npm run seed` again and confirm the counts in
Studio are unchanged.

**Done when**
- [ ] Seed is idempotent — proven by running it twice
- [ ] The ejected-winner fixture exists and is visible in Studio
- [ ] Reward rates match [10](./10-economy-and-rewards.md) §3.2–3.7 exactly
- [ ] `NODE_ENV=production` seeds catalog only

---

## 4. Phase B — Domain & Persistence (S07–S10)

### S07 — Value objects, entities, `AppError` taxonomy · 2.5 h · 🧪

**Goal:** the domain vocabulary exists and every error in
[02](./02-technical-prd.md) §5.6 maps to the right HTTP status and socket ack.

**Needs:** S01

**Build**
- `domain/value-objects/`: `Card` (the `` `${Rank}${Suit}` `` string type from
  [05](./05-game-engine-spec.md) §4.1), `SUITS`, `RANKS`, `rankOf`, `suitOf`, `cardValue`, `SeatId`,
  `ChipAmount`, `HolderKey`
- `domain/entities/`: plain typed shapes for `User`, `GuestSession`, `Table`, `TableMember`,
  `Invite`, `GameInstance` — **domain types, not Prisma types**, which is what keeps the lint
  boundary meaningful
- `domain/errors/`: abstract `AppError` (`code`, `httpStatus`, `i18nKey`, `details`) and all nine
  subclasses from [02](./02-technical-prd.md) §5.6, plus `IllegalPhaseTransitionError` and
  `InsufficientFundsError`
- `domain/games/shared/rng.ts`: the `Rng` interface, `createSecureRng()` (wrapping
  `crypto.randomInt`), `createSeededRng(seed)` (xoshiro128\*\*), and `shuffle()` — Fisher–Yates over
  `rng.int(i+1)`, exactly as [05](./05-game-engine-spec.md) §3 specifies

**Tests**
- `tests/unit/errors.test.ts` — a table-driven test asserting each error's `code`, `httpStatus`, and
  `i18nKey` match [02](./02-technical-prd.md) §5.6 row for row
- `tests/unit/rng.test.ts`:
  - `createSeededRng('x')` twice → identical sequences (the basis of every replay test)
  - `shuffle` returns a **new** array and never mutates its input
  - chi-square uniformity check on `int(6)` over 60 000 draws
  - `createSecureRng` produces different sequences across calls
- `tests/unit/card.test.ts` — `rankOf('TD') === 'T'`, `suitOf('AS') === 'S'`, a full 52-card deck has
  no duplicates

**You verify** — 🧪 honestly test-only; there is nothing to click at this layer.
```bash
cd backend && npx vitest run tests/unit/errors.test.ts tests/unit/rng.test.ts tests/unit/card.test.ts --reporter=verbose
```
Read the test names. The two that matter: *seeded rng is reproducible* (every future "this hand
scored wrong" bug depends on it) and *the error table matches the spec*.

**Done when**
- [ ] Seeded RNG is byte-reproducible across two runs
- [ ] `shuffle` is non-mutating and uniform
- [ ] Every spec'd error's code/status/i18nKey asserted
- [ ] `lint` confirms `domain/` still imports nothing from `infrastructure/` or Prisma

---

### S08 — Repository interfaces + in-memory fakes · 2.5 h · 🧪

**Goal:** every repository interface from [02](./02-technical-prd.md) §5.2 exists **with a working
in-memory implementation**, so services can be built and tested before any Prisma code.

**Needs:** S07

**Build**
- `domain/repositories/`: `IRepository<T, ID>` plus the full set —
  `IUserRepository`, `IGuestSessionRepository`, `IRefreshTokenRepository`, `ITableRepository`,
  `IInviteRepository`, `IGameInstanceRepository`, `IGameEventRepository`,
  `IGameSnapshotRepository`, `IChatRepository`, `IStatsRepository`, `ICosmeticRepository`,
  `IPreferencesRepository`, `IWalletRepository`, `ISecurityEventRepository`
- `tests/fakes/`: an `InMemory*Repository` for each, including a `claimSeat` that simulates the
  unique-constraint race by returning `null` on a taken seat
- A shared **contract test suite** — one describe block per interface, run against the fake now and
  against the Prisma implementation in S09. Writing it once and running it twice is what guarantees
  the fake and the real repo behave identically, which is the whole value of the fakes

**Tests**
- `tests/unit/repositories/contract/*.test.ts` — the shared suite, parameterized over
  implementations
- `claimSeat` returns `null` (never throws) when the seat is taken
- `findByInviteCode` ignores revoked and expired invites

**You verify** 🧪
```bash
cd backend && npx vitest run tests/unit/repositories --reporter=verbose
```
Every interface should show a passing contract block against the in-memory implementation. Note the
count — S09 must produce the same count against Prisma.

**Done when**
- [ ] All 14 interfaces defined in `domain/repositories/`
- [ ] A fake for each, passing the shared contract suite
- [ ] The suite is written so S09 can point it at Prisma with no edits

---

### S09 — Prisma repositories + `UnitOfWork` · 3 h · 🧪

**Goal:** the same contract suite passes against real SQLite, and a transaction that throws leaves
nothing behind.

**Needs:** S05, S08

**Build**
- `infrastructure/prisma/repositories/` — one class per interface. Each constructor takes
  **`PrismaClient | Prisma.TransactionClient`** ([02](./02-technical-prd.md) §5.3), which is what
  makes one class work both standalone and inside a transaction
- `PrismaTableRepository.claimSeat` — `create` and catch the unique violation, **no `SELECT` first**
  ([03](./03-data-model.md) §6.3)
- `isUniqueViolation(e)` helper (Prisma `P2002`)
- `infrastructure/prisma/UnitOfWork.ts` — `run<T>(work: (repos) => Promise<T>)` wrapping
  `$transaction`, plus `buildRepositories(tx)`
- Mappers between Prisma rows and domain entities (JSON `String` ↔ parsed object at this boundary
  and nowhere else)

**Tests**
- The S08 contract suite, re-run against Prisma on a temp SQLite file — **same assertions, same
  count**
- `tests/integration/unit-of-work.test.ts`:
  - two writes in one `run` both commit
  - a throw mid-`run` rolls back **both** (this is the property the guest-claim transaction depends
    on)
  - a repository used inside `run` sees uncommitted writes from earlier in the same `run`
- A true concurrency test: `Promise.all` of two `claimSeat` calls for the same seat → exactly one
  non-null result

**You verify** 🧪
```bash
cd backend && npx vitest run tests/unit/repositories tests/integration/unit-of-work.test.ts --reporter=verbose
```
Compare the contract-suite pass count against S08's — they must match. Then read the rollback test
and the concurrent-`claimSeat` test output.

**Done when**
- [ ] Contract suite green against Prisma with the same assertion count as against the fakes
- [ ] A throw inside `uow.run` rolls back every write
- [ ] Concurrent seat claims: exactly one wins, the loser gets `null` rather than an exception
- [ ] `lint` still clean — the Prisma classes live in `infrastructure/` and nothing in `domain/`
      imports them

---

### S10 — `container.ts`, app assembly, logging, `/health` + `/ready` · 2.5 h · 🌐

**Goal:** the composition root exists, logs are structured with secrets redacted, and `/ready`
actually tells the truth about the database.

**Needs:** S09

**Build**
- `src/container.ts` — the explicit composition root from [02](./02-technical-prd.md) §5.5. No DI
  framework. Services added as later sessions create them; today it wires `repos` and `uow`
- `infrastructure/logger.ts` — Pino with **redaction configured at the logger level** for
  `password`, `token*`, `cookie`, `authorization` ([02](./02-technical-prd.md) §11). Redaction by
  logger config, not by remembering to omit fields at call sites
- `interface/http/middleware/requestId.ts` + `pino-http`, so every log line carries `requestId`
- Middleware order exactly per [02](./02-technical-prd.md) §7:
  `requestId → pino-http → helmet → cors → cookieParser → rateLimit → zodValidate → authenticate → authorize → controller → errorHandler`
  (stubs for the ones not built yet, in the right order)
- `GET /health` (liveness, no dependency checks) and `GET /ready` (DB reachable; Redis when
  configured) — the distinction matters for the compose healthchecks in S45
- `interface/http/middleware/error.ts` — `AppError` → its status + `{ code, i18nKey, details }`;
  anything else → 500 `INTERNAL` with the `requestId` logged and **no stack trace to the client**
- `backend/requests/` — the `.http` collection we grow every session, starting with health/ready

**Tests**
- `tests/integration/health.test.ts` — `/health` 200 always; `/ready` 200 with DB up, **503 with
  `DATABASE_URL` pointed at a dead file**
- `tests/unit/logger-redaction.test.ts` — log an object containing a password and a cookie; assert
  the serialized line contains `[Redacted]` and neither secret value
- `tests/integration/error-middleware.test.ts` — a route throwing `SeatTakenError` → 409
  `{ code: 'SEAT_TAKEN' }`; a route throwing a plain `Error` → 500 `INTERNAL`, no stack in the body,
  and the `requestId` present in the log

**You verify** 🌐
```bash
cd backend && npm run dev
curl -s localhost:3000/health | jq
curl -si localhost:3000/ready | head -1        # → 200
# then break the DB and watch /ready tell the truth:
DATABASE_URL="file:./nope.db" npm run dev &
curl -si localhost:3000/ready | head -1        # → 503
```
Watch the dev console while you curl: each line should carry a `requestId`, and nothing should
print a raw cookie.

**Done when**
- [ ] `/ready` returns 503 when the DB is unreachable, 200 when it isn't
- [ ] Logs carry `requestId`; passwords and cookies appear as `[Redacted]`
- [ ] A thrown `AppError` becomes its documented status; an unexpected error becomes an opaque 500
- [ ] `backend/requests/health.http` runs from your editor

---

## 5. Phase C — Auth (S11–S16)

### S11 — argon2id, JWT, cookie helpers · 2.5 h · 🧪

**Goal:** the auth primitives, correct in isolation, before any endpoint uses them.

**Needs:** S07

**Build**
- `infrastructure/auth/password.ts` — argon2**id** (not bcrypt, per
  [02](./02-technical-prd.md) §2.1), tuned params in config
- `infrastructure/auth/jwt.ts` — sign/verify access tokens (short TTL) and refresh tokens; refresh
  tokens **stored as sha256 hashes**, never raw ([03](./03-data-model.md) §3.1)
- `infrastructure/auth/cookies.ts` — `httpOnly`, `sameSite: 'lax'`, `secure` in prod, correct
  `maxAge`, plus a clear helper
- `infrastructure/auth/guestToken.ts` — mint/verify a **table-bound** guest token, hashed at rest

**Tests**
- Hash then verify round-trips; a wrong password fails; two hashes of the same password differ
  (salting)
- A tampered JWT fails verification; an expired one fails with a distinguishable error
- The stored refresh value is a hash — assert the raw token never appears in what's persisted
- Cookie helper sets `httpOnly` and `secure` under `NODE_ENV=production`
- A guest token for table A does not verify against table B

**You verify** 🧪
```bash
cd backend && npx vitest run tests/unit/auth --reporter=verbose
```
The assertion to look for: *stored refresh token is a sha256 hash, raw value absent*. That's the one
that limits the damage of a database leak.

**Done when**
- [ ] argon2id in use; params in config, not hard-coded
- [ ] Refresh tokens persisted only as hashes
- [ ] Cookies `httpOnly` + `secure` in prod
- [ ] A guest token is provably bound to one `tableId`

---

### S12 — Zod validation, error middleware, helmet, CORS, rate limit · 2.5 h · 🌐

**Goal:** the boundary rejects malformed and abusive input before any controller sees it (P7).

**Needs:** S10

**Build**
- `zodValidate({ body?, query?, params? })` middleware → `ValidationError` with `fieldErrors`
- helmet, CORS (credentials on, exact origin from env), `cookieParser`
- Sliding-window rate limiter — in-process now, Redis-backed in S27 behind the same interface
- CSRF defense per [07](./07-security-and-anticheat.md) §5.4, with the documented exemption for the
  payment webhook
- A `/api/v1/_probe` dev-only route with a strict Zod schema, purely so you can see rejection
  behaviour with your own eyes

**Tests**
- A missing required field → 400 `VALIDATION_FAILED` with `fieldErrors` naming the field
- An unknown extra field is rejected (strict schemas, no silent coercion — P7)
- `"5"` is **not** coerced to `5` where a number is required
- Exceeding the limit → 429 with `retryAfterMs`
- A cross-origin request without credentials is refused
- Security headers present on every response

**You verify** 🌐
```bash
cd backend && npm run dev
curl -si -X POST localhost:3000/api/v1/_probe -H 'content-type: application/json' -d '{}' | head -20
curl -si -X POST localhost:3000/api/v1/_probe -H 'content-type: application/json' -d '{"n":"5"}' | head -5
for i in $(seq 1 200); do curl -s -o /dev/null -w "%{http_code} " localhost:3000/api/v1/_probe; done; echo
curl -sI localhost:3000/health | grep -i -E 'x-frame|content-security|x-content-type'
```
You should see field-level 400s, a refusal to coerce `"5"`, the codes flip to `429` partway through
the loop, and helmet's headers on the last command.

**Done when**
- [ ] Malformed bodies get 400 with per-field errors
- [ ] No silent type coercion
- [ ] Rate limit returns 429 with `retryAfterMs`
- [ ] helmet headers present; credentialed CORS restricted to the configured origin

---

### S13 — `POST /auth/register`, `POST /auth/login`, `GET /auth/me` · 3 h · 🌐

**Goal:** you can create an account and be recognized by cookie alone.

**Needs:** S11, S12

**Build**
- `AuthService.register` — argon2id hash, `UserPreferences` row, default `UserCosmetic` grants,
  `Wallet` row per asset with `status: 'VESTED'`, optional `inviteCode` recorded as the
  post-signup redirect target
- `AuthService.login` — verify, issue access + refresh cookies, update `lastSeenAt`
- `GET /auth/me` → `{ kind: 'user' | 'guest', ... }` (the shape `authStore.bootstrap()` consumes in
  S39)
- `authenticate` middleware — resolves identity from the access cookie; `authorize` for the
  P/G/U/H/A levels in [02](./02-technical-prd.md) §7
- Zod schemas in `contracts/dto/auth.ts` — **the same schemas the frontend forms will use** in S39
- Register/login/me added to `backend/requests/auth.http`

**Tests**
- Register → 201, cookies set, `UserPreferences` + `Wallet` + default cosmetics all created
- Duplicate email → 409, and **no partial user left behind** (the transaction actually rolls back)
- Login with a wrong password → 401 with an identical body and timing profile to unknown-email
  (no account enumeration)
- `/auth/me` without a cookie → 401; with one → the user's identity
- Weak password rejected by the Zod schema before hashing

**You verify** 🌐
```bash
cd backend && npm run dev
curl -sc /tmp/c.txt -X POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"correct-horse-battery","displayName":"Mehrang"}' | jq
curl -sb /tmp/c.txt localhost:3000/api/v1/auth/me | jq          # → your identity
curl -s -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"another-one","displayName":"Dup"}' | jq   # → 409
```
Then open Studio and confirm the new `User` has exactly one `UserPreferences`, one `Wallet` per
asset, and its default cosmetic rows.

**Done when**
- [ ] Register creates user + preferences + wallet + default cosmetics in **one** transaction
- [ ] Duplicate email leaves no partial rows
- [ ] `/auth/me` works from the cookie alone, with no `Authorization` header anywhere
- [ ] Wrong password and unknown email are indistinguishable to a caller

---

### S14 — Refresh rotation with family revocation + logout · 3 h · 🌐

**Goal:** a stolen refresh token gets contained instead of granting indefinite access
([03](./03-data-model.md) §6.2).

**Needs:** S13

**Build**
- `POST /auth/refresh` — verify the refresh cookie, issue a new token in the **same `familyId`**,
  set `replacedById` on the old row, rotate both cookies
- **Reuse detection:** presenting an already-revoked token revokes the entire family and logs a
  `BAD_TOKEN` `SecurityEvent`
- `POST /auth/logout` — revoke the current family, clear cookies
- Expired-token cleanup job

**Tests**
- Refresh issues a new token; the old row has `revokedAt` and `replacedById` set
- **Replaying a revoked token revokes the whole family** and every subsequent refresh in it fails —
  the property that makes theft containable
- The revoked-reuse attempt writes a `SecurityEvent`
- Logout then refresh → 401
- An expired refresh token → 401, not 500
- Two rapid parallel refreshes don't corrupt the family chain (the case S39's single-flight
  interceptor exists to avoid, tested here on the server side too)

**You verify** 🌐
```bash
cd backend && npm run dev
cp /tmp/c.txt /tmp/old.txt                                             # keep the pre-rotation cookie
curl -sb /tmp/c.txt -c /tmp/c.txt -X POST localhost:3000/api/v1/auth/refresh | jq   # rotate
curl -sb /tmp/c.txt localhost:3000/api/v1/auth/me | jq                 # → still you
curl -si -b /tmp/old.txt -X POST localhost:3000/api/v1/auth/refresh | head -1  # → 401, family revoked
curl -si -b /tmp/c.txt localhost:3000/api/v1/auth/me | head -1          # → 401 too: the whole family died
```
That last line is the point of the session. Confirm a `BAD_TOKEN` row appeared in `SecurityEvent` in
Studio.

**Done when**
- [ ] Rotation works and the old row is marked replaced
- [ ] Replaying an old token kills the family, including the currently-valid token
- [ ] The attempt is recorded as a `SecurityEvent`
- [ ] Parallel refreshes don't corrupt the chain

---

### S15 — `SecurityEvent` audit log + `/metrics` · 2 h · 🌐

**Goal:** the observability from [02](./02-technical-prd.md) §11 exists **before** the features that
need auditing, so nothing gets retrofitted.

**Needs:** S13

**Build**
- `SecurityEventService.record(kind, severity, context)` — the single entry point for every
  `ILLEGAL_MOVE`, `NOT_YOUR_TURN`, `BAD_TOKEN`, `SEAT_IMPERSONATION`, `RATE_LIMIT`, `INVITE_ABUSE`
- Wire it into the rate limiter (S12) and refresh-reuse detection (S14) now; later sessions add
  their own kinds
- In-process metrics counters: games started/finished, illegal moves, active sockets, reconnects,
  rejected moves — a `MetricsRegistry` service, **not** an HTTP route

> **Amended by [12-admin-console.md](./12-admin-console.md) §11.1.** This session originally also
> shipped `GET /metrics` and `GET /admin/security-events` on the **public** port behind a role
> check. That is the arrangement the admin-console isolation rule exists to prevent, so both routes
> move to the admin process in **S49**. S15 now produces the *data*; nothing is exposed over HTTP
> here, and `:3000` never gains an `/admin` path.

**Tests**
- Each kind records with the right severity, and `ALERT` rows are additionally logged at `error`
- Recording never throws into the caller's path — an audit failure must not fail a game move
- Counters increment on the events they describe
- **No route matching `/admin` or `/metrics` is mounted on the public app** (asserted by walking
  the Express router stack — the first half of the S48 guard)

**You verify** 🌐
```bash
# trip the rate limit, then look at what got recorded — straight from the DB, no route yet:
for i in $(seq 1 200); do curl -s -o /dev/null localhost:3000/api/v1/_probe; done
npx prisma studio          # SecurityEvent table → the RATE_LIMIT rows
curl -si localhost:3000/api/v1/metrics | head -1              # → 404, deliberately
```

**Done when**
- [ ] Rate-limit trips and token reuse both appear in `SecurityEvent`
- [ ] Counters increment and are readable from the registry in a unit test
- [ ] **`/metrics` and `/admin/*` are 404 on `:3000`**
- [ ] A deliberately broken audit write does not break the request that triggered it

---

### S16 — Table-bound guest tokens · 3 h · 🌐

**Goal:** `POST /auth/guest` issues an identity that works on exactly one table and nowhere else
(P6 without the privilege-escalation hole).

**Needs:** S11, S15

**Build**
- `POST /auth/guest { inviteCode, displayName }` → creates a `GuestSession` with the **non-nullable
  `tableId` resolved from the invite**, sets a guest cookie, creates a `PROVISIONAL` wallet
  ([03](./03-data-model.md) §3.1, [10](./10-economy-and-rewards.md) §2.2)
- Display-name validation: length, no impersonation of "Host"/"Admin", profanity filter
- 12-hour `expiresAt` ([10](./10-economy-and-rewards.md) §3.4)
- `authenticate` extended to resolve guest identities, returning
  `{ kind: 'guest', guestSessionId, tableId }`
- `authorize` gains the **guest-binding check**: a guest identity accessing any table other than its
  bound one → `FORBIDDEN` + a `SEAT_IMPERSONATION` `SecurityEvent`

**Tests**
- Guest creation from a valid invite → cookie set, `GuestSession.tableId` matches the invite's table,
  `PROVISIONAL` wallet created with balance 0
- An expired, revoked, or unknown invite code → the right error, no guest created
- **A guest token used against a different table → 403 and an audit row.** The core assertion of
  this session
- An expired guest session → 401 on `/auth/me`
- Display-name rules enforced

**You verify** 🌐
```bash
# (needs an invite code — S19 mints them properly; for now use the seeded demo invite)
curl -sc /tmp/g.txt -X POST localhost:3000/api/v1/auth/guest \
  -H 'content-type: application/json' -d '{"inviteCode":"SEEDDEMO","displayName":"Sara"}' | jq
curl -sb /tmp/g.txt localhost:3000/api/v1/auth/me | jq       # → {"kind":"guest","tableId":"..."}
curl -si -b /tmp/g.txt localhost:3000/api/v1/tables/<some-other-table-id> | head -1   # → 403
```
Confirm in Studio: a `GuestSession` with a non-null `tableId`, a `PROVISIONAL` wallet, and a
`SEAT_IMPERSONATION` `SecurityEvent` from that last call.

**Done when**
- [ ] A guest identity exists with **no account created**
- [ ] Its `tableId` is non-null and enforced on every request
- [ ] Cross-table use is 403 **and** audited
- [ ] A `PROVISIONAL` wallet is created alongside the guest session

---

## 6. Phase D — Tables & Invites (S17–S20)

### S17 — Game registry + `GET /games` · 2 h · 🌐

**Goal:** the endpoint that drives the welcome page exists and is server-driven, so adding a game
never needs a frontend deploy for the catalog ([05](./05-game-engine-spec.md) §5).

**Needs:** S10

**Build**
- `domain/games/GameEngine.ts` — the **full interface** from
  [05](./05-game-engine-spec.md) §1, types only. Writing it now (rather than at M1) means the whole
  platform is built against it from the start
- `domain/games/registry.ts` — `buildGameRegistry()` with `get(slug)` and `list()`
- Placeholder `GameMeta` entries for the five v1 games with `comingSoon: true`, real `preview` i18n
  keys, `playableCounts`, and the turn-limit declarations from
  [04](./04-realtime-protocol.md) §6.1
- `GET /api/v1/games` → `list()`; `GET /api/v1/games/:slug` → detail + options schema (JSON Schema
  derived from the Zod `optionsSchema`)

**Tests**
- `/games` returns all five with i18n keys and **no literal English text**
- `/games/:slug` 404s with `NOT_FOUND` on an unknown slug
- Every `GameMeta` satisfies a Zod meta-schema (catches a malformed entry at test time)
- `playableCounts` ⊆ `[minPlayers..maxPlayers]` for every game

**You verify** 🌐
```bash
curl -s localhost:3000/api/v1/games | jq '.[] | {slug, comingSoon, playableCounts, turnTimeoutMs}'
curl -s localhost:3000/api/v1/games/shelem | jq
curl -si localhost:3000/api/v1/games/nope | head -1     # → 404
```
Check the response carries `nameKey`/`taglineKey`, not `"Shelem"` — localization lives on the client
([02](./02-technical-prd.md) §8.1).

**Done when**
- [ ] Five games listed, all `comingSoon`
- [ ] Payloads carry i18n keys only
- [ ] Unknown slug → 404 `NOT_FOUND`
- [ ] The `GameEngine` interface compiles and matches [05](./05-game-engine-spec.md) §1

---

### S18 — Table CRUD · 3 h · 🌐

**Goal:** you can create a table for a game and read it back with its seat map.

**Needs:** S13, S17

**Build**
- `POST /tables` — validates `options` against the game's `optionsSchema`, validates `seatCount`
  against `playableCounts`, sets `origin: 'PRIVATE'`, `rewardEligible: true`
- `GET /tables/mine` — tables you host or are seated at, for the "resume" list
- `GET /tables/:id` — metadata + seat map, **no game state** (that's the socket's job —
  [02](./02-technical-prd.md) §3.1)
- `PATCH /tables/:id` — host only, `WAITING` only
- `DELETE /tables/:id` — host only, sets `closedAt`
- The `H` (host-of-table) authorization level

**Tests**
- Create with invalid options → 400 with field errors
- Create with a `seatCount` not in `playableCounts` → 400
- `PATCH` by a non-host → 403; `PATCH` while `IN_PROGRESS` → 409
- `GET /tables/:id` response contains **no game state keys** (asserted explicitly, so the transport
  rule can't erode)
- A guest can `GET` its own bound table and is 403 on any other

**You verify** 🌐
```bash
TID=$(curl -sb /tmp/c.txt -X POST localhost:3000/api/v1/tables -H 'content-type: application/json' \
  -d '{"gameSlug":"fixture","seatCount":4,"options":{}}' | jq -r .id)
curl -sb /tmp/c.txt localhost:3000/api/v1/tables/$TID | jq
curl -sb /tmp/c.txt localhost:3000/api/v1/tables/mine | jq '.[].id'
curl -si -b /tmp/g.txt -X PATCH localhost:3000/api/v1/tables/$TID \
  -H 'content-type: application/json' -d '{"options":{}}' | head -1     # → 403, not the host
```

**Done when**
- [ ] Create/read/patch/close all work with correct authorization
- [ ] Options are validated against the engine's own schema
- [ ] The detail response carries no game state
- [ ] `requests/tables.http` covers every route

---

### S19 — Invites · 2.5 h · 🌐

**Goal:** a link you can send a friend, resolvable **without any authentication** — the mechanism
journey J1→J2 rests on.

**Needs:** S18

**Build**
- `POST /tables/:id/invites` — host only; short URL-safe code (~8 chars, unambiguous alphabet),
  `expiresAt`, optional `maxUses`
- `DELETE /tables/:id/invites/:code` — sets `revokedAt`
- **`GET /invites/:code` — public.** Returns game name key, host display name, seats free, whether
  the game is in progress, and `requireApproval`. Powers the pre-join screen in S43
- Abuse controls per [07](./07-security-and-anticheat.md) §5.2: rate-limited resolution, an
  `INVITE_ABUSE` `SecurityEvent` on repeated bad codes, and **no distinction in the response
  between "revoked" and "never existed"** (so codes can't be enumerated)

**Tests**
- Mint → resolve with **no cookie at all** → 200 with the pre-join payload
- Revoked → 410 `INVITE_EXPIRED`; expired → 410; unknown → 410 with an **identical** body to
  revoked
- `maxUses` exhausted → 410
- The public payload contains **no email, no user id, no game state** — only what a pre-join screen
  needs
- Non-host minting → 403

**You verify** 🌐
```bash
CODE=$(curl -sb /tmp/c.txt -X POST localhost:3000/api/v1/tables/$TID/invites | jq -r .code)
curl -s localhost:3000/api/v1/invites/$CODE | jq          # ← run with NO cookie: must still work
curl -sb /tmp/c.txt -X DELETE localhost:3000/api/v1/tables/$TID/invites/$CODE
curl -si localhost:3000/api/v1/invites/$CODE | head -1    # → 410
curl -si localhost:3000/api/v1/invites/TOTALLYFAKE | head -1   # → 410, same body
```
The uncookied call succeeding is the whole point — that's what makes the invite link work in a
private window.

**Done when**
- [ ] `GET /invites/:code` works with zero authentication
- [ ] Revoked, expired, and nonexistent codes are indistinguishable
- [ ] The payload leaks no PII and no game state
- [ ] Bad-code spraying is rate-limited and audited

---

### S20 — Seat claim and release · 3 h · 🧪

**Goal:** two people clicking the same seat at the same instant resolves correctly, at the database
level.

**Needs:** S16, S19

**Build**
- `TableService.claimSeat(tableId, seat, occupant)` — insert-and-catch via the repository, never
  read-then-write ([03](./03-data-model.md) §6.3)
- `releaseSeat` — frees the seat while `WAITING`; while `IN_PROGRESS` sets `disconnectedAt` instead
  of vacating (the seat belongs to the match now)
- Occupant resolution for all three kinds: user, guest, bot
- `team` assignment for partnership games (`seat % 2`)
- Spectator join (`seat: null`, `role: 'SPECTATOR'`) gated on `Table.allowSpectators`
- Capacity check against `seatCount`; `requireApproval` path

**Tests**
- **`Promise.all` of two claims on the same seat → exactly one succeeds, the other gets
  `SeatTakenError` (409).** The headline assertion
- One identity claiming two seats at one table → rejected by `(tableId, userId)`
- A guest claiming a seat at a table it isn't bound to → 403 + audit row
- Release while `WAITING` frees the seat; release while `IN_PROGRESS` sets `disconnectedAt` and
  keeps the row
- Multiple spectators coexist (the `seat = null` case)
- Claiming a seat on a full table → 409

**You verify** — 🧪 test-only by nature: you can't click two buttons in the same millisecond.
```bash
cd backend && npx vitest run tests/integration/seat-claim.test.ts --reporter=verbose
```
Read the concurrency test's output. Then a manual sanity check via HTTP: claim seat 1 as your user,
try again as the guest → 409 `SEAT_TAKEN`.

**Done when**
- [ ] The concurrent-claim test proves exactly one winner
- [ ] No `SELECT`-then-`INSERT` anywhere in the seat path (verify by reading the code)
- [ ] One identity cannot hold two seats
- [ ] Release behaves differently in `WAITING` vs `IN_PROGRESS`

---

## 7. Phase E — Wallet & the Claim Transaction (S21–S22)

### S21 — Wallet credit path · 3 h · 🧪

**Goal:** the ledger from [10](./10-economy-and-rewards.md) §2 works, and a replayed credit pays
exactly once.

**Needs:** S09, S06

**Build**
- `WalletService.credit(input)` per [10](./10-economy-and-rewards.md) §2.4:
  1. look up by `(holderKey, idempotencyKey)` → return the existing row if found
  2. `applyCaps` (E7) — per-hour, per-day, per-day-guest, matches-per-day, from the `_global`
     `RewardRule`
  3. capped to zero → append a **`CAP_REJECTED` zero-amount row with a reason** rather than
     silently nothing
  4. append the row and bump `Wallet.balance` **in the same transaction**
- `balanceFor(holderKey, asset)` and `recompute(holderKey, asset)` (Σ transactions)
- `WalletTransaction.balanceAfter` written on every row, for statement rendering
- Holder resolution: `User` → `VESTED`, `GuestSession` → `PROVISIONAL`

**Tests**
- **Same `idempotencyKey` twice → one row, one balance change, and the second call returns the
  first row** (E2)
- `balance == Σ transactions` after a randomized sequence of 500 credits (E1)
- Cap exceeded → `CAP_REJECTED` row with `amount: 0` and a reason; balance unchanged
- Guest credit lands on a `PROVISIONAL` wallet
- Derived key formats match [10](./10-economy-and-rewards.md) §2.4 exactly:
  `match:{matchResultId}:{seat}`, `daily:{holderKey}:{YYYY-MM-DD}`, `achv:{achievementId}:{holderKey}`,
  `vest:{guestSessionId}`
- **A test asserting no code path calls `bumpCachedBalance` without appending a row** — the E1
  invariant, enforced rather than trusted
- `balanceAfter` on each row equals the running total

**You verify** 🧪
```bash
cd backend && npx vitest run tests/unit/wallet tests/integration/wallet --reporter=verbose
```
The two to read: *duplicate idempotency key credits once* and *balance equals sum of transactions
after 500 random credits*.

**Done when**
- [ ] Duplicate keys provably credit once
- [ ] `balance == Σ transactions` under a randomized sequence
- [ ] Capped rewards produce an explanatory `CAP_REJECTED` row, never silence
- [ ] Every key format matches the spec

---

### S22 — ⭐ The guest→user claim transaction · 3 h · 🌐

**Goal:** journey J2. A guest signs up mid-session, keeps their seat, and keeps their coins — all or
nothing.

**Needs:** S16, S20, S21

**Build**
`POST /auth/guest/claim`, implementing all 12 steps of
[03](./03-data-model.md) §6.1 inside **one** `uow.run`:

1. verify the `GuestSession` (not expired, not already claimed) → 2. create `User` (argon2id,
displayName carried over) → 3. `UserPreferences` from `prefsJson` → 4. default `UserCosmetic` rows →
5. **`TableMember`: set `userId`, clear `guestSessionId` — UPDATE, not recreate, so the seat, team,
and `joinedAt` are untouched and no seat-vacated event is emitted** → 6. `GameEvent`:
`actorGuestId → actorUserId` → 7. same re-attribution for `ChatMessage` and `MatchParticipant` →
8. create the `VESTED` user wallet per asset → 9. **`GUEST_VEST` credit of
`min(provisional, guestVestCap=500)`** → 10. mirror-negative row on the guest wallet so the ledger
stays balanced → 11. `GuestSession.claimedAt` + `claimedByUserId` (row retained as the audit link,
never deleted, so the token can never be reused) → 12. issue a `RefreshToken` in a new family.

Returns `{ user, redirectTo: '/table/{tableId}', vestedCoins }` — **`redirectTo` comes from the
server**, decided by the same transaction that preserved the seat, so the client can't drift
([06](./06-frontend-architecture.md) §3.1).

**Tests** — the four failure modes [03](./03-data-model.md) §6.1 names explicitly:
- Duplicate email at step 2 → 409, **no user, no seat change, no vest**
- Expired guest at step 1 → 401, nothing created
- An injected throw at step 6 → the created user is rolled back
- An injected throw at step 9 → **both** the user and the seat transfer roll back (a claimed seat
  with no wallet is as broken as a wallet with no seat)

Plus:
- Happy path: same `TableMember.id`, same `seat`, same `team`, same `joinedAt` before and after
- Provisional 120 → vested 120; provisional 900 → vested **500** (the cap) with the remainder
  forfeited and explained
- Vesting is idempotent by `vest:{guestSessionId}` — a retried claim vests once
- The mirror-negative row exists, so Σ across both wallets is conserved
- `GameEvent` rows previously attributed to the guest now carry `actorUserId`
- The guest token is dead afterward — reusing it → 401

**You verify** 🌐 — the closest thing to journey J2 before the UI exists:
```bash
# 1. guest joins and takes a seat
curl -sc /tmp/g.txt -X POST localhost:3000/api/v1/auth/guest -H 'content-type: application/json' \
  -d "{\"inviteCode\":\"$CODE\",\"displayName\":\"Sara\"}" | jq
# 2. (grant the guest some provisional coins with the dev credit script)
npx tsx scripts/dev-credit.ts --guest-cookie /tmp/g.txt --amount 120
curl -sb /tmp/g.txt localhost:3000/api/v1/wallet | jq          # → provisional 120, vested 0
# 3. note the TableMember id in Studio, then claim:
curl -sb /tmp/g.txt -c /tmp/g.txt -X POST localhost:3000/api/v1/auth/guest/claim \
  -H 'content-type: application/json' \
  -d '{"email":"sara@test.dev","password":"correct-horse-battery"}' | jq
# → { user, redirectTo:"/table/...", vestedCoins:120 }
curl -sb /tmp/g.txt localhost:3000/api/v1/wallet | jq          # → vested 120, provisional 0
```
In Studio, confirm the **`TableMember` row has the same `id`, `seat`, `team`, and `joinedAt`** as
before, now with `userId` set and `guestSessionId` null. That row keeping its identity is the whole
trick — from the other players' point of view nothing happened except a name badge losing its
"guest" marker.

**Done when**
- [ ] Seat is preserved: same `TableMember.id`, `seat`, `team`, `joinedAt`
- [ ] Coins vest, capped at 500, with a balanced mirror row
- [ ] All four failure modes roll back completely
- [ ] `redirectTo` comes from the server
- [ ] The guest token is unusable afterward, and the `GuestSession` row survives as an audit link

---

## 8. Phase F — Sockets (S23–S27)

### S23 — Gateway and handshake identity · 3 h · 🔌

**Goal:** a socket connects, its identity is resolved **once** from cookies, and nothing in any
payload can ever change it ([04](./04-realtime-protocol.md) §1.1).

**Needs:** S16

**Build**
- `interface/socket/gateway.ts` — single namespace `/`, transport config exactly per
  [04](./04-realtime-protocol.md) §1.2 (`['websocket','polling']`, `pingInterval`/`pingTimeout`
  20 s, **`maxHttpBufferSize: 1e5`** — a large frame is a bug or an attack)
- Handshake middleware: access cookie → `{ kind:'user' }`; guest cookie → verify `GuestSession` →
  `{ kind:'guest', guestSessionId, tableId }`; neither → `connect_error UNAUTHORIZED`
- `socket.data.identity` — set once, **immutable for the socket's life**
- `connected` event with `{ serverTime, protocolVersion }`; a version mismatch tells the client to
  refresh
- Typed `ServerToClientEvents` / `ClientToServerEvents` in `contracts/events.ts`, then
  `contracts:sync`
- A socket ack wrapper mapping `AppError → { ok:false, code, i18nKey }`
- **`backend/scripts/dev-socket.ts`** — a small CLI client that connects with a cookie jar and lets
  you emit events by hand. This is your socket verification tool for every session up to S42

**Tests**
- Connect with a valid access cookie → `connected`; identity is `user`
- Connect with a guest cookie → identity is `guest` with the right `tableId`
- Connect with no cookies → `connect_error UNAUTHORIZED`
- **A payload containing `userId` / `seat` / `playerId` is ignored** — identity is unchanged
  (the assertion that eliminates the seat-impersonation class)
- A frame over 100 KB is rejected
- `protocolVersion` mismatch is reported to the client

**You verify** 🔌
```bash
cd backend && npm run dev
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt
# → connected { serverTime, protocolVersion }, and it prints your resolved identity
npx tsx scripts/dev-socket.ts                       # no cookies → connect_error UNAUTHORIZED
npx tsx scripts/dev-socket.ts --cookies /tmp/g.txt  # → identity: guest, bound to a tableId
```

**Done when**
- [ ] All three identity outcomes behave as specified
- [ ] `dev-socket.ts` works and is committed — you'll use it for the next 19 sessions
- [ ] A payload cannot alter identity
- [ ] Oversized frames rejected

---

### S24 — Room model, join, snapshot, seat broadcast · 3 h · 🔌

**Goal:** two clients at one table see each other's seat changes live, and the room structure that
makes hand privacy *structural* exists from the start.

**Needs:** S23, S20

**Build**
- All four rooms from [04](./04-realtime-protocol.md) §2: `table:{tableId}`,
  `seat:{tableId}:{seat}`, `spectators:{tableId}`, `user:{userId}`
- `table:join { tableId, asSpectator? }` → joins the table room **and** the seat room; guests
  rejected on any table but their bound one
- `table:snapshot` — full lobby state on join: `{ table, members[], you:{seat,role}, chat[] }`
- `table:leave`, `table:takeSeat`, `table:releaseSeat`, `table:addBot`, `table:removeBot`,
  `table:kick`, `table:updateOptions` — with the host-only checks from
  [04](./04-realtime-protocol.md) §3.1
- Broadcasts: `table:memberJoined`, `table:memberLeft`, `table:seatChanged`,
  `table:optionsChanged`, `table:statusChanged`
- **`seat` is always looked up server-side from `TableMember`** by identity + table, never read
  from the payload

**Tests**
- Two clients: A takes seat 1 → B receives `table:seatChanged`
- `table:takeSeat` on a taken seat → ack `SEAT_TAKEN`; the client is told to re-render
- A guest joining a table it isn't bound to → `FORBIDDEN` + audit row
- Host-only events from a non-host → `FORBIDDEN`
- **The private seat room receives nothing a spectator gets and vice versa** — asserted now, while
  there is no game state to leak, so the structure is right before it matters
- `table:snapshot` contains the caller's own seat and role

**You verify** 🔌 — two terminals:
```bash
# terminal 1
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID
# terminal 2
npx tsx scripts/dev-socket.ts --cookies /tmp/g.txt --join $TID
```
In terminal 1 type `takeSeat 1`; terminal 2 must print `table:seatChanged { seat:1, occupant:… }`.
Then in terminal 2 type `takeSeat 1` → ack `SEAT_TAKEN`. Then `takeSeat 2` → terminal 1 sees it.

**Done when**
- [ ] Two clients see each other's seat changes live
- [ ] Taking an occupied seat is refused with `SEAT_TAKEN`
- [ ] Guests can only join their bound table
- [ ] Table-room and seat-room membership is separate and asserted by tests

---

### S25 — Presence, heartbeat, disconnect grace · 2.5 h · 🔌

**Goal:** when someone's phone drops, everyone else sees "reconnecting… 0:58" instead of a frozen
table.

**Needs:** S24

**Build**
- `presence:heartbeat` every 15 s → updates `lastSeenAt`
- `table:presence { seat, state: 'online'|'away'|'disconnected', graceEndsAt? }`
- On transport close: set `TableMember.disconnectedAt`, start the grace timer, broadcast
- Per-game grace from `meta.disconnectGraceMs` ([04](./04-realtime-protocol.md) §5.2: Blackjack
  45 s, Shelem 90 s, Poker 45 s, Sudoku ∞, Chess clock-only)
- Reconnect within grace → clear `disconnectedAt`, cancel the timer, send a full `table:snapshot`,
  broadcast `online`
- Grace expiry → emit the hook S33 uses for ejection (the timer mechanism now, the consequence
  later)
- **Multi-tab:** a second socket for the same identity joins the same seat room; both get the
  private projection — correct, it's the same person

**Tests**
- Disconnect → `disconnectedAt` set, `table:presence disconnected` broadcast with `graceEndsAt`
- Reconnect within grace → state `online`, `disconnectedAt` cleared, snapshot resent
- Grace expiry fires the ejection hook exactly once
- Two tabs for one identity → both in the seat room; closing one leaves the seat **online**
- Missing heartbeats → `away` before `disconnected`

**You verify** 🔌
```bash
# terminal 1 stays connected; terminal 2 gets killed
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID --seat 1
npx tsx scripts/dev-socket.ts --cookies /tmp/g.txt --join $TID --seat 2
# Ctrl-C terminal 2 → terminal 1 prints table:presence { seat:2, state:'disconnected', graceEndsAt }
# restart terminal 2 within the grace window → terminal 1 prints state:'online'
```
Then open a third client with the **same** cookie as terminal 1 and confirm seat 1 stays `online`
when you close only one of them.

**Done when**
- [ ] Disconnect broadcasts `disconnected` with a `graceEndsAt` you can see counting down
- [ ] Reconnect inside grace restores `online` and resends the snapshot
- [ ] Grace expiry fires its hook once
- [ ] Multi-tab doesn't produce a false disconnect

---

### S26 — Chat and emotes · 2.5 h · 🔌

**Goal:** the M0 exit criterion "chat works both ways" — including for guests, and with system
messages that translate.

**Needs:** S24

**Build**
- `chat:send { tableId, body }` → persist + broadcast `chat:message`; rate-limited with its own
  bucket
- `chat:emote { tableId, emoteId }` → cheaper limit
- **`SYSTEM` messages store an i18n key + `paramsJson`, never English prose**
  ([03](./03-data-model.md) §3.4) — so "Sara took seat 2" renders in Persian for a Persian reader
  from the same row
- Author resolution for user / guest / bot; length limits; profanity filter; `redactedAt` support
- `table:snapshot` includes recent history so a joiner sees the conversation

**Tests**
- Both directions between a user and a guest
- Rate limit → ack `RATE_LIMITED` with `retryAfterMs`; the message is not persisted
- Over-length body → `VALIDATION_FAILED`
- Seat changes emit a `SYSTEM` message whose `body` is an **i18n key** — asserted by matching
  `/^[a-z]+(\.[a-zA-Z]+)+$/` and rejecting any whitespace-bearing English string
- A joiner's snapshot contains the prior messages
- Emote and text limits are independent buckets

**You verify** 🔌
With the two clients from S24 joined, type `chat hello` in terminal 1 → terminal 2 prints it, and
vice versa. Then `chat` 40 times fast → `RATE_LIMITED`. Then `takeSeat 3` and confirm the resulting
`SYSTEM` message body is something like `table.system.seatTaken`, **not** `"Sara took seat 3"`.

**Done when**
- [ ] User↔guest chat works both ways
- [ ] Rate limits fire with `retryAfterMs` and drop the message
- [ ] System messages are i18n keys, proven by the test's regex
- [ ] A late joiner sees history

---

### S27 — Redis: adapter, presence, rate limits, and the fallback · 2.5 h · 🖥️

**Goal:** Redis is wired where [02](./02-technical-prd.md) §3.2 says it belongs — and the app still
runs without it.

**Needs:** S25, S26

**Build**
- `infrastructure/redis/` — client, health check, graceful degradation
- `@socket.io/redis-adapter` when `REDIS_URL` is set; in-memory adapter otherwise
- Presence sets in Redis (`presence:*`), recomputed from live sockets on restart
- The S12 rate limiter's Redis-backed implementation behind the same interface
- `redis` service in `docker-compose.yml`
- **A guard test asserting nothing writes wallet state, matchmaking cooldowns, game state, or
  reward idempotency keys to Redis** — the four "must NEVER" rows in
  [02](./02-technical-prd.md) §3.2, enforced rather than remembered

**Tests**
- With `REDIS_URL` unset: everything works on the in-memory path
- With it set: rate-limit counters land in Redis and are shared
- Redis dropping mid-session degrades rather than crashing; `/ready` reports it
- Presence recomputes after a restart
- The forbidden-keys guard test passes

**You verify** 🖥️
```bash
docker compose up -d redis
REDIS_URL=redis://localhost:6379 npm run dev
curl -si localhost:3000/ready | head -1                 # → 200
redis-cli KEYS 'ratelimit:*'                            # → counters appear as you make requests
redis-cli KEYS '*wallet*'                               # → MUST be empty
docker compose stop redis
curl -si localhost:3000/ready | head -1                 # → 503, honestly reported
# and unset it entirely:
unset REDIS_URL && npm run dev && curl -si localhost:3000/ready | head -1   # → 200
```

**Done when**
- [ ] Works with **and** without Redis
- [ ] `redis-cli KEYS '*wallet*'` is empty — money never lives in Redis
- [ ] Losing Redis degrades gracefully and shows up in `/ready`
- [ ] Presence recomputes after restart

---

## 9. Phase G — Event Log (S28–S30)

### S28 — `GameInstance`, seed commitment, `GameEvent` append · 3 h · 🧪

**Goal:** the append-only log (P4) with DB-enforced ordering and idempotency, plus the provable-deal
commitment.

**Needs:** S09, S17

**Build**
- `GameSessionService.createInstance(tableId, gameSlug, options)`:
  - generate `rngSeed` via `createSecureRng`
  - compute `seedCommit = sha256(rngSeed + gameId)`
  - snapshot the seating into `seatingJson` so history survives later seat changes
  - **broadcast `game:started` with `seedCommit` BEFORE any deal**
    ([03](./03-data-model.md) §5, [07](./07-security-and-anticheat.md) §4.2)
- `GameEventRepository.append` — `seq` assigned inside the transaction, `(gameId, seq)` unique
- Idempotency: a retried `clientMoveId` **fails to insert** and returns the prior ack, rather than
  double-applying ([03](./03-data-model.md) §4.4)
- `AUDIT` events for rejected moves, in the same ordered stream
- `rngSeed` is **never** included in any client-facing payload while the game is live

**Tests**
- `seq` is strictly monotonic under 100 concurrent appends, with no gaps and no duplicates
- The same `clientMoveId` twice → one event, and the second call returns the first ack
- `seedCommit == sha256(seed + gameId)`, verified independently in the test
- **`rngSeed` appears in no payload before `finishedAt`** — a serialize-and-substring-search
  assertion
- Rejected moves land as `AUDIT` events

**You verify** 🧪
```bash
cd backend && npx vitest run tests/integration/event-log.test.ts --reporter=verbose
npx tsx scripts/dev-verify-commit.ts --game <gameId>   # recompute sha256(seed+gameId) yourself
```
Then look at `GameEvent` in Studio: contiguous `seq`, one row per move, and an `AUDIT` row for the
rejected one.

**Done when**
- [ ] `seq` monotonic and gapless under concurrency
- [ ] Duplicate `clientMoveId` provably appends once
- [ ] The commit is verifiable by hand and the seed never leaks early
- [ ] Rejections are logged as `AUDIT` events

---

### S29 — Snapshots, `rebuildState`, resync · 3 h · 🔌

**Goal:** state is rebuilt from the log rather than held in memory (so a restart loses nothing), and
a client that falls behind recovers correctly.

**Needs:** S28

**Build**
- `rebuildState(gameId)` → `replay(snapshot.state, events where seq > snapshot.seq)`
- Snapshot policy per [03](./03-data-model.md) §4.3: **every 25 events, always at a phase boundary,
  always on `FINISHED`**
- `game:requestSync { lastSeq }` → `delta` when the gap ≤ 50, otherwise `full`
  ([04](./04-realtime-protocol.md) §5.3)
- Client-side `seq` gap detection contract: `seq > lastSeq + 1` → request sync; `seq <= lastSeq` →
  **drop silently** (which is what makes the client idempotent against duplicate delivery)
- `game:syncRequired` when the server notices a client is behind
- Weekly pruning job for snapshots older than the two most recent — **events are never pruned**

**Tests**
- `rebuildState` after 100 events equals the state produced by applying them in sequence
- A snapshot exists at event 25, 50, 75; replay cost bounded at ~25 events
- Delta resync sends exactly the missed events, then one current state
- Full resync is correct from `lastSeq: 0` **and** from no `lastSeq` at all
- **Kill the process mid-game, restart, rebuild → identical state.** The property that makes
  "restart with zero lost games" true
- Stale `seq` messages are dropped, not applied
- Pruning removes old snapshots and **zero** events

**You verify** 🔌
```bash
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID   # play some fixture moves
# now kill the server (Ctrl-C) and restart it:
npm run dev
# in the socket client:
requestSync 0        # → mode:'full', state matches what you had
requestSync <recent> # → mode:'delta', only the missed events
```
The restart surviving is the thing to actually watch here.

**Done when**
- [ ] `rebuildState` matches sequential application
- [ ] Snapshots appear on the documented schedule
- [ ] Both resync modes correct; `full` always works as the fallback
- [ ] **A server restart mid-game loses nothing**
- [ ] Pruning never touches events

---

### S30 — The `_fixture` engine and the move pipeline · 3 h · 🔌

**Goal:** the full move flow from [05](./05-game-engine-spec.md) §6 runs end to end — which is what
lets S31–S34 and S36 be tested at all (see §1 above).

**Needs:** S29

**Build**
- `domain/games/_fixture/` — a trivial engine implementing the **whole** `GameEngine` interface:
  seats take turns incrementing a counter; `projectState` hides a `secret` field from non-owners;
  `bot` presses the button; `defaultActionOnTimeout` returns the safest move; `result()` reports a
  per-seat `SeatOutcome`
- Registered **only when `NODE_ENV !== 'production'`**, asserted by a test
- `GameSessionService.applyMove` — the pipeline exactly per [05](./05-game-engine-spec.md) §6:
  resolve seat **from the socket**, rebuild state, check idempotency, `engine.applyMove`, loop
  `advance()` until null, one `uow.run` appending events + maybe snapshot, then
  **`projectState` once per viewer**
- `game:start`, `game:move`, `game:state`, `game:event`, `game:moveRejected`, `game:finished`
- **The generic leak-test harness** — serialize a projection and assert the hidden field appears
  nowhere. Written generically here so M1 onward reuses it unchanged
- `replayFixture(seed, moves)` test kit

**Tests**
- All five invariants on `_fixture`: I1 (twice-equal under a seeded RNG), I2 (frozen input),
  I3 (every move ∉ `legalMoves` throws), I4 (leak test), I5 (JSON round-trip)
- An illegal move → `ILLEGAL_MOVE` ack + `AUDIT` event + no state change
- Moving out of turn → `NOT_YOUR_TURN`
- **A move payload claiming another seat is ignored; the socket's seat is used**
- Two viewers of the same state receive **different** payloads (proving projection is per-viewer,
  not per-broadcast)
- `advance()` terminates
- `_fixture` is absent from the registry under `NODE_ENV=production`
- `replayFixture` is byte-identical across two runs

**You verify** 🔌 — two clients, seats 1 and 2:
```bash
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID --seat 1
npx tsx scripts/dev-socket.ts --cookies /tmp/g.txt --join $TID --seat 2
# terminal 1:
start
move {"kind":"press"}      # → both get game:state with an incremented seq
move {"kind":"press"}      # → ack ILLEGAL_MOVE / NOT_YOUR_TURN: not your turn
move {"kind":"press","seat":2}   # → still rejected; the payload's seat is ignored
```
Compare the two terminals' `game:state` payloads side by side: **terminal 1's contains its own
`secret`, terminal 2's does not.** That difference is the entire anti-cheat architecture, visible.

**Done when**
- [ ] The pipeline works end to end over sockets
- [ ] The two clients' projections visibly differ
- [ ] All five invariants tested and passing on `_fixture`
- [ ] Payload-claimed seats are ignored
- [ ] The leak harness and `replayFixture` are generic and committed
- [ ] `_fixture` is excluded in production

---

## 10. Phase H — Turn Enforcement (S31–S34)

### S31 — `TurnTimerService` · 3 h · 🔌

**Goal:** absolute, server-authoritative deadlines that a client with a wrong system clock still
renders correctly.

**Needs:** S30, S27

**Build**
- `TurnTimerService` — owns every deadline; **the engine never touches a clock** (I1,
  [05](./05-game-engine-spec.md) §4.6)
- On a turn beginning: compute `endsAt` from `meta.turnTimeoutMs` (or
  `turnTimeoutByPhaseMs`), store it in Redis `game:{id}:timer` **and** append a `PHASE` game event
- Broadcast `game:turnTimer { gameId, seat, endsAt, strikes }` to the table room
- Server-time offset published at handshake, so the client counts down from `endsAt` against
  server time ([04](./04-realtime-protocol.md) §5.4)
- Cancel on action; re-arm on the next turn
- Per-game limits from [04](./04-realtime-protocol.md) §6.1 declared in each `GameMeta`

**Tests**
- Timer arms on turn start with the right `endsAt`; broadcast carries it
- Acting cancels the timer; the next turn re-arms
- `turnTimeoutByPhaseMs` overrides the default (Shelem bidding 45 s vs play 30 s)
- The deadline is written to **both** Redis and a `PHASE` event
- A game with `turnTimeoutMs: null` arms nothing
- **No engine file imports the timer service** — a lint/import-graph assertion

**You verify** 🔌
```bash
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID --seat 1
start                     # → game:turnTimer { seat:1, endsAt, strikes:0 }
redis-cli GET "game:<gameId>:timer"          # → the same absolute endsAt
move {"kind":"press"}     # → timer cancels, re-arms for seat 2
```
Confirm the `PHASE` event in Studio carries the same `endsAt` as Redis — the redundancy is what
makes S34's restart re-arming possible.

**Done when**
- [ ] Deadlines are absolute and broadcast
- [ ] Stored in Redis **and** as a `PHASE` event
- [ ] Acting cancels; next turn re-arms
- [ ] Per-phase overrides work
- [ ] No engine imports the timer

---

### S32 — Warning, strikes, default actions · 3 h · 🔌

**Goal:** an idle player is warned and struck, and the table keeps playing —
[04](./04-realtime-protocol.md) §6.2–6.5.

**Needs:** S31

**Build**
- `game:ejectionWarning { secondsRemaining, consequence: 'EJECTION_NO_REWARD' }` at
  `warningSeconds` (default 10) — **sent only to the acting seat's socket**, not the table
- On expiry: `strikes++`, apply the engine's `defaultActionOnTimeout`, append a `TIMEOUT` event,
  broadcast `game:event { kind:'TURN_TIMEOUT', seat, strikes }`, re-arm
- `turnEnforcement` table options exactly per [04](./04-realtime-protocol.md) §6.3:
  `ejectAfterStrikes` (default **2**), `warningSeconds` (10), `strikesResetOnAction` (true),
  `reclaimWindowSec` (120)
- `strikesResetOnAction` — any action clears the count, so strikes measure *current* absence, not
  lifetime record
- The `_fixture` engine's `defaultActionOnTimeout` returns its safest move

**Tests**
- Warning fires at exactly `warningSeconds` and goes **only** to the acting seat (asserted by a
  second client receiving nothing)
- Expiry increments the strike and applies the default action; the game advances
- `strikesResetOnAction: true` → timeout, then a normal move, then a later timeout ⇒ strikes is 1,
  not 2
- `strikesResetOnAction: false` → strikes accumulate
- `ejectAfterStrikes: 1` ejects on the first lapse (your literal rule, as a table option)
- **The default action never spends an unauthorized resource** — a per-game assertion, trivial for
  `_fixture` but the harness M2/M5 will reuse for "never auto-hit" and "never auto-call"

**You verify** 🔌
```bash
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID --seat 1
start
# now just wait, and watch:
#   t-10s → game:ejectionWarning (ONLY in this terminal)
#   t-0   → game:event { kind:'TURN_TIMEOUT', strikes:1 }, and play moves on
```
With a second client on seat 2, confirm it sees the `TURN_TIMEOUT` event but **never** the warning.
Then set `ejectAfterStrikes: 1` on a new table and confirm one lapse is enough.

**Done when**
- [ ] The warning reaches only the acting seat
- [ ] Strikes increment and the default action advances the game
- [ ] `strikesResetOnAction` works both ways
- [ ] `ejectAfterStrikes: 1` gives the strict rule
- [ ] The default action spends nothing unauthorized

---

### S33 — Ejection and bot substitution · 3 h · 🔌

**Goal:** the M0 exit criterion — *an idle player is warned, struck twice, ejected, and replaced by
a bot; the table plays on*.

**Needs:** S32

**Build**
- On the final strike: set `ejectedAt`, `ejectionReason: 'TURN_TIMEOUT'`, `botSubstituted: true`,
  `reclaimableUntil = now + reclaimWindowSec`; mark the seat's `SeatOutcome` as `EJECTED_TIMEOUT`
- Attach the engine's bot to the seat; it plays on the human's behalf
- Broadcast `game:playerEjected { seat, reason, replacedByBot, reclaimableUntil }`
- Send `game:rewardPreview { estimatedCoins: 0, integrityFactor: 0 }` to the ejected seat — the
  consequence is **explained, never silent** ([04](./04-realtime-protocol.md) §6.6)
- The same path for **disconnect** grace expiry, but with `EJECTED_ABANDON` (the two timers are
  different and carry different reward consequences — [04](./04-realtime-protocol.md) §5.2's
  warning)
- Games without bot support: pause if untimed, forfeit the seat if timed
- `BOT_TOOK_OVER` game event

**Tests**
- Two strikes → ejection, bot attached, table continues to a terminal state
- `MatchParticipant.outcome` is `EJECTED_TIMEOUT` for a turn-timeout and `EJECTED_ABANDON` for a
  disconnect — **not conflated**
- The bot never plays an illegal move (property test over 1000 seeds on `_fixture`)
- The ejected player's `rewardPreview` shows `integrityFactor: 0`
- Ejection is idempotent — a duplicate expiry doesn't double-eject
- A no-bot game pauses or forfeits per its declaration

**You verify** 🔌
```bash
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID --seat 1
npx tsx scripts/dev-socket.ts --cookies /tmp/g.txt --join $TID --seat 2
start
# in terminal 1: do nothing at all. Watch:
#   strike 1 → TURN_TIMEOUT
#   strike 2 → game:playerEjected { seat:1, replacedByBot:true, reclaimableUntil }
#           → game:rewardPreview { estimatedCoins:0, integrityFactor:0 }
# terminal 2: the game keeps going, now against a bot, to a finish.
```
That is the M0 exit criterion, demonstrated.

**Done when**
- [ ] Two strikes eject and substitute a bot; **the table plays on to a finish**
- [ ] `EJECTED_TIMEOUT` and `EJECTED_ABANDON` stay distinct
- [ ] The ejected player is told they'll earn zero, and why
- [ ] The bot is legal across 1000 seeds
- [ ] Double-ejection is impossible

---

### S34 — Seat reclamation and restart re-arming · 2.5 h · 🔌

**Goal:** coming back beats staying away, and a deploy doesn't gift anyone time.

**Needs:** S33

**Build**
- `game:reclaimSeat { gameId }` → within `reclaimableUntil`: detach the bot, restore human control,
  set `SeatOutcome: 'REPLACED_RETURNED'`, broadcast `game:playerReturned`
- The reclaim matrix from [04](./04-realtime-protocol.md) §6.4: within the window → yes, **0.5×
  reward**; after the window → no; ejected twice in one match → the seat is final; per-game
  `reclaimAt` (`IMMEDIATE` for Shelem — a hand is long; `HAND_BOUNDARY` for Poker/Blackjack, where
  joining onto a bot's committed chips is unfair in both directions)
- Outside the window → ack `SEAT_NOT_RECLAIMABLE`
- **Startup task: re-arm timers for every `ACTIVE` game from the persisted `PHASE` deadlines** —
  absolute `endsAt`, so a player who was 5 s from timing out is still 5 s from timing out after a
  restart ([04](./04-realtime-protocol.md) §5.4)

**Tests**
- Reclaim inside the window restores control and sets `REPLACED_RETURNED`
- Reclaim after it → `SEAT_NOT_RECLAIMABLE`, bot keeps the seat
- Second ejection in one match → not reclaimable
- `reclaimAt: 'HAND_BOUNDARY'` defers the handover to the boundary
- **Restart re-arms every active deadline and gifts no time** — the headline test: record `endsAt`,
  restart, assert the re-armed deadline is the *same absolute timestamp*
- A game that finished while the server was down is settled correctly on startup

**You verify** 🔌
```bash
# 1. get ejected (as in S33), then within 120s:
reclaimSeat                      # → game:playerReturned, you're back in control
# 2. get ejected again and wait past the window:
reclaimSeat                      # → SEAT_NOT_RECLAIMABLE

# 3. the restart test — the one worth doing carefully:
start                            # note the endsAt from game:turnTimer
# kill the server, wait 10 seconds, restart it, reconnect:
npm run dev
npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID
requestSync 0                    # → the SAME endsAt as before the restart, not a fresh 30s
```

**Done when**
- [ ] Reclaim works inside the window and is refused outside it
- [ ] `reclaimAt` respected per game
- [ ] **A restart re-arms the identical absolute deadline** — no free time
- [ ] Games that ended during downtime settle on startup

---

## 11. Phase I — Rewards (S35–S38)

### S35 — `RewardService.compute` — the pure policy function · 2.5 h · 🧪

**Goal:** the formula from [10](./10-economy-and-rewards.md) §3.1, as a pure function over
`RewardRule` rows, entirely outside the engine (P10).

**Needs:** S21, S06

**Build**
```
reward = round( base(gameSlug) × placement(rank, seatCount) × premiumMultiplier
                × integrityFactor × repeatDecay × durationFactor )
```
- `base` from the `RewardRule` row; `placement` from `placementJson`
  ([10](./10-economy-and-rewards.md) §3.3, incl. **losing still pays 0.5–0.7×**, draw 1.0)
- `integrityFactor` — **0 for every `EJECTED_*` outcome**, 0.5 for `REPLACED_RETURNED`, 1 for
  `COMPLETED`; bots never earn
- `repeatDecay` from §3.5 (1.0, 1.0, 0.6, 0.3, 0.1)
- `durationFactor` from §3.6 against `expectedMinMs`
- `premiumMultiplier` 1.5× for an active subscription, 1.0 otherwise
- `rewardEligible: false` on the table ⇒ 0 with a reason
- **Pure:** no I/O, no clock, no DB — takes a plain input record and returns
  `{ amount, factors, reason? }` so `game:rewardPreview` can explain itself

**Tests** — table-driven against the doc's own numbers:
- Shelem base 80, rank 1 of 4 → 1.5× → 120
- Every cell of the §3.3 placement table for 2 / 4 / 6 seats
- **Losing pays, never zero**
- `EJECTED_TIMEOUT` → 0 regardless of rank, **including rank 1**
- `REPLACED_RETURNED` → half
- Repeat decay curve exact
- `rewardEligible: false` → 0 with a reason
- Premium multiplies earning **and nothing else** (an E3 assertion: the returned object exposes no
  gameplay field)
- A property test: the result is never negative and never exceeds `base × 1.5 × 1.5`
- Purity: identical input → identical output, 1000 times, with no DB present

**You verify** 🧪
```bash
cd backend && npx vitest run tests/unit/rewards/compute.test.ts --reporter=verbose
```
Read the table-driven names — they're written to mirror
[10](./10-economy-and-rewards.md) §3.2–3.6 row for row, so you can check the doc against the test
list directly. The one to confirm: *rank 1 with EJECTED_TIMEOUT earns 0*.

**Done when**
- [ ] Every number matches [10](./10-economy-and-rewards.md) §3.2–3.6
- [ ] Ejected earns zero even at rank 1
- [ ] Losing still pays
- [ ] The function is pure — proven with no database in the test
- [ ] All factors come from `RewardRule` data, not constants in code

---

### S36 — ⭐ Settlement: per-seat, idempotent, with forfeiture · 3 h · 🧪

**Goal:** the exit criterion *an ejected player on a winning team earns 0; their partner earns
full* — from [03](./03-data-model.md) §6.4.

**Needs:** S35, S30

**Build**
One `uow.run` when a `GameInstance` reaches `FINISHED`, so a partially-paid match is impossible:
- create `MatchResult` from `engine.result(state)`
- **loop over `result.standings`** — per seat, not per team. This loop structure is what makes
  forfeiture fall out naturally instead of needing a special case
- for each: create `MatchParticipant`, resolve the holder (skip bots — they never earn), call
  `rewards.compute`, then `wallet.credit` with **`idempotencyKey: match:{matchResultId}:{seat}`**
- write back `coinsAwarded`, `rewardForfeited`, `rewardTxId`, `playedFraction`
- `game:rewardPreview` before settlement, `game:rewardSettled { coinsAwarded, forfeited, reason?, capped? }`
  per seat afterward — carrying the **reason**, so the post-match screen can state it plainly
- `PlayerStats` / `Rating` update in the same transaction
- Guest seats credit to their `PROVISIONAL` wallet

**Tests**
- **The headline case: a 4-seat partnership match where the winning team contains an ejected
  player ⇒ that seat gets 0 with `rewardForfeited: true` and a `CAP_REJECTED` row, and their
  partner gets the full team amount.** Exactly the rule you asked for
- Replaying settlement (worker restart, duplicated event) credits **nothing twice** — same key,
  same rows
- A throw mid-loop rolls back the whole match: no `MatchResult`, no partial credits
- Bots produce a `MatchParticipant` with no wallet transaction
- Guests credit `PROVISIONAL`
- Σ `coinsAwarded` across seats equals Σ of the matching ledger rows
- `rewardSettled` carries the forfeiture reason
- Every wallet's `balance == Σ transactions` after 50 randomized settled matches

**You verify** 🧪 — the concurrency and rollback parts genuinely need tests, but the main case is
also visible end to end:
```bash
cd backend && npx vitest run tests/integration/reward-settlement.test.ts --reporter=verbose
```
Then reproduce it by hand: run the S33 flow (go idle on seat 1, get ejected, let the bot finish the
match as the winning side), and in Studio check `MatchParticipant` — seat 1 has
`coinsAwarded: 0, rewardForfeited: true` on a **winning** team, and its partner has the full amount.
Check `WalletTransaction` for the matching `CAP_REJECTED` row explaining why.

**Done when**
- [ ] Ejected winner earns 0; partner earns full — verified in Studio, not just in a test
- [ ] Settlement is idempotent per seat
- [ ] A mid-loop failure rolls back the entire match
- [ ] The forfeiture reason reaches the player
- [ ] Ledger stays balanced across 50 randomized matches

---

### S37 — Wallet reads and `wallet:updated` · 2.5 h · 🌐

**Goal:** you can see your balance, your statement, and live updates as coins land.

**Needs:** S36

**Build**
- `GET /wallet` — balances per asset **plus vesting status**; guests included
  ([02](./02-technical-prd.md) §7)
- `GET /wallet/transactions` — paginated statement, user only, with `balanceAfter` on each row
- `GET /rewards/rules` — **public**. Transparency is deliberate
  ([10](./10-economy-and-rewards.md) §11)
- `wallet:updated { asset, vested, provisional, delta?, reason? }` emitted to `user:{id}` (or the
  socket, for guests) on every balance change
- Guest wallets report `provisional`; the response carries the copy hook for the signup nudge
  ("N coins waiting — create an account to keep them")

**Tests**
- `GET /wallet` for a user → vested; for a guest → provisional with `vested: 0`
- Statement pagination is stable and ordered; `balanceAfter` is consistent down the page
- `GET /wallet/transactions` as a guest → rejected (guests have no spendable statement)
- `wallet:updated` fires on credit with the right delta and reason
- `GET /rewards/rules` needs no auth and exposes rates without internal cap internals
- A `CAP_REJECTED` row appears in the statement with its reason — a capped reward is *visible*, not
  silent

**You verify** 🌐 + 🔌
```bash
curl -sb /tmp/c.txt localhost:3000/api/v1/wallet | jq
curl -sb /tmp/c.txt 'localhost:3000/api/v1/wallet/transactions?limit=10' | jq '.items[] | {kind, amount, balanceAfter, reason}'
curl -s localhost:3000/api/v1/rewards/rules | jq          # no cookie needed
curl -sb /tmp/g.txt localhost:3000/api/v1/wallet | jq     # → provisional, vested 0
```
With `dev-socket.ts` connected, run a settlement and watch `wallet:updated` arrive live.

**Done when**
- [ ] Guests see a provisional balance; users see vested
- [ ] The statement shows `CAP_REJECTED` rows with reasons
- [ ] `wallet:updated` arrives live on the socket
- [ ] `/rewards/rules` is public

---

### S38 — Debit path, guest forfeiture, nightly reconciliation · 3 h · 🧪

**Goal:** close the ledger's remaining paths, and make a corrupted balance **detectable** — the M0
exit criterion.

**Needs:** S37

**Build**
- The debit path from [10](./10-economy-and-rewards.md) §2.5: `balanceForUpdate` takes a **row
  lock** (`SELECT … FOR UPDATE` on Postgres; SQLite serializes writes), then append a negative row
  and bump the cache in one transaction. No store UI yet — M7 owns that; this is the primitive
- `assertPurchasable` rejects **guest holders outright** — no way to convert farmed provisional
  coins into anything before signing up
- `GUEST_FORFEIT` — a job expiring unvested provisional balances at guest-session end (12 h)
- **Nightly reconciliation:** recompute every balance from its transactions; on mismatch, write an
  `ALERT` `SecurityEvent` and log at `error` (E1)
- `ADMIN_ADJUST` with a mandatory reason

**Tests**
- **Two concurrent debits with exactly one item's worth of coins ⇒ exactly one succeeds.** The real
  double-spend test
- Insufficient funds → `InsufficientFundsError` and **no partial debit**
- A guest attempting to spend → rejected
- `GUEST_FORFEIT` zeroes an expired provisional wallet with a ledger row (never a silent wipe)
- Reconciliation over a clean ledger → no alerts
- **Deliberately corrupt `Wallet.balance` in the DB ⇒ reconciliation detects it and raises an
  `ALERT`.** The exit criterion, tested
- `ADMIN_ADJUST` without a reason → rejected

**You verify** 🧪 for the race, then 🖥️ for the good part:
```bash
cd backend && npx vitest run tests/integration/wallet-debit.test.ts tests/integration/reconciliation.test.ts --reporter=verbose

# then corrupt a balance by hand and watch the job catch it:
npx tsx scripts/dev-corrupt-balance.ts --user me@test.dev --set 999999
npx tsx scripts/dev-reconcile.ts
# → ALERT: wallet <id> cached 999999, computed <real>. And a SecurityEvent row in Studio.
```

**Done when**
- [ ] Concurrent debits: exactly one wins
- [ ] Guests cannot spend
- [ ] **A hand-corrupted balance is detected and alerted** — verified by you, by corrupting one
- [ ] `GUEST_FORFEIT` leaves a ledger row
- [ ] `ADMIN_ADJUST` requires a reason

---

## 12. Phase J — Frontend (S39–S44) and Phase K — Ship (S45–S47)

### S39 — Axios, single-flight refresh, `authStore`, login/register · 3 h · 🖱️

**Goal:** you can sign up and log in **in the browser**, and an expired access token refreshes
invisibly.

**Needs:** S14, S02, S03

**Build**
- `api/client.ts` — one configured Axios instance, `withCredentials: true`, base `/api/v1`
- **Single-flight refresh interceptor** ([06](./06-frontend-architecture.md) §4.1): on 401, one
  refresh call is made and *all* queued requests wait on the same promise. Five parallel 401s must
  not trigger five refreshes — which, given S14's family revocation, would log the user out
- `stores/authStore.ts` — `identity`, `status`, `bootstrap()`, `login()`, `logout()`
- `features/auth/` — login and register pages with `react-hook-form` + the **same Zod schemas from
  `contracts/`** the backend validates with
- `requireIdentity` / `requireUser` route loaders

**Tests**
- Unit: five concurrent 401s → **exactly one** refresh request (spy-asserted)
- Refresh failure → identity cleared, redirect to `/login`
- `bootstrap()` populates from `/auth/me`
- Form validation errors render from the shared schema; server `fieldErrors` map onto the right
  inputs
- Playwright: register → land authenticated → reload → **still authenticated** (cookie, not
  localStorage)

**You verify** 🖱️
Open `localhost:5173/register`, create an account, and confirm you land authenticated. **Reload** —
still signed in. Open DevTools → Application → Cookies: the tokens are `httpOnly` and there is
**nothing** in localStorage. Then, in the Network tab, throttle and fire several requests at once
after the access token expires: you should see exactly one `/auth/refresh`.

**Done when**
- [ ] Register and login work in the browser
- [ ] Session survives a reload; tokens are httpOnly, nothing in localStorage
- [ ] Concurrent 401s trigger exactly one refresh
- [ ] Validation messages come from the shared Zod schemas

---

### S40 — `tokens.css`, `themeStore`, i18n, RTL · 3 h · 🖱️

**Goal:** the app switches to Persian **and flips to RTL** properly — treated as correctness, not
polish.

**Needs:** S39

**Build**
- `styles/tokens.css` — the CSS custom properties that *are* the theming system
  ([06](./06-frontend-architecture.md) §6.1); light/dark theme files
- `stores/themeStore.ts` — locale, `dir`, theme, numerals, cosmetic selections; a
  `subscribeWithSelector` subscriber that sets **both `<html lang>` and `<html dir>`** on change
- `react-i18next` with the namespaces `common`, `auth`, `table`, `errors` in `en` **and** `fa`
- Locale precedence `?lng=` → DB preference → localStorage → `navigator.language` → `en`
- `Vazirmatn` subset with `font-display: swap` and a real fallback stack
- Persian-Indic numerals as a preference, defaulting on for `fa`; Jalali dates via
  `Intl.DateTimeFormat`
- Error rendering: take `i18nKey` + `details` from the API and localize **client-side** — the API
  never sends English prose
- `GET/PUT /me/preferences` wired (guests → localStorage only)

**Tests**
- Switching locale sets `lang` and `dir` on `<html>`
- Every `en` key has a `fa` counterpart — a test that **fails on a missing translation**, so
  Persian can't silently rot
- An API error renders localized from its `i18nKey`
- Persian numerals render when enabled; ids and internal codes **never** convert
- A stylelint run over all CSS proves no physical properties (`margin-left`, `right`, …)

**You verify** 🖱️
Open the app, switch to فارسی. The whole layout must mirror: nav, forms, buttons, spacing. Check
`<html dir="rtl" lang="fa">` in DevTools. Reload — the choice persists. Trigger a validation error
in both locales and confirm both are translated. Then run `npm run lint:css` and confirm zero
physical-property violations.

**Done when**
- [ ] `fa` flips `dir` and mirrors the layout with no clipping
- [ ] The missing-translation test fails when you delete a `fa` key (try it)
- [ ] API errors render localized from `i18nKey`
- [ ] Persian numerals apply to display only
- [ ] Stylelint clean

---

### S41 — Welcome page, registry-driven · 2.5 h · 🖱️

**Goal:** the M0 exit criterion — the welcome page renders its cards from
`GET /api/v1/games`, with all five games "Coming soon".

**Needs:** S40, S17

**Build**
- `features/welcome/` — preview cards from the registry: name, tagline, complexity, avg minutes,
  art, player counts, hidden-info and standard-deck badges. **All text from i18n keys**
- `comingSoon` state; a "N playing now" slot fed by `/matchmaking/presets` in M3 (a placeholder now)
- Loading skeletons, an error state, and an empty state
- Responsive grid; keyboard-navigable cards; `/games/:slug` detail page

**Tests**
- Cards render from a mocked `/games` response — **add a sixth game to the mock and it appears with
  no component change.** That's P5 proven on the client
- Every card's text comes from i18n (no hard-coded English in the component)
- Loading, error, and empty states render
- Playwright: the page loads against the real API and shows five cards
- Cards are reachable and activatable by keyboard

**You verify** 🖱️
Open `localhost:5173/`. Five cards, all marked Coming soon, all localized when you switch to `fa`.
Then — the real test — add a fake sixth game to `registry.ts`, restart the backend, and **refresh
the browser**: a sixth card appears with no frontend change at all.

**Done when**
- [ ] Cards render from the API, not a hard-coded list
- [ ] A new backend game appears without touching frontend code
- [ ] All text localized; RTL correct
- [ ] Loading/error/empty states present
- [ ] Keyboard navigable

---

### S42 — `socketStore`, socket manager, `seq` gap detection · 3 h · 🖱️

**Goal:** the client's socket discipline from [06](./06-frontend-architecture.md) §4.2 — one
connection, typed events, and correct recovery when it falls behind.

**Needs:** S39, S24

**Build**
- `socket/manager.ts` — **exactly one** connection for the app's lifetime, typed emit/on wrappers
  over the mirrored `contracts/events.ts`, reconnection config per
  [04](./04-realtime-protocol.md) §1.2
- `stores/socketStore.ts` — connection lifecycle, `lastSeq` per game, server-time offset measured
  at handshake
- Gap detection: `seq > lastSeq + 1` → emit `game:requestSync`, show a brief "syncing…" state;
  `seq <= lastSeq` → **drop silently**
- `stores/tableStore.ts`, `stores/chatStore.ts`, `stores/gameStore.ts` — `gameStore` holds the
  server's projection **verbatim**
- **No optimistic game updates** ([06](./06-frontend-architecture.md) §4.3) — a rejected
  optimistic card play is worse than 80 ms of latency
- `protocolVersion` mismatch → a "please refresh" banner

**Tests**
- Exactly one socket instance across mounts/unmounts and route changes
- A skipped `seq` triggers `requestSync`; a stale one is dropped
- The countdown renders from `endsAt` + server offset, **correct even with the client clock set
  wrong** (fake a skewed clock in the test)
- Reconnect re-joins rooms and resyncs
- `gameStore` never mutates the projection locally — an assertion that there is no client-side
  state derivation
- Version mismatch shows the banner

**You verify** 🖱️
Open the table page in two browser tabs. In DevTools → Network → WS, confirm **one** socket per tab.
Set your OS clock 10 minutes ahead — the turn countdown must still be right (this is why deadlines
are absolute and offsets are measured). Then toggle offline/online in DevTools and watch it
reconnect and resync.

**Done when**
- [ ] One socket per tab, surviving route changes
- [ ] Gap detection requests sync; stale messages dropped
- [ ] The countdown is correct with a deliberately wrong system clock
- [ ] No optimistic game state anywhere
- [ ] Reconnect resyncs cleanly

---

### S43 — ⭐ Invite landing and guest join · 3 h · 🖱️

**Goal:** journeys J1→J2 in the browser — *link click to seated in under 5 seconds, with no
account*. [06](./06-frontend-architecture.md) §2.1 calls this the highest-stakes screen and it is.

**Needs:** S42, S19, S16, S22

**Build**
- `/t/:inviteCode` — **public, no auth loader**. Resolves via `GET /invites/:code` and shows game,
  host, seats free, and whether it's in progress
- A name field and a single "Join" button → `POST /auth/guest` → navigate to `/table/:tableId`.
  **No signup wall, ever** (P6)
- A returning-guest path (existing valid guest cookie → straight in) and a signed-in-user path
- States handled properly: expired/revoked (same message, so codes can't be probed), table full,
  game in progress, `requireApproval` pending
- The **signup nudge** — a dismissible prompt, suggestion not gate, that surfaces the guest's
  provisional coin balance ("120 coins waiting — create an account to keep them")
- The claim form calling `POST /auth/guest/claim` and **navigating to the server-returned
  `redirectTo`**

**Tests**
- Playwright, the **full J2 journey**: host creates a table and copies a link → a second browser
  context (a real private session) opens it, types a name, is seated with no account → both see
  each other → the guest reloads and keeps their seat → the guest signs up → **lands back at the
  same table, in the same seat, with its coins vested**
- Every error state renders with a useful next action
- Expired and unknown codes are indistinguishable in the UI
- The nudge is dismissible and stays dismissed
- Time from click to seated measured under 5 s locally ([02](./02-technical-prd.md) §12)

**You verify** 🖱️ — this is the session to do carefully, because it's the product promise:
1. Sign in as yourself, create a table, copy the invite link.
2. Open a **private window**, paste the link. Type "Sara". Click Join.
3. You are seated. **No account was created.** Confirm both windows show each other.
4. Reload the private window — Sara keeps her seat.
5. Chat both ways.
6. In the private window, use the signup nudge to create an account.
7. **You land back at the same table, in the same seat**, and the coin balance is now vested.

**Done when**
- [ ] A private-window guest is seated from a link with no account
- [ ] Reload preserves the seat
- [ ] Signup lands back at the same table in the same seat with coins vested
- [ ] All error states useful; expired and unknown codes indistinguishable
- [ ] Click-to-seated under 5 s
- [ ] RTL reviewed in `fa`

---

### S44 — `TableShell` — seats, presence, chat, countdown, nudge · 3 h · 🖱️

**Goal:** the shared table shell every game will render inside
([06](./06-frontend-architecture.md) §5.1) — built once, reused by all five games.

**Needs:** S43, S32

**Build**
- `features/table/TableShell` — seat map (occupant, avatar, name, team, bot badge), host controls,
  options panel, chat panel, presence badges ("reconnecting… 0:58"), a **turn countdown ring**
  driven by `endsAt`, and the ejection warning toast
- Seat layout **mirrors under RTL**; the game surface is a slot the per-game renderer fills
- Ejection/reclaim UI: "You were removed — a bot is playing your seat. Reclaim (1:47)"
- The reward summary panel showing the breakdown from `game:rewardSettled`, **including forfeiture
  messaging that says plainly why the amount was zero**
- Accessibility: seat changes and turn changes announced via `aria-live`; fully keyboard operable

**Tests**
- Seat map renders all occupant kinds (user, guest, bot, empty, spectator)
- Presence badge counts down from `graceEndsAt`
- The countdown ring matches `endsAt`; the warning toast appears at `warningSeconds`
- The ejection panel appears with a live reclaim countdown, and reclaiming restores control
- Reward summary shows a zero with its reason
- RTL: the seat layout mirrors
- `aria-live` announcements fire on seat and turn changes
- Playwright: the S33 ejection flow **as seen in the browser** — warned, struck, ejected, bot plays
  on, reclaim offered

**You verify** 🖱️
Two browser windows at one table. Watch the countdown ring on the active seat. Go idle and watch:
the warning toast at 10 s, a strike, a second strike, then the ejection panel with its reclaim
timer — while the other window shows the bot playing on. Click Reclaim and get your seat back.
Close one window entirely and watch the other show "reconnecting…". Switch to `fa` and confirm the
seats mirror.

**Done when**
- [ ] Seat map, presence, chat, and countdown all correct and live
- [ ] The full ejection→bot→reclaim cycle is visible and usable in the browser
- [ ] Forfeiture is explained in plain language, not silent
- [ ] Layout mirrors in `fa` with no clipping
- [ ] Screen-reader announcements present; keyboard operable

---

### S45 — Dockerfiles, dev compose, CI · 3 h · 🖥️

**Goal:** both projects build in containers and both CI pipelines are green.

**Needs:** S44

**Build**
- Multi-stage Dockerfiles for `api` and `web`, `node:22-alpine`, **non-root user**, healthchecks
- `docker-compose.yml` (dev): `api`, `web`, `postgres`, `redis` — so you can develop against
  Postgres before deploying to it
- Two GitHub Actions workflows, one per project:
  install → **`contracts:check`** → typecheck → lint → test → build
- Frontend additionally runs Playwright against a compose-spun-up stack on PRs to `main`
- Coverage thresholds enforced in CI: **≥90% branch on `domain/games/**`**, ≥80% on services
  ([02](./02-technical-prd.md) §10)

**Tests**
- Both images build clean and run as non-root (assert the container's UID)
- `docker compose up` brings up a working stack; `/ready` returns 200
- **The API works against Postgres**, not just SQLite — the same test suite, `DATABASE_PROVIDER=postgresql`
- CI fails on drifted contracts, a type error, a lint error, a failing test, and on
  under-threshold coverage (verify each by pushing a deliberate break to a scratch branch)

**You verify** 🖥️
```bash
docker compose build && docker compose up -d
curl -si localhost:3000/ready | head -1        # → 200, running on Postgres
docker compose exec api id                     # → non-root
docker compose exec api npm test               # suite green against Postgres
```
Then push a branch with a deliberately broken contract and confirm CI goes red for the right reason.

**Done when**
- [ ] Both images build and run non-root
- [ ] The full suite passes **against Postgres**, not only SQLite
- [ ] Both CI pipelines green, and provably red on drift/type/lint/test/coverage failures

---

### S46 — Prod compose, Caddy, migrations, VPS deploy · 3 h · 🌐

**Goal:** it's on the internet over HTTPS, with sockets working through the proxy.

**Needs:** S45

**Build**
- `docker-compose.prod.yml`: `caddy`, `web`, `api`, `postgres`, `redis`, and **`migrate` as a
  one-shot container that runs before the api** (`depends_on: postgres: service_healthy`) — so a
  failed migration doesn't crash-loop the app ([02](./02-technical-prd.md) §6.3)
- `Caddyfile` — auto-TLS, `reverse_proxy api:3000` for `/api` and `/socket.io`. Caddy handles
  `Upgrade` transparently, but this is **the #1 first-deploy failure for socket apps**, so it gets
  its own verification step below
- Postgres-only `prisma/migrations/` generated against a real Postgres
  ([03](./03-data-model.md) §8: `db push` for dev, real migrations for Postgres only)
- Secrets from a `.env` on the VPS; `.env.example` committed
- Nightly `pg_dump` to a mounted volume, plus a weekly off-box copy
- Modest pool (`connection_limit=10`) — this app is socket-heavy, not query-heavy

**Tests**
- `prisma migrate deploy` applies cleanly to an empty Postgres, and is a no-op on a second run
- A deliberately failing migration **stops the api from starting** rather than half-migrating
- A smoke suite against the deployed URL: `/health`, `/ready`, register, create table, **socket
  connect and a chat round-trip over WSS**
- The backup cron produces a non-empty dump

**You verify** 🌐 — against your real domain:
```bash
curl -si https://<your-domain>/api/v1/health | head -1
curl -s https://<your-domain>/api/v1/games | jq length
```
Then open the site in a browser, sign up, create a table, and **chat between two devices** (phone +
laptop). Watch DevTools → Network → WS: the socket must be connected over `wss://`, not falling back
to polling. Confirm the TLS cert is valid and that `docker compose logs migrate` shows the migration
ran once, before the api.

**Done when**
- [ ] The site is live over HTTPS with a valid certificate
- [ ] **Sockets work over WSS through Caddy** — verified in DevTools, not assumed
- [ ] Migrations run in a one-shot container before the api
- [ ] A failed migration blocks startup instead of half-applying
- [ ] The nightly dump exists and is non-empty

---

### S47 — ⭐ M0 exit-criteria walkthrough and a tested restore · 3 h · 🖱️

**Goal:** walk [08-roadmap.md](./08-roadmap.md) M0's exit criteria one by one, on the deployed app,
and tick every box — or write down what's left.

**Needs:** S46

**Build**
- Nothing new. This session is verification and cleanup only
- A `docs/runbook.md` capturing the deploy, restore, and rollback procedures **as actually
  performed**, not as imagined
- Fix whatever the walkthrough uncovers; anything too big becomes an explicit S48+ session rather
  than a silent carry-forward

**The walkthrough** — [08-roadmap.md](./08-roadmap.md) M0, in order:
- [ ] Host signs up, creates a table, copies an invite link
- [ ] Friend opens the link in a private window, types a name, is seated — **no account created**
- [ ] Both see each other join live; chat works both ways
- [ ] Guest refreshes and keeps their seat
- [ ] **Guest signs up mid-session and lands back at the same table in the same seat** (J2)
- [ ] **The guest's provisional coins vest into the new account in the same transaction**
- [ ] **An idle player is warned, struck twice, ejected, replaced by a bot** — the table plays on
- [ ] **An ejected player on a winning team earns 0; their partner earns full** (J5)
- [ ] Ledger reconciliation runs clean; a deliberately corrupted balance is detected and alerted
- [ ] Killing and restarting the API loses neither the table nor anyone's seat, **and turn
      deadlines re-arm without gifting time**
- [ ] Welcome page renders cards from `GET /api/v1/games`
- [ ] Every screen reviewed in `fa`/RTL — nothing clipped or wrongly mirrored
- [ ] `contracts:check` green in both CI pipelines
- [ ] Deployed over HTTPS, **with the restore-from-backup procedure actually tested once**

**You verify** 🖱️ — the last one deserves emphasis, because it's the one everybody skips:
```bash
# On the VPS, with a real backup in hand:
docker compose -f docker-compose.prod.yml stop api
pg_dump ... > /tmp/pre-restore.sql          # safety net first
dropdb boardgames && createdb boardgames
psql boardgames < /backups/<last-nightly>.sql
docker compose -f docker-compose.prod.yml start api
```
Then open the site and confirm your account, tables, and wallet balance are all there. A backup you
have never restored is not a backup.

**Done when**
- [ ] Every M0 exit criterion above is ticked, or listed in `context.md` as an explicit S51+ session
- [ ] The restore procedure has been **performed**, and `docs/runbook.md` describes what you
      actually did
- [ ] The two **admin** exit criteria are deferred to S50 — M0 is not closed until S50 is green

---

## 13. Phase L — Admin Spine (S48–S50)

The backend-only slice of [12-admin-console.md](./12-admin-console.md), per its §11.1. No UI here;
everything is verified with `curl` and `backend/requests/admin.http`.

---

### S48 — Admin schema, `admin-main.ts`, and the three isolation guards · 3 h · 🖥️

**Goal:** a second process boots on `:3100` serving nothing but `/health`, and `:3000` provably
cannot serve an admin route — before a single admin endpoint exists.

**Needs:** S46

**Build**
- Schema: `User.role` widened to `'USER' | 'SUPPORT' | 'ADMIN'`; `User.status` + `statusReason` +
  `statusChangedAt` + `statusChangedBy`; the seven new models from
  [12](./12-admin-console.md) §4 — `AdminCredential`, `AdminSession`, `AdminAuditLog`, `GameFlag`,
  `PlatformFlag`, `ControlCommand`, `DailyMetric`. `db push` + seed additions ([03](./03-data-model.md) §9)
- `src/admin-app.ts` and `src/admin-main.ts` — Express app mounting only `src/interface/admin/**`,
  built from the **same `container.ts`**; `GET /health` and nothing else
- Env additions, Zod-validated: `ADMIN_PORT`, `ADMIN_BIND`, `ADMIN_ORIGIN`, `ADMIN_TOTP_ENC_KEY`,
  `ADMIN_SESSION_*`, `ADMIN_STEPUP_WINDOW_MIN`, `ADMIN_IP_ALLOWLIST`, `CONTROL_TRANSPORT`.
  **The admin process refuses to boot without `ADMIN_TOTP_ENC_KEY`**
- **Guard 1** — ESLint `overrides` on `src/app.ts`, `src/main.ts`, `src/interface/http/**`,
  `src/interface/socket/**` banning `**/interface/admin/**`
- **Guard 2** — a boot-time assertion in `app.ts` that walks the router stack and throws if any
  mounted path matches `/admin`
- **Guard 3** — the integration test below
- `npm run dev:admin`; `admin-api` service in both compose files with **no `ports:` entry**

**Tests**
- `GET :3000/admin/api/v1/anything` → **404**; `GET :3100/health` → 200
- The boot assertion throws when a deliberately-mounted admin router is added to `app.ts`
- Admin process exits non-zero with a clear message when `ADMIN_TOTP_ENC_KEY` is absent
- Seed is idempotent with the new rows; `GameFlag` has one `ENABLED` row per registry slug

**You verify** 🖥️
```bash
# deliberate violations — each must FAIL, like S01's lint proof:
echo "import './interface/admin/routes'" >> src/app.ts && npx eslint src/app.ts; git checkout src/app.ts
ADMIN_TOTP_ENC_KEY= npm run dev:admin        # → refuses to boot, names the var

npm run dev & npm run dev:admin &
curl -si localhost:3000/admin/api/v1/x | head -1     # → 404
curl -si localhost:3100/health         | head -1     # → 200
docker compose -f docker-compose.prod.yml config | rg -A3 'admin-api:' | rg ports  # → no match
```

**Done when**
- [ ] Both guards fire on a deliberate violation (you ran the commands and saw them fail)
- [ ] `:3000/admin/*` is 404 and `:3100` is up
- [ ] `admin-api` has no published port in either compose file
- [ ] `npx prisma studio` shows the seven new tables and the seeded flags

---

### S49 — Admin auth: TOTP, forced enrollment, step-up · 3 h · 🌐

**Goal:** you can log into `:3100` with your seeded admin account, and you cannot do it without a
code from your phone.

**Needs:** S48, S14

**Build**
- `AdminAuthService`: two-step login ([12](./12-admin-console.md) §3.3) — `POST /auth/login`
  returns `{ challengeId, ttlSec, enrollmentRequired? }`, `POST /auth/mfa` verifies and issues
  `admin_access` / `admin_refresh` cookies scoped to `Path=/admin`, `SameSite=Strict`
- `infrastructure/admin/totp.ts` — RFC 6238, 30 s step, ±1 window; secrets **AES-256-GCM encrypted**
  under `ADMIN_TOTP_ENC_KEY`; `lastTotpStep` replay guard; 10 hashed single-use recovery codes
- `POST /auth/totp/enroll` — the **only** route reachable by an unenrolled admin, returns the
  `otpauth://` URI and the recovery codes exactly once
- `AdminSession` lifecycle: IP-pinned, 15 min access, 8 h absolute, 30 min idle; refresh rotation
- Middleware: `ipAllowlist`, `adminAuthenticate`, `requireRole`, `requireStepUp`
- `POST /auth/stepup`, `POST /auth/logout`, `GET /auth/me`
- Lockout: 5 failed codes → 15 min, plus a `SecurityEvent`
- The six error classes from [12](./12-admin-console.md) §5.1
- **Move S15's routes here:** `GET /metrics` and `GET /security-events` on the admin process

**Tests**
- Correct password + wrong code → 401, no session; correct code → session
- **The same code twice → the second is rejected** (replay guard)
- Unenrolled admin: every route except `/auth/totp/enroll` → `MFA_ENROLLMENT_REQUIRED`
- `role: 'USER'` with correct credentials → 401 at the password step
- A session presented from a different IP → revoked, not refreshed
- 5 bad codes → `ADMIN_LOCKED` + a `SecurityEvent` row
- A route marked ⚡ with `mfaAt` older than the window → `STEP_UP_REQUIRED`, **and no state change**
- The TOTP secret column never contains a base32 secret in plaintext

**You verify** 🌐 — `backend/requests/admin.http`, plus a real authenticator app:
```bash
curl -sc /tmp/a.txt -X POST localhost:3100/admin/api/v1/auth/login \
  -d '{"email":"'$SEED_ADMIN_EMAIL'","password":"'$SEED_ADMIN_PASSWORD'"}' \
  -H 'content-type: application/json' | jq          # → { enrollmentRequired: true, challengeId }
# enroll, scan the QR/URI into your phone, save the recovery codes, then log in for real
curl -sb /tmp/a.txt -X POST localhost:3100/admin/api/v1/auth/mfa \
  -d '{"challengeId":"...","code":"123456"}' -H 'content-type: application/json' -i | head -1
```

**Done when**
- [ ] You logged in with a code from your own phone, and the same code was rejected on reuse
- [ ] A fresh admin can reach nothing but the enrollment route
- [ ] `npx prisma studio` shows `totpSecretEnc` as ciphertext, not a readable secret
- [ ] `/metrics` and `/security-events` answer on `:3100` and 404 on `:3000`

---

### S50 — ⭐ The `withAudit` spine, first read endpoints, and M0's admin gate · 3 h · 🌐

**Goal:** the rule that every admin mutation carries an audit row written in the same transaction
exists **and is enforced by a test that fails when a future endpoint forgets it**.

**Needs:** S49

**Build**
- `infrastructure/admin/auditUow.ts` — the `withAudit(ctx, action, target, fn)` wrapper from
  [12](./12-admin-console.md) §3.5, appending an `AdminAuditLog` row inside the caller's transaction
- The hash chain: `hash = sha256(prevHash + canonical row)`; `GET /audit/verify` walks it and
  reports the first break
- `auditContext` middleware populating actor, IP, user agent, `requestId`, and `reason`
- **The route manifest** — a single exported array declaring every admin route with
  `{ method, path, role, mutating, requiresStepUp, requiresReason }`. The router is built *from* it,
  so the manifest cannot drift from reality
- Read endpoints: `GET /users` (cursor-paginated search), `GET /users/:id`, `GET /audit`
- One mutating endpoint to prove the spine end to end: `POST /users/:id/disable` — status change,
  refresh-family revocation, socket disconnect, seat release **with no reward forfeiture** (A8)
- `AdminAuditLog` is append-only in code: no update or delete method exists on its repository, and
  the Postgres migration adds `REVOKE UPDATE, DELETE ON "AdminAuditLog"` from the app role

**Tests**
- **Audit-completeness, manifest-driven:** every route with `mutating: true` is exercised and must
  produce exactly one `AdminAuditLog` row. *Add a mutating route without the wrapper → this fails*
- **RBAC matrix, manifest-driven:** `SUPPORT` against every `ADMIN`-only route → 403
- **Reason enforcement:** every `requiresReason` route without a reason → `REASON_REQUIRED`, no row
- Disabling a seated player releases the seat, substitutes a bot, and **settles rewards for
  completed hands with no forfeiture**
- Deleting an audit row directly in SQL → `GET /audit/verify` reports the break at the right index
- The audit repository has no `update` or `delete` method (asserted structurally)

**You verify** 🌐
```bash
# with a friend (or a second browser) seated at a fixture table:
curl -sb /tmp/a.txt -X POST localhost:3100/admin/api/v1/users/$UID/disable \
  -H 'content-type: application/json' -d '{}' -i | head -1        # → 400 REASON_REQUIRED
curl -sb /tmp/a.txt -X POST localhost:3100/admin/api/v1/users/$UID/disable \
  -H 'content-type: application/json' -d '{"reason":"testing the spine"}'
# → their socket drops, the seat is bot-filled, the table plays on
curl -sb /tmp/a.txt 'localhost:3100/admin/api/v1/audit?limit=1' | jq '.items[0]'
# → actor, ip, reason, beforeJson/afterJson all populated
sqlite3 dev.db "DELETE FROM AdminAuditLog WHERE id=(SELECT id FROM AdminAuditLog LIMIT 1 OFFSET 1)"
curl -sb /tmp/a.txt localhost:3100/admin/api/v1/audit/verify | jq   # → break reported
```

**Done when**
- [ ] The manifest-driven audit test fails when you deliberately drop the wrapper from one route
- [ ] Disabling a live player cost them **nothing** — you checked the ledger
- [ ] `/audit/verify` caught the row you deleted by hand
- [ ] **M0's two admin exit criteria are ticked**, and with them M0 is closed
- [ ] `Documents/README.md`'s Status table updated to mark M0 implemented

---

## 14. M1–M8 and MA Outlines

Session titles only. Each milestone gets expanded into full session specs (the six-field format
above) in a planning pass at its start — one session's worth of work, listed as the first session of
each milestone. **MA** sits between M7 and M8; the letter avoids renumbering M8.

### M1 — Sudoku (~11 sessions)
`M1-S01` M1 planning pass · `S02` puzzle generation + uniqueness proof · `S03` difficulty grading ·
`S04` engine: state, `legalMoves`, `applyMove` · `S05` **server-withheld solution + projection** ·
`S06` validate/hint moves + `isTerminal`/`result` · `S07` engine invariant suite I1–I5 ·
`S08` renderer + keyboard grid nav + `dir="ltr"` island · `S09` race mode (2–4 players) ·
`S10` bot + timeout default action + reward wiring · `S11` RTL review, Persian numerals, exit
criteria

### M2 — Blackjack (~15 sessions)
`M2-S01` planning pass · `S02` deck/shoe value objects + penetration · `S03` **seed-commitment
protocol end to end + "deal verified" UI** · `S04` betting-round core (`shared/betting.ts`,
reused by Poker) · `S05` engine: deal, hit/stand · `S06` double/split · `S07` insurance/surrender +
payout table · `S08` dealer as a virtual seat via `advance()` + soft-17 · `S09` **hole card &
shoe projection leak tests** · `S10` basic-strategy bot · `S11` card components + deal/flip
animations · `S12` turn timers + auto-**stand** (never hit) · `S13` disconnect grace + mid-hand
resync · `S14` RTL review + exit criteria · `S15` **admin: cursor-paginated ledger browser, wallet
detail with cached-vs-derived, reconciliation endpoint + nightly job**
([12](./12-admin-console.md) §7.2)

### M3 — Matchmaking (~17 sessions)
`M3-S01` planning pass · `S02` Redis pool structure + ticket lifecycle · `S03` the 1 s matcher tick
+ oldest-first fairness · `S04` atomic table formation + rollback · `S05` presets in `GameMeta` for
Sudoku + Blackjack · `S06` **120 s timeout release + the suggestion payload** · `S07` the release
screen (a primary surface, not an error path) · `S08` bot fill after `preferHumansMs` ·
`S09` auto-start countdown for matchmade tables · `S10` parties · `S11` **farming guards**: per-IP,
per-fingerprint, all-guest ⇒ `rewardEligible: false` · `S12` **ejection cooldown ladder**,
persisted · `S13` repeat-pairing decay · `S14` stranger safety: name/avatar limits, mute, block,
report · `S15` `matchmakingStore` + queue picker + queue pill · `S16` restart-while-queued, matcher
perf (<50 ms @ 200 tickets), exit criteria · `S17` **admin: `GameFlag` three-state control,
`PlatformFlag` + maintenance mode, the `ControlCommand` outbox and its consumer, queue/cooldown
visibility** ([12](./12-admin-console.md) §6, §7.3)

### M4 — Shelem ⭐ (~26 sessions)
`M4-S01` planning pass + resolve the six open parameters in `games/shelem.md` §0.4 ·
`S02–S04` trick-taking core (`shared/trick.ts`): follow-suit legality, resolution, rank orders,
partnership model · `S05` phase machine — **no `TRUMP_SELECTION` state** · `S06–S07` bidding
(min 100, multiples of 5, pass is final, Shelem declaration) · `S08–S09` widow exchange + **the 4
discards count as the declaring team's first scoring trick** · `S10` **trump established by the
declarer's opening lead** · `S11–S12` 12 tricks of play · `S13–S15` **two-component scoring to
exactly 165** · `S16` contract made/set, doubling, Shelem = 330 · `S17` scoring variants as table
options · `S18` multi-hand match flow + between-hands scoreboard · `S19` invariant + leak suite ·
`S20–S22` renderer: bid panel, trick area, scoreboard, partner indicator · `S23` Persian card face
set · `S24` complete `fa` terminology · `S25` bot (legal-random, then heuristics) ·
`S26` **play a full match with your group and agree the scoring is right** + exit criteria

### M5 — Poker (~21 sessions)
`M5-S01` planning pass · `S02–S04` 7-card hand evaluator + kickers, checked against a reference over
100k hands · `S05` blinds + button rotation + heads-up exception · `S06–S08` streets and betting
actions + min-raise rules · `S09–S11` **side-pot construction, specified and unit-tested before any
UI** · `S12` showdown ordering, split pots, odd chips · `S13` chip conservation property test ·
`S14` **E5 audit: chips never touch the wallet** · `S15` auto-**fold** on timeout (never call) +
time bank · `S16` leak tests: hole cards, folded hands · `S17–S19` renderer: pot, bet slider,
actions, all-in viz · `S20` bot · `S21` RTL + exit criteria

### M6 — Chess (~13 sessions)
`M6-S01` planning pass · `S02` `chess.js` adapter behind `GameEngine` · `S03` special moves ·
`S04` draw conditions · `S05–S06` server-authoritative clocks + flag-fall + restart survival ·
`S07` resign / draw offer / takeback · `S08–S09` board renderer: drag + click, server-supplied
legal-move highlights · `S10` **`dir="ltr"` island — a1 stays bottom-left in `fa`** · `S11` PGN
export · `S12` bot · `S13` RTL review (chrome mirrors, board doesn't) + exit criteria

### M7 — Store & Premium ⭐ (~21 sessions)
`M7-S01` planning pass · `S02–S03` `StoreService` + catalog states + **row-locked purchase
transaction** · `S04` refunds · `S05–S07` priced cosmetics across all eight categories for five
games · `S08` rotating featured selection · `S09` coin sinks: consumables, rentals, name-change ·
`S10–S12` `SubscriptionService` + Stripe + checkout + cancel-at-period-end + grace + lapse ·
`S13` **entitlements: 1.5× earn, raised caps, premium cosmetics — and nothing else** ·
`S14` **the E3 audit gate: every perk checked against the never-sell list** · `S15` webhooks:
signature verification + idempotency by provider event id · `S16` transparency: public
`/rewards/rules` + post-match breakdown · `S17–S19` frontend: `walletStore`, store, purchase flow,
premium landing, statement · `S20` legal: terms, refunds, age gate, VAT · `S21` reconciliation over
a week of real purchasing + exit criteria

### MA — Admin Console (~16 sessions)

Sits between M7 and M8. The backend spine already exists from M0/M2/M3; MA gives it a face and
finishes the capability set. Full spec: [12-admin-console.md](./12-admin-console.md) §11.2.

`MA-S01` planning pass · `S02` `admin-frontend/` scaffold, third CI pipeline, contract mirror,
Caddy `admin.` host · `S03` auth UI: login, MFA, **first-run TOTP enrollment with QR + recovery
codes**, step-up modal · `S04` `DataTable` (cursor-only), `ReasonDialog`, `ConfirmDestructive`,
the `STEP_UP_REQUIRED` interceptor · `S05` user search + the detail page · `S06` moderation
actions: disable/enable/ban, force-logout, name reset, password reset, role changes ·
`S07` report queue + resolution · `S08` ledger browser UI + wallet detail + reconciliation view ·
`S09` **`ADMIN_ADJUST` flow with step-up, mandatory reason, and the daily mint ceiling** ·
`S10` coin-supply charts incl. admin-minted share; reward-rule and store-item editing ·
`S11` game state control + platform flags + maintenance + broadcast · `S12` live table list,
**spectator-projection table view (A5)**, close-table, kick-seat · `S13` matchmaking queue and
cooldown panel · `S14` `DailyMetric` rollup job + dashboard tiles + trend charts across the six
metric groups · `S15` SSE live feed + audit browser + hash-chain verification ·
`S16` **the full 15-test admin suite** ([12](./12-admin-console.md) §10), incident runbook, exit
criteria

### M8 — Social, Stats & Cosmetics (~21 sessions)
`M8-S01` planning pass · `S02–S03` spectator rooms + per-game spectator projections +
**leak tests across all five games** · `S04` spectator UI + host toggle · `S05` emotes + rate
limits · `S06–S07` `PlayerStats` aggregation + profile screen · `S08–S09` ELO service + `RatingChange`
+ post-match delta + leaderboards · `S10` match history + summary + deal-verification panel ·
`S11–S14` **the customization page**: card backs, faces, felts, avatars + upload, theme, animation
speed, sound, language, live preview, owned/unlockable/purchasable wired to M7 ·
`S15` avatar upload hardening against every hostile fixture in
[07](./07-security-and-anticheat.md) §6 · `S16` achievements + idempotent grants ·
`S17` **Persian completion: every game's `fa` namespace, Jalali dates, full RTL pass** ·
`S18` bot improvements for Shelem and Poker · `S19` sound + deal animations + empty/error states ·
`S20` mobile layout pass across all five games · `S21` Lighthouse ≥90 perf + a11y, exit criteria

---

## Related Documents

- [08-roadmap.md](./08-roadmap.md) — the milestone layer above this one, and the authority on scope
- [02-technical-prd.md](./02-technical-prd.md) — the architecture every session builds
- [05-game-engine-spec.md](./05-game-engine-spec.md) §7 — the per-game checklist each game
  milestone's final session runs
- [12-admin-console.md](./12-admin-console.md) — Phase L (S48–S50), the M2/M3 increments, and MA
- `.claude/context/build/context.md` — the live cursor: where we actually are right now
