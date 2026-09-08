# Chess — Implementation Spec

> **Milestone:** M6 · **Players:** 2 · **Duration:** 10–60 min · **Complexity:** Heavy rules, zero hidden information
> **Implements:** [../05-game-engine-spec.md](../05-game-engine-spec.md)

Chess is scheduled last because it shares the least with everything else: no deck, no hidden
information, no betting. Its value to the platform is proving the abstraction isn't card-shaped,
and building the **board layer + real clocks** that Checkers and Backgammon later reuse.

**Rules come from `chess.js` running server-side.** Reimplementing chess legality — castling
through check, en passant timing, threefold repetition, insufficient material — is a needless bug
farm when a battle-tested library exists. The library is wrapped behind `GameEngine` so the rest
of the system sees the same interface as every other game.

---

## 1. Why an Adapter, Not an Implementation

| Concern | Resolution |
|---|---|
| Rules correctness | `chess.js` handles all special moves and draw conditions, and is widely used |
| Invariant I1 (determinism) | `chess.js` is deterministic. No RNG is used at all — chess has no randomness |
| Invariant I2 (immutability) | `chess.js` instances **are mutable**, so the adapter constructs a fresh instance from the FEN on every call and never retains one. See §3 |
| Invariant I5 (serializable) | State is `{ fen, pgn, clocks }` — all strings and numbers. The `Chess` object is never stored |
| Server authority (P1) | The client gets `legalMoves` from the server; it may also run `chess.js` locally for instant highlighting, but the server's answer is the only one that counts |

> **The one real trap:** `chess.js` mutates. A naive adapter that keeps a `Chess` instance in
> state violates both I2 and I5 and will produce bizarre cross-game bugs. The adapter is
> stateless — FEN in, FEN out.

---

## 2. State

```ts
interface ChessState {
  phase: 'PLAYING' | 'FINISHED'
  options: ChessOptions

  /** Full position: pieces, side to move, castling rights, en passant, halfmove, fullmove. */
  fen: string
  /** Move history in PGN SAN. Also the repetition-detection source. */
  pgn: string
  /** Verbose move list for UI (from/to/san/captured/flags). */
  history: { from: string; to: string; san: string; color: 'w' | 'b'; promotion?: string }[]

  /** seat 0 = white, seat 1 = black. Fixed for the game. */
  colorBySeat: { 0: 'w'; 1: 'b' }

  clocks: {
    /** Remaining ms per color. */
    w: number
    b: number
    /** Server timestamp when the current side's clock started. null before move 1. */
    turnStartedAt: number | null
    incrementMs: number
  }

  drawOffer: { by: SeatId; at: number } | null
  takebackRequest: { by: SeatId; at: number } | null

  outcome: {
    result: '1-0' | '0-1' | '1/2-1/2'
    reason: 'CHECKMATE' | 'RESIGNATION' | 'TIMEOUT' | 'STALEMATE'
          | 'INSUFFICIENT_MATERIAL' | 'THREEFOLD' | 'FIFTY_MOVE' | 'AGREEMENT' | 'ABANDONED'
  } | null
}
```

Everything is a string or number. No `Chess` instance, no `Date`, no `Map`.

---

## 3. The Adapter

```ts
// domain/games/chess/engine.ts
import { Chess } from 'chess.js'

/** Fresh instance every call — never retained. Satisfies I2 and I5. */
function load(state: ChessState): Chess {
  const c = new Chess()
  c.loadPgn(state.pgn)          // PGN, not FEN: preserves repetition history
  return c
}

export const chessEngine: GameEngine<ChessState, ChessMove> = {
  meta: chessMeta,

  createInitialState(config) {
    const c = new Chess()
    const base = (config.options as ChessOptions).baseMinutes * 60_000
    return {
      phase: 'PLAYING', options: config.options as ChessOptions,
      fen: c.fen(), pgn: c.pgn(), history: [],
      colorBySeat: { 0: 'w', 1: 'b' },
      clocks: { w: base, b: base, turnStartedAt: null,
                incrementMs: (config.options as ChessOptions).incrementSeconds * 1000 },
      drawOffer: null, takebackRequest: null, outcome: null,
    }
  },

  legalMoves(state, seat) {
    if (state.phase !== 'PLAYING') return []
    const c = load(state)
    if (c.turn() !== state.colorBySeat[seat as 0 | 1]) return []
    return c.moves({ verbose: true }).map(toChessMove)
  },

  applyMove(state, seat, move) { /* see §4 */ },
  advance(state) { /* clock expiry only — see §6 */ },
  projectState(state) { /* see §5 */ },
  isTerminal(state) { return state.phase === 'FINISHED' },
  result(state) { /* standings from outcome */ },
  describeMove(state, seat, move) { return { key: 'game.chess.move', params: { san: move.san } } },
}
```

