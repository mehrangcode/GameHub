# Sudoku — Implementation Spec

> **Milestone:** M1 · **Players:** 1 (race mode 2–4) · **Duration:** 5–20 min · **Complexity:** Light
> **Implements:** [../05-game-engine-spec.md](../05-game-engine-spec.md)

Sudoku is the odd one out — no cards, no opponents, no bidding. It is scheduled first on purpose:
it exercises the entire pipeline (auth → table → socket → engine → projection → renderer) with
almost no rules risk, so the first pass is about the *pipeline*, not the game.

It also has one genuine hidden-information requirement that makes it a real test of the projection
mechanism: **the solution must never leave the server.**

---

## 1. Rules

Standard 9×9 Sudoku. Fill the grid so every row, column, and 3×3 box contains 1–9 exactly once.
Given cells are fixed and cannot be changed.

### Difficulties

| Difficulty | Givens | Techniques required | Target time |
|---|---|---|---|
| Easy | 36–40 | Single candidate, single position | 4–8 min |
| Medium | 30–35 | + naked/hidden pairs | 8–15 min |
| Hard | 26–29 | + pointing pairs, box/line reduction | 15–30 min |
| Expert | 22–25 | + X-wing, chains | 30 min+ |

Grading is by **solver technique**, not given count — given count alone is a poor proxy, and a
25-given puzzle solvable by singles is easy regardless. See §5.

---

## 2. State

```ts
interface SudokuState {
  phase: 'PLAYING' | 'SOLVED' | 'ABANDONED'
  difficulty: 'easy' | 'medium' | 'hard' | 'expert'

  /** 81 chars, '0' = empty. Immutable for the game's life. */
  puzzle: string
  /** ★ 81 chars. SERVER ONLY — must never appear in any projection. */
  solution: string

  /** Per seat, so race mode works from the same shape. */
  players: Record<SeatId, {
    /** The player's current grid, 81 chars. */
    grid: string
    /** Pencil marks: cell index → digits. Client-authored, server-stored. */
    notes: Record<number, number[]>
    filled: number
    mistakes: number
    hintsUsed: number
    startedAt: number
    solvedAt: number | null
    /** Cells the server has told this player are wrong (index → true). */
    flagged: Record<number, true>
  }>

  mode: 'solo' | 'race'
  winnerSeat: SeatId | null
}
```

**Invariant I5 check:** `notes` and `flagged` are plain objects keyed by number-as-string, not
`Map`s. `grid`/`puzzle`/`solution` are strings. JSON round-trip safe.

---

## 3. Moves

```ts
type SudokuMove =
  | { type: 'SET_CELL';    index: number; value: number }   // 0..80, 1..9
  | { type: 'CLEAR_CELL';  index: number }
  | { type: 'SET_NOTES';   index: number; digits: number[] }
  | { type: 'CHECK' }                                        // validate the whole grid
  | { type: 'HINT' }                                         // reveal one correct cell
  | { type: 'GIVE_UP' }
```

### Legality

| Move | Legal when |
|---|---|
| `SET_CELL` | `phase = PLAYING`, `index` not a given, `value ∈ 1..9` |
| `CLEAR_CELL` | `phase = PLAYING`, `index` not a given, cell non-empty |
| `SET_NOTES` | `phase = PLAYING`, `index` not a given, cell empty, `digits ⊆ 1..9` |
| `CHECK` | `phase = PLAYING` (rate-limited: 1 per 5 s per seat) |
| `HINT` | `phase = PLAYING`, `hintsUsed < maxHints` (option, default 3) |
| `GIVE_UP` | `phase = PLAYING` |

> **Deliberate design choice:** `SET_CELL` with a *wrong* value is **legal**. Sudoku is a game of
> deduction, and blocking wrong entries would solve the puzzle for the player. The server records
> the entry and only reveals correctness when asked (`CHECK`) or when the grid is complete. This
> is the opposite of the card games, where an illegal move is rejected — worth noting so the
> asymmetry doesn't read as a bug.

### `applyMove` behaviour

- `SET_CELL` / `CLEAR_CELL`: update `grid`, recompute `filled`, clear `flagged[index]`.
- If `filled === 81`: compare against `solution`.
  - Match → `phase = SOLVED`, `solvedAt`, and in race mode `winnerSeat` if first.
  - Mismatch → increment `mistakes`, set `flagged` for **every** incorrect cell, emit
    `GRID_INCORRECT`. Does *not* end the game.
- `CHECK`: set `flagged` for currently-incorrect filled cells, increment `mistakes` by the count.
- `HINT`: pick a uniformly random empty cell, fill it from `solution`, increment `hintsUsed`,
  emit `HINT_USED`. **This is the only path by which a solution digit legitimately reaches a
  client**, and it reveals exactly one cell.

