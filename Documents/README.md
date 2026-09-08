# Board Game Platform — Documentation

A web app for playing board and card games. Express + React, with all game rules enforced
server-side, real-time play over WebSocket, invite links that let friends play **without creating
an account**, **matchmaking** for when nobody's around, and an **earned coin economy** with a
**premium plan**.

**Read this first:** [01-business-prd.md](./01-business-prd.md) for *why and for whom*, then
[02-technical-prd.md](./02-technical-prd.md) for *how*. Everything else elaborates one part of
those two. If two documents disagree, the technical PRD wins and the other should be corrected.

---

## Documents

| Document | What | When to read it |
|---|---|---|
| [01-business-prd.md](./01-business-prd.md) | Vision, personas, the five user journeys, game catalog, feature scope, success metrics, risks | Before any implementation decision. Re-read when tempted to add scope |
| [02-technical-prd.md](./02-technical-prd.md) | **The architectural spine.** Stack, layered backend + repository pattern, contract-sync strategy, REST surface, DB switching, i18n/RTL, deployment, testing | Before writing any code. It is the authority when documents conflict |
| [03-data-model.md](./03-data-model.md) | Full Prisma schema, ERD, event-sourced game state, the guest→user claim transaction, wallet ledger, matchmaking models | When touching the schema, persistence, or match history |
| [04-realtime-protocol.md](./04-realtime-protocol.md) | Socket.IO handshake, room model, complete event catalog, per-viewer projection, `seq` ordering, reconnection, **§6 turn limits & ejection** | When implementing or debugging anything real-time, or anything about turn timers |
| [05-game-engine-spec.md](./05-game-engine-spec.md) | The `GameEngine` interface every game implements, the five invariants, shared card/trick/betting modules, RNG | Before implementing any game. The per-game checklist lives here |
| [06-frontend-architecture.md](./06-frontend-architecture.md) | Vite/React setup, routes and guards, Zustand slices, Axios interceptors, socket discipline, theming tokens, matchmaking/wallet/store UI, the customization page | When working on the client |
| [07-security-and-anticheat.md](./07-security-and-anticheat.md) | Threat model, hidden-information defense, move integrity, provable shuffle, guest-token binding, **§11 economy integrity**, accepted risks | Before implementing auth, projections, or anything a player could tamper with |
| [08-roadmap.md](./08-roadmap.md) | Milestones M0–M8 with scope and exit criteria, backlog order, deferred items | At the start of every work session, to know what's in scope |
| [09-matchmaking.md](./09-matchmaking.md) | Queue pools and presets, the matcher, **2-minute timeout release**, bot fill, parties, backfill, farming guards, queue cooldowns | When implementing matchmaking, or deciding what a game's queueable presets are |
| [10-economy-and-rewards.md](./10-economy-and-rewards.md) | Wallet & append-only ledger, reward formula, **forfeiture on ejection**, guest earning and vesting, store, coin sinks, premium plan, legal boundaries, the crypto seam | Before touching anything involving coins, rewards, purchases, or premium |

### Game specifications

| Document | What | Milestone |
|---|---|---|
| [games/sudoku.md](./games/sudoku.md) | Generation and grading, server-withheld solution, race mode | M1 |
| [games/blackjack.md](./games/blackjack.md) | Shoe, dealer automation, splits/doubles/insurance, payout table, basic-strategy bot | M2 |
| [games/shelem.md](./games/shelem.md) | ⭐ Bidding (min 100), widow exchange, 12 tricks, two-component scoring to 165. **Trump is set by the opening lead.** §0 records what the source confirmed and what's still open | M4 |
| [games/poker-holdem.md](./games/poker-holdem.md) | Betting streets, hand evaluator, **side-pot algorithm**, and §11.1 **chips are not coins** | M5 |
| [games/chess.md](./games/chess.md) | `chess.js` adapter, server-authoritative clocks, the RTL board exception | M6 |
| [games/backlog-games.md](./games/backlog-games.md) | Hokm, Checkers, Crazy Eights, Uno, Rummy, Durak, Backgammon — effort assessments and reuse analysis | Later |

---

## Status