> **`loadPgn`, not `load(fen)`:** FEN alone loses the move history, so threefold repetition
> becomes undetectable. Loading the PGN restores the full history and lets `chess.js` answer
> `isThreefoldRepetition()` correctly. This is a small detail with a large correctness impact.

---

## 4. Moves

```ts
type ChessMove =
  | { type: 'MOVE'; from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }
  | { type: 'RESIGN' }
  | { type: 'OFFER_DRAW' }
  | { type: 'RESPOND_DRAW'; accept: boolean }
  | { type: 'CLAIM_DRAW'; reason: 'THREEFOLD' | 'FIFTY_MOVE' }
  | { type: 'REQUEST_TAKEBACK' }
  | { type: 'RESPOND_TAKEBACK'; accept: boolean }
```

### `applyMove` — move case

```ts
case 'MOVE': {
  const c = load(state)
  if (c.turn() !== state.colorBySeat[seat]) throw new NotYourTurnError()

  // chess.js throws on an illegal move; convert to our domain error.
  let result
  try { result = c.move({ from: move.from, to: move.to, promotion: move.promotion }) }
  catch { throw new IllegalMoveError({ seat, move }) }

  const next = { ...state, fen: c.fen(), pgn: c.pgn(),
                 history: [...state.history, toHistoryEntry(result)],
                 clocks: applyClock(state, seat),        // deduct elapsed, add increment
                 drawOffer: null, takebackRequest: null }  // any move voids pending offers

  if (c.isCheckmate())            return finish(next, seat, 'CHECKMATE')
  if (c.isStalemate())            return finish(next, null, 'STALEMATE')
  if (c.isInsufficientMaterial()) return finish(next, null, 'INSUFFICIENT_MATERIAL')
  if (c.isThreefoldRepetition() && state.options.autoDrawThreefold)
                                  return finish(next, null, 'THREEFOLD')
  if (c.isDraw())                 return finish(next, null, 'FIFTY_MOVE')
  return { state: next, events: [moveEvent(result)] }
}
```

### Legality summary

| Move | Legal when |
|---|---|
| `MOVE` | `PLAYING`, my color to move, and the move is in `chess.js` legal moves (promotion required when a pawn reaches the last rank) |
| `RESIGN` | `PLAYING` |
| `OFFER_DRAW` | `PLAYING`, no pending offer from me, `≥ 1` move played |
| `RESPOND_DRAW` | A pending offer from the opponent exists |
| `CLAIM_DRAW` | The claimed condition actually holds (verified server-side, never trusted) |
| `REQUEST_TAKEBACK` | `PLAYING`, `takebacksAllowed`, `≥ 1` move played, no pending request |
| `RESPOND_TAKEBACK` | A pending request from the opponent exists |

**Takeback** rebuilds the PGN minus the last move (or last two, if it's the requester's own move
being undone) and restores clocks to their pre-move values. It's off by default — friendly games
want it, competitive ones don't.

---

## 5. Projection — a near-identity, with one exception

Chess is a **perfect-information** game. Both players legitimately see the entire position, so
`projectState` is nearly the identity function:

```ts
projectState(state, viewer) {
  const view = {
    phase: state.phase, options: state.options,
    fen: state.fen, pgn: state.pgn, history: state.history,
    colorBySeat: state.colorBySeat,
    clocks: {
      w: remaining(state, 'w'),          // ★ computed against server time
      b: remaining(state, 'b'),
      turnStartedAt: state.clocks.turnStartedAt,
      incrementMs: state.clocks.incrementMs,
    },
    drawOffer: state.drawOffer, takebackRequest: state.takebackRequest,
    outcome: state.outcome,
  }
  return viewer.kind === 'seat' ? { ...view, you: { seat: viewer.seat, color: state.colorBySeat[viewer.seat] } } : view
}
```

> **The exception is the clock.** `state.clocks.w` is the value at the last move; the *current*
> remaining time must be computed as `stored − (serverNow − turnStartedAt)` for the side to move.
> Sending the stored value unadjusted makes a client's clock appear frozen. And the client must
> never be the authority on elapsed time — a client with a slow clock would gain free thinking
> time. See §6.

There is no hidden information to leak, so the leak test for chess asserts only that no
server-internal field (nothing beyond the listed keys) escapes.

---

## 6. Clocks

Chess is the one game where the timer is part of the **rules**, not a courtesy.