---

## 4. Projection — the one thing that matters here

```ts
projectState(state, viewer) {
  const base = {
    phase: state.phase,
    difficulty: state.difficulty,
    puzzle: state.puzzle,
    mode: state.mode,
    winnerSeat: state.winnerSeat,
    // ★ solution is NOT here, and there is no branch in which it is
  }

  if (viewer.kind === 'seat') {
    const me = state.players[viewer.seat]!
    return {
      ...base,
      me: { grid: me.grid, notes: me.notes, filled: me.filled,
            mistakes: me.mistakes, hintsUsed: me.hintsUsed, flagged: me.flagged },
      // race mode: opponents' PROGRESS only, never their grids
      others: mapValues(omit(state.players, viewer.seat),
                        (p) => ({ filled: p.filled, mistakes: p.mistakes, solvedAt: p.solvedAt })),
    }
  }

  if (viewer.kind === 'spectator') {
    return { ...base,
      progress: mapValues(state.players, (p) => ({ filled: p.filled, solvedAt: p.solvedAt })) }
  }

  return state   // omniscient — server/replay only
}
```

| Leak | Guard |
|---|---|
| `solution` in a payload | Never included. Test asserts the solution string appears in no projection |
| Opponent's grid in race mode | Only `filled` count is shared. A grid would give away deductions |
| Solution derivable from `flagged` | `flagged` says *which cells are wrong*, never what the right value is |

> This is a genuinely tempting leak: it is much easier to ship the solution and let the client
> validate instantly. That design would let anyone read the answer out of devtools in ten seconds.
> The round-trip on `CHECK` is the price of correctness, and it is cheap.

---

## 5. Generation & Grading

```
1. Build a full valid grid:
     seed a random 3x3 box, then backtracking-fill with a shuffled candidate order (seeded RNG)
2. Dig holes:
     for each cell in a shuffled order:
       remove it, then run the uniqueness solver
       if the puzzle no longer has exactly one solution → put it back
     stop when the given count reaches the difficulty band
3. Grade:
     run the technique-ranked solver; the hardest technique needed determines the difficulty
4. If the grade misses the requested band → discard and retry (bounded attempts)
```

- **Uniqueness solver:** exhaustive backtracking that counts solutions, short-circuiting at 2. A
  puzzle with multiple solutions is not a Sudoku and must never ship.
- **Grading solver:** applies techniques in ascending difficulty (singles → pairs → pointing →
  box/line → X-wing → chains), recording the hardest one required.
- **Determinism (I1):** generation takes the injected RNG, so `(seed, difficulty)` always yields
  the same puzzle. That makes race mode fair and bug reports reproducible.
- **Performance:** generation is bounded to ~200 ms. Expert puzzles can need several attempts, so
  a background pre-generated pool of ~50 puzzles per difficulty is warmed at startup and refilled
  lazily. Puzzles are cheap to store (81 + 81 chars).

---

## 6. Race Mode

Same puzzle, 2–4 players, first to solve wins.

- Every seat gets an identical `puzzle` (one `solution` server-side).
- Live opponent progress = `filled` count only → a progress bar, never a grid.
- First seat to a correct complete grid sets `winnerSeat`; others may finish for their own time.
- Hints allowed but counted and shown to everyone (a hint is public information in a race).
- `phase = SOLVED` when the first player solves; others enter a short "finish your grid" window
  (option, default 60 s).

Race mode's real purpose is to exercise multi-seat broadcast and per-seat projection on a game
whose rules can't hide a bug — if projection is wrong here, it's obvious.

---

## 7. Options

```ts
const sudokuOptions = z.object({
  difficulty: z.enum(['easy', 'medium', 'hard', 'expert']).default('medium'),
  mode: z.enum(['solo', 'race']).default('solo'),
  maxHints: z.number().int().min(0).max(10).default(3),
  allowNotes: z.boolean().default(true),
  autoCheckOnComplete: z.boolean().default(true),
  raceFinishWindowSec: z.number().int().min(0).max(300).default(60),
})
```

---

## 8. Result & Stats

```ts
result(state) {
  const solved = Object.entries(state.players).filter(([, p]) => p.solvedAt)
  return {
    standings: sortBy(solved, ([, p]) => p.solvedAt!)
      .map(([seat, p], i) => ({ seat: +seat, rank: i + 1, score: durationMs(p) })),
    reason: state.phase === 'SOLVED' ? 'NORMAL' : 'ABANDONED',
    summary: { difficulty: state.difficulty, mode: state.mode,
               perSeat: mapValues(state.players, (p) => ({
                 ms: durationMs(p), mistakes: p.mistakes, hints: p.hintsUsed })) },
  }
}
```