| Document | Status |
|---|---|
| All documents | **Draft** — awaiting review |
| [games/shelem.md](./games/shelem.md) §0 | ✅ **Rules sourced** from [Wikipedia — Shelem](https://en.wikipedia.org/wiki/Shelem). §0.2 lists four corrections to earlier drafts; §0.3 flags one inference; §0.4 lists 6 parameters the source doesn't cover (match target, all-pass rule, point-card discards) |
| [10-economy-and-rewards.md](./10-economy-and-rewards.md) §6.5 | ⚠️ **Decide before M7** — should coins be purchasable for real money? Documented default: **no**, coins are earn-only and money buys the subscription |
| [10-economy-and-rewards.md](./10-economy-and-rewards.md) §3–4 | Rates, prices, caps, and multipliers are a **starting guess**. All live in `RewardRule` / `StoreItem` rows so rebalancing is an update, not a deploy |
| [04-realtime-protocol.md](./04-realtime-protocol.md) §6.3 | Turn-timeout ejection defaults to **2 strikes**, not 1. Set `ejectAfterStrikes: 1` for your literal rule — rationale in §6.3 |
| [03-data-model.md](./03-data-model.md) §8 | Open question: `db push` vs dual migration folders for dev |

Update this table as documents are approved and then implemented.

---

## Decisions Already Locked

Recorded here so they are not silently re-litigated later.

| Area | Decision | Rationale |
|---|---|---|
| Language | TypeScript both sides, `strict` | Card/trick/betting state is easy to get wrong untyped |
| Repo layout | **Two separate projects** (`backend/`, `frontend/`) | Chosen deliberately; the contract-drift cost is managed by [02](./02-technical-prd.md) §4.1 |
| Auth | httpOnly cookie JWT + rotating refresh; **table-bound guest tokens** | Guest play with no signup wall is the core product promise |
| Database | SQLite (dev) → PostgreSQL (prod), Prisma `provider` via env | Schema written to the intersection of both engines ([02](./02-technical-prd.md) §6.2) |
| Hosting | Docker Compose + Caddy on a VPS | Cheap, portable, no vendor lock-in |
| Rules location | **Server only.** Zero game logic in the client | The entire point of the project ([07](./07-security-and-anticheat.md)) |
| State model | Event-sourced (`GameEvent` is truth, snapshots are cache) | Buys resync, replay, dispute resolution, and auditing from one mechanism |
| Build order | skeleton → Sudoku → Blackjack → **matchmaking** → **Shelem** → Poker → Chess → store → polish | Rising rules complexity; each milestone adds a reusable core ([08](./08-roadmap.md)) |
| i18n | English + Persian, **full RTL**, from v1 | Treated as correctness, not polish |
| **Turn limits** | 30–60 s per turn, 10 s warning, **2 strikes → ejection + bot substitution** | A match is never stalled by an absent player. Strikes are a table option; set to 1 for a single-lapse rule ([04](./04-realtime-protocol.md) §6.3) |
| **Matchmaking** | Queue per fixed preset; **release after 120 s** with a useful alternative | With a small player base, timeout is the common path — so the release screen is a primary surface ([09](./09-matchmaking.md) §5) |
| **Economy** | Coins **earned** by playing (guests included), spent on assets. Append-only ledger, derived idempotency keys | The commercial goal and the signup funnel ([10](./10-economy-and-rewards.md)) |
| **Ejection forfeits reward** | Ejected players earn **zero even if their team wins**; their partner earns in full | Removes the incentive to idle. Per-seat, not per-team ([10](./10-economy-and-rewards.md) §5) |
| **Premium** | Real-money **subscription**. Coins stay earn-only in v1 | Earn rate, cosmetics, convenience — **never gameplay advantage** ([10](./10-economy-and-rewards.md) E3) |
| **Chips ≠ coins** | Poker/Blackjack chips are ephemeral and never touch the wallet | Crossing this makes the app **gambling**. Enforced by lint + test, not intention ([10](./10-economy-and-rewards.md) E5) |
| Crypto / NFT | **Not built.** Ledger and asset-keyed wallet keep the seam open | A separate product decision, with a real regulatory cost ([10](./10-economy-and-rewards.md) §8) |

---

## Requirement Coverage

Every requirement from the original brief, mapped to where it is specified. Checkable rather than
asserted.

| Requirement | Specified in |
|---|---|
| Express + React web app | [02](./02-technical-prd.md) §2, §3 |
| Users sign in and play board games | [01](./01-business-prd.md) §4–5, [02](./02-technical-prd.md) §7 |
| Mostly card games (deck of cards) | [05](./05-game-engine-spec.md) §4, [games/](./games/) |
| **PRD in a `Documents` directory** | This directory |
| Business PRD | [01-business-prd.md](./01-business-prd.md) |
| Technical PRD | [02-technical-prd.md](./02-technical-prd.md) |
| Vite for the frontend | [02](./02-technical-prd.md) §2.2, [06](./06-frontend-architecture.md) §1 |
| Zustand for global state | [06](./06-frontend-architecture.md) §3 |
| Axios for requests | [06](./06-frontend-architecture.md) §4.1 |
| Prisma ORM | [02](./02-technical-prd.md) §2.1, [03](./03-data-model.md) |
| SQLite in dev | [02](./02-technical-prd.md) §6.1, [03](./03-data-model.md) §8 |
| **Switchable to another DB in production** | [02](./02-technical-prd.md) §6.1–6.2 (Postgres), [03](./03-data-model.md) §1 (portable schema rules) |
| Backend on the repository pattern | [02](./02-technical-prd.md) §5.1–5.5 |
| **All game logic and rules on the backend** | [02](./02-technical-prd.md) §1 (P1), [05](./05-game-engine-spec.md) §2, [07](./07-security-and-anticheat.md) §3 |
| **Prevent user cheating** | [07-security-and-anticheat.md](./07-security-and-anticheat.md) in full |
| Frontend communication over WebSocket | [04-realtime-protocol.md](./04-realtime-protocol.md) |
| Users create a table | [01](./01-business-prd.md) §5 J1, [02](./02-technical-prd.md) §7 |
| Invite friends with a link | [02](./02-technical-prd.md) §7, [06](./06-frontend-architecture.md) §2.1 |
| **No login required for guest players** | [03](./03-data-model.md) §3.1, [06](./06-frontend-architecture.md) §2, [07](./07-security-and-anticheat.md) §5.1 |
| App suggests signup/signin to guests | [01](./01-business-prd.md) §5 J2 |
| **After signup, redirect to the invited table and start playing** | [01](./01-business-prd.md) §5 J2, [03](./03-data-model.md) §6.1, [06](./06-frontend-architecture.md) §3.1 |
| Sudoku | [games/sudoku.md](./games/sudoku.md) |
| Chess | [games/chess.md](./games/chess.md) |
| Poker | [games/poker-holdem.md](./games/poker-holdem.md) |
| Blackjack | [games/blackjack.md](./games/blackjack.md) |
| **Shelem** (Persian, deck of cards) | [games/shelem.md](./games/shelem.md) |
| Welcome page showing preview cards of the games | [01](./01-business-prd.md) §5 J3, [05](./05-game-engine-spec.md) §5 (registry-driven) |
| Additional favorite games (Uno etc.) | [games/backlog-games.md](./games/backlog-games.md) — 7 games |
| In-table chat + emotes | [04](./04-realtime-protocol.md) §3, [08](./08-roadmap.md) M0/M8 |
| Spectator mode | [04](./04-realtime-protocol.md) §2, [08](./08-roadmap.md) M8 |
| AI bots | [05](./05-game-engine-spec.md) §1.1, per-game §"Bot", [08](./08-roadmap.md) |
| Stats, ELO & match history | [03](./03-data-model.md) §3.5, [08](./08-roadmap.md) M8 |
| **Customization page** (card backs, avatars, table colors) | [06](./06-frontend-architecture.md) §6, [03](./03-data-model.md) §3.6 |

### Second round of requirements

| Requirement | Specified in |
|---|---|
| **Matchmaker: users join a queue and are matched together** | [09-matchmaking.md](./09-matchmaking.md) §2–4, [01](./01-business-prd.md) §5 J4 |
| **Wait ~2 minutes; if the table can't be filled, release the player** | [09](./09-matchmaking.md) §5 (`queueTimeoutSec: 120`), [08](./08-roadmap.md) M3 exit criteria |
| **Max time to play per turn (e.g. 30 s / 1 min)** | [04](./04-realtime-protocol.md) §6.1, per-game "Timers" sections |
| **If they don't play, remove them from the game and replace with a bot** | [04](./04-realtime-protocol.md) §6.2–6.5, [05](./05-game-engine-spec.md) `SeatOutcome` |
| **Premium plan** | [10](./10-economy-and-rewards.md) §6, [08](./08-roadmap.md) M7 |
| **Users earn custom assets / coins by playing** | [10](./10-economy-and-rewards.md) §3 |
| **Coins buy things inside the game** | [10](./10-economy-and-rewards.md) §4, [06](./06-frontend-architecture.md) §5.3 |
| **Coins deposit to player wallets even for guests** | [10](./10-economy-and-rewards.md) §2.2, §3.4, [03](./03-data-model.md) §3.9 |
| **On signup, guest assets deposit to their wallet** | [10](./10-economy-and-rewards.md) §3.4, [03](./03-data-model.md) §6.1 (steps 8–10) |
| **Players fired from a game earn nothing, even if their team wins** | [10](./10-economy-and-rewards.md) §5, [03](./03-data-model.md) §6.4, [01](./01-business-prd.md) §5 J5 |
| Possible future: cryptocurrency / NFT assets | [10](./10-economy-and-rewards.md) §8 — seam documented, not built |

---

## Conventions Used Here

- **Mermaid** for all diagrams — renders in GitHub, VS Code, and most markdown tooling.
- **Relative links only** between documents, so the folder can be moved or published as-is.
- **`> **Open question:**`** callouts mark anything genuinely undecided rather than papering over
  it with a guess. Search the folder for "Open question" to find every one.
- **`[C##]`** markers in [games/shelem.md](./games/shelem.md) tie individual rules back to the
  status table in its §0, so the blast radius of changing a rule is visible — and which values
  are sourced versus assumed.
- Code samples are **illustrative**, not final — they show shape and intent, and they name the
  specific traps worth avoiding.

---

## Getting Started (once code exists)

```bash
# backend
cd backend && npm install && npx prisma db push && npm run seed && npm run dev

# frontend (separate terminal)
cd frontend && npm install && npm run dev      # proxies /api and /socket.io to :3000
```

First implementation step: **[08-roadmap.md](./08-roadmap.md) M0**.