```ts
function remaining(state: ChessState, color: 'w' | 'b'): number {
  const stored = state.clocks[color]
  if (state.phase !== 'PLAYING') return stored
  if (state.clocks.turnStartedAt === null) return stored
  if (sideToMove(state.fen) !== color) return stored
  return Math.max(0, stored - (serverNow() - state.clocks.turnStartedAt))
}

function applyClock(state: ChessState, seat: SeatId): ChessState['clocks'] {
  const color = state.colorBySeat[seat]
  const elapsed = state.clocks.turnStartedAt ? serverNow() - state.clocks.turnStartedAt : 0
  return {
    ...state.clocks,
    [color]: Math.max(0, state.clocks[color] - elapsed) + state.clocks.incrementMs,
    turnStartedAt: serverNow(),
  }
}
```

### Rules

| Rule | Detail |
|---|---|
| Authority | **Server only.** The client renders a countdown from the server-supplied `endsAt` against a clock offset measured at handshake |
| Flag-fall | Detected by `advance()`, which the session service calls on a timer. Not by the client reporting it |
| Insufficient material at flag-fall | If the side with time cannot possibly mate (e.g. lone king), the result is a **draw**, not a win. `chess.js` `isInsufficientMaterial()` on the flagging side's opponent |
| Increment | Fischer — added **after** the move completes |
| Restart survival | `turnStartedAt` is persisted in state; on API restart, timers re-arm from it. A restart does not gift anyone time |
| Lag | No compensation in v1. Documented as a known limitation; increments mitigate it in practice |

> `serverNow()` inside a "pure" engine is a real tension with invariant I1. Resolution: the
> session service passes the current timestamp in as part of the move context, exactly like the
> RNG. Tests inject a fixed clock, so `(seed, moves, timestamps)` still replays deterministically.
> **No engine calls `Date.now()` directly** — the lint rule covers this.

### Presets

| Preset | Base | Increment |
|---|---|---|
| Bullet | 1 min | 0 s |
| Blitz | 5 min | 3 s |
| Rapid | 10 min | 5 s |
| Classical | 30 min | 30 s |
| Untimed | ∞ | — |

---

## 7. Options

```ts
const chessOptions = z.object({
  baseMinutes: z.number().int().min(0).max(180).default(10),   // 0 = untimed
  incrementSeconds: z.number().int().min(0).max(60).default(5),
  whiteSeat: z.union([z.literal(0), z.literal(1), z.literal('random')]).default('random'),
  takebacksAllowed: z.boolean().default(false),
  autoDrawThreefold: z.boolean().default(true),   // false = must be claimed
  showLegalMoveHints: z.boolean().default(true),  // display only
  graceSec: z.number().int().min(0).max(120).default(0),  // 0 = the clock IS the grace
})
```

`whiteSeat: 'random'` is the **only** use of the RNG in chess — deciding colors. Seeded, so a
replay assigns the same colors.

---

## 8. Disconnects

**Chess is the one game with no turn-timeout ejection**, because the player's own clock already
*is* the turn limit ([../04-realtime-protocol.md](../04-realtime-protocol.md) §6.1). A disconnected
player's clock runs down and they lose on time, exactly as at a physical board.

| Situation | Behaviour |
|---|---|
| Disconnect, timed game | Clock keeps running. Presence badge shown to the opponent |
| Disconnect, untimed game | 120 s grace, then the host may claim the win or abandon |
| Reconnect | Full state resync; the clock reflects real elapsed time (no free time) |
| Both disconnect | Game paused, resumable from the event log |
| `reclaimAt` | `NEVER` — there is nothing to reclaim, since the seat is never taken |

Bot takeover on disconnect is **off** for chess: having a bot play your rated game is worse than
losing on time. (`supportsBots` remains true so a bot can fill a seat *deliberately* from the
lobby or from matchmaking bot-fill.)

**Reward consequences.** Losing on time is a normal loss, not an ejection — so it pays the
loser's placement multiplier (0.6×), not zero. Resigning pays 0.25×. **Abandoning** — never
returning at all, so the game ends by the untimed grace path — is `EJECTED_ABANDON` and pays
nothing ([../10-economy-and-rewards.md](../10-economy-and-rewards.md) §5.1).

> This is the right asymmetry: flagging is a *chess outcome*, and a player who sat and thought
> until their clock ran out has played the game. Walking away from the board has not.

---

## 9. Bot

```ts
const chessBot: BotStrategy<ChessState, ChessMove> = {
  difficulty: 'easy',
  chooseMove(view, seat, legal, rng) {
    // Tier 1: prefer captures by material value, else random legal.
    const scored = legal.filter(isMove).map((m) => ({ m, v: captureValue(m) }))
    const best = maxBy(scored, (s) => s.v)
    return best && best.v > 0 ? best.m : rng.pick(legal)
  },
}
```

**Tier 2 (optional):** depth-3 minimax with alpha-beta over material + piece-square tables. A few
hundred lines, plays a recognizable game of chess, and runs in well under 50 ms at that depth.

Deliberately **not** bundling a real engine (Stockfish WASM): it would be strong enough to be
unfun, adds megabytes, and nobody asked for it.