`PlayerStats.extraJson` accumulates best time per difficulty, average mistakes, and a
hint-free-solve count. **No ELO** — solo puzzle times aren't a rating-appropriate signal.

---

## 9. UI Notes

- 9×9 grid, heavier borders on box boundaries; number pad below (touch) and keyboard 1–9.
- **`dir="ltr"` island.** The grid is coordinate-addressed; row 1 / col 1 stays top-left in
  Persian. Surrounding chrome (timer, controls, chat) mirrors normally.
- Keyboard: arrows to move, 1–9 to set, `Backspace` to clear, `N` to toggle note mode,
  `Space` to check.
- Highlighting: same-digit cells, current row/column/box, conflicting cells.
- Flagged (server-confirmed wrong) cells get a distinct treatment from client-side conflict
  highlighting — one is truth, the other is a hint.
- Persian numerals (۱–۹) when `numeralSystem` resolves to Persian.
- `aria-label` per cell: `"row 3, column 5, empty"` / `"row 3, column 5, 7, given"`.

---

## 10. Test Cases

| # | Case | Expect |
|---|---|---|
| 1 | Generate 100 puzzles per difficulty | All have exactly one solution |
| 2 | Same `(seed, difficulty)` twice | Identical puzzle (I1) |
| 3 | Given count within band | Per §1 table |
| 4 | Grading | Hardest-technique classification matches the band |
| 5 | `SET_CELL` on a given cell | `IllegalMoveError` |
| 6 | `SET_CELL` with a wrong value | **Accepted**; no flag until `CHECK` or completion |
| 7 | Complete but incorrect grid | `mistakes++`, incorrect cells flagged, phase stays `PLAYING` |
| 8 | Complete and correct grid | `phase = SOLVED`, `solvedAt` set |
| 9 | `HINT` beyond `maxHints` | `IllegalMoveError` |
| 10 | `HINT` on a full grid | `IllegalMoveError` (no empty cell) |
| 11 | **Leak: `solution` in any seat projection** | Absent |
| 12 | **Leak: `solution` in the spectator projection** | Absent |
| 13 | **Leak: opponent's `grid` in race mode** | Absent — counts only |
| 14 | JSON round-trip of state | Deep-equal (I5) |
| 15 | Frozen input to `applyMove` | No mutation, no throw (I2) |
| 16 | Race: two seats solve | Earlier `solvedAt` ranks first |
| 17 | `CHECK` spam | Rate-limited to 1 / 5 s |
| 18 | Disconnect and reconnect | Grid, notes, and timer restored exactly |

---

## 11. Open Questions

> **Q1:** Should `mistakes` be capped (e.g. 3 strikes and the puzzle ends)? Default assumption:
> **no cap** — it's a puzzle, not a lives-based game.
>
> **Q2:** Should the timer pause on disconnect? Default assumption: **yes for solo** (it's your own
> time), **no for race** (pausing would be exploitable).

---

## 12. Timers, Ejection & Reward

Sudoku is the exception to most of [../04-realtime-protocol.md](../04-realtime-protocol.md) §6,
because there is nobody to keep waiting.

| Setting | Value |
|---|---|
| Turn limit | **none** — a puzzle has no turns |
| Match idle limit | **10 min** with no move → the game is abandoned (frees the table, stops an idle timer inflating a "best time") |
| Disconnect grace | ∞ in solo; **60 s** in race mode, after which the seat is marked abandoned |
| Bot substitution | **Never.** A bot solving your puzzle is meaningless |
| `reclaimAt` | `IMMEDIATE` — rejoin any time in solo |

**Reward** ([../10-economy-and-rewards.md](../10-economy-and-rewards.md) §3.2): 10 coins solo,
20 in race mode, with the placement multiplier applied in race. `GIVE_UP` counts as `RESIGNED`
(0.25×); abandoning by idle timeout counts as `EJECTED_ABANDON` (**zero**). Hints do not reduce
the reward — they already cost the player their time and their hint allowance.

Because Sudoku is solo and short, it is the **easiest game to farm**: generate, solve fast,
repeat. It is therefore capped hardest by the shared mechanisms — `expectedMinMs`, the repeat-decay
curve, and the daily match cap ([../10-economy-and-rewards.md](../10-economy-and-rewards.md) §3.5–3.7)
— rather than by anything Sudoku-specific.

---

**Related:** [../05-game-engine-spec.md](../05-game-engine-spec.md) · [../04-realtime-protocol.md](../04-realtime-protocol.md) · [../08-roadmap.md](../08-roadmap.md) M1