---

## 10. UI Notes

- 8×8 board, coordinate labels, piece set as SVG sprite.
- Move input: drag-and-drop **and** click-source-then-target (better on touch).
- Legal-move dots from server `legalMoves` — the client may compute them locally with `chess.js`
  for zero-latency highlighting, but a move is only committed when the server accepts it.
- Highlights: last move, check (king square), selected piece, capture targets.
- Promotion: a four-piece picker before the move is submitted.
- Move list in SAN alongside the board, click-to-review positions (review is local; it does not
  affect game state).
- Captured-material tray with a material-difference indicator.
- Clocks: large, top-right and bottom-right, turning red under 30 s, ticking only for the side to
  move.
- Draw offer as a non-blocking banner with Accept / Decline.
- PGN export button (and copy-to-clipboard).

### RTL — the important exception

> **The board is NOT mirrored in Persian.** `a1` stays bottom-left for White, files run a→h
> left-to-right, and coordinate labels stay Latin.

Mirroring the board would break notation for every player who reads it, which is every chess
player, and would make shared analysis impossible. Implementation: the board is wrapped in
`<div dir="ltr">` so it ignores the ambient direction, while all surrounding chrome (move list,
clocks, panels, chat) mirrors normally. Board **orientation** still flips by *color* — Black sees
the board from Black's side — which is a different axis entirely and applies in both locales.

---

## 11. Test Cases

| # | Case | Expect |
|---|---|---|
| 1 | Castling both sides, both colors | Legal when rights and squares permit |
| 2 | Castling through check | Illegal |
| 3 | Castling out of check | Illegal |
| 4 | Castling after the king has moved | Illegal |
| 5 | En passant, immediately available | Legal |
| 6 | En passant, one move later | Illegal |
| 7 | Promotion without a piece specified | `IllegalMoveError` |
| 8 | Promotion to each of q/r/b/n | All legal |
| 9 | Checkmate | `FINISHED`, correct winner, reason `CHECKMATE` |
| 10 | Stalemate | Draw, reason `STALEMATE` |
| 11 | Insufficient material (K vs K, K+B vs K, K+N vs K) | Draw |
| 12 | Threefold repetition, `autoDrawThreefold: true` | Auto-draw |
| 13 | Threefold, auto off, then `CLAIM_DRAW` | Draw on claim |
| 14 | `CLAIM_DRAW` when the condition is false | `IllegalMoveError` |
| 15 | Fifty-move rule | Draw |
| 16 | Move while not to move | `NotYourTurnError` |
| 17 | Move leaving own king in check | `IllegalMoveError` |
| 18 | Pinned piece move | Illegal |
| 19 | **PGN round-trip** | `loadPgn(pgn)` reproduces the identical position and repetition state |
| 20 | Clock deduction | Elapsed deducted, increment added, accurate within 100 ms |
| 21 | Flag-fall | Game ends on time, correct winner |
| 22 | **Flag-fall vs insufficient material** | **Draw**, not a win |
| 23 | Clock across an API restart | Re-armed correctly; no time gifted |
| 24 | Client with a wrong system clock | Countdown still correct (server offset) |
| 25 | Draw offer, then a move | Offer voided |
| 26 | Takeback accepted | Position and clocks restored exactly |
| 27 | Takeback when disallowed | `IllegalMoveError` |
| 28 | JSON round-trip of state | Deep-equal (I5); **no `Chess` instance present** |
| 29 | Frozen input | No mutation (I2) — verifies the adapter never retains an instance |
| 30 | Same `(seed, moves, timestamps)` | Byte-identical (I1) |
| 31 | Bot over 1000 seeded games | Never illegal |
| 32 | Leak test | No server-internal fields beyond the documented projection keys |
| 33 | **RTL: board not mirrored** | `a1` bottom-left in `fa`; chrome mirrored (visual test) |
| 34 | PGN export | Opens correctly in a third-party viewer |

---

## 12. Reuse for Backlog Games

M6 builds a board layer that later games inherit:

| Reusable | Used by |
|---|---|
| 8×8 board renderer, drag/click input, coordinate labels | **Checkers** (nearly free) |
| Server-authoritative clocks | Checkers, Backgammon |
| PGN-style move history + review | Checkers |
| `dir="ltr"` board island pattern | Every board game |
| Stateless-adapter-over-a-library pattern | Any future game with a good library |

This is why Checkers is second in the backlog order — most of it already exists after M6.

---

**Related:** [../05-game-engine-spec.md](../05-game-engine-spec.md) · [../02-technical-prd.md](../02-technical-prd.md) §8 (RTL rules) · [backlog-games.md](./backlog-games.md) · [../08-roadmap.md](../08-roadmap.md) M6
