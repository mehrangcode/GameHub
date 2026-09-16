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

| Difficulty | Techniques required (**the definition**) | Observed givens | Target time |
|---|---|---|---|
| Easy | Single candidate, single position | 36–40 | 4–8 min |
| Medium | + naked/hidden pairs | 24–31 | 8–15 min |
| Hard | + pointing pairs, box/line reduction | 23–29 | 15–30 min |
| Expert | + X-wing, or search where no technique suffices | 23–27 | 30 min+ |

Grading is by **solver technique**, not given count — given count alone is a poor proxy, and a
25-given puzzle solvable by singles is easy regardless. See §5.

> **The given-count column is an observation, not a target**, and the numbers above are measured
> over 160 generated puzzles rather than assumed. This matters because the first version of the
> generator dug *to* a given band and graded afterwards, which produced an easy puzzle for four out
> of five `medium` requests: most puzzles with 30–35 givens are still solvable by singles alone.
> Once digging targets the technique instead, medium settles around 27 givens and **medium, hard and
> expert overlap almost completely** in given count — which is the sharpest possible statement of
> why the technique column is the one that defines the band.
>
> Easy is the exception, and only because its dig stops as soon as it is inside the band rather
> than continuing until something harder is required.

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
    /** Total hints taken this match — free allowance *and* point-funded (§13). */
    hintsUsed: number
    /** Of those, how many were paid for with a hint point. `hintsUsed -
     *  hintPointsSpent` is the free allowance consumed, which is what
     *  `maxHints` bounds. */
    hintPointsSpent: number
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
  | { type: 'HINT'; funding: 'FREE' | 'POINT' }               // the next deducible cell (§13)
  | { type: 'GIVE_UP' }
```

> **`funding` is server-authored.** The client sends `{ type: 'HINT' }` and nothing else.
> `GameSessionService` decides whether this hint comes out of the free `maxHints` allowance or out
> of the player's persistent hint-point balance, and *writes the field itself* before calling
> `applyMove`. A client that supplies its own `funding` has it overwritten, exactly as it cannot
> claim to be seat 2. The engine stays pure: it is told how the hint was paid for, it never asks.

### Legality

| Move | Legal when |
|---|---|
| `SET_CELL` | `phase = PLAYING`, `index` not a given, `value ∈ 1..9` |
| `CLEAR_CELL` | `phase = PLAYING`, `index` not a given, cell non-empty |
| `SET_NOTES` | `phase = PLAYING`, `index` not a given, cell empty, `digits ⊆ 1..9` |
| `CHECK` | `phase = PLAYING` (rate-limited: 1 per 5 s per seat) |
| `HINT` (`FREE`) | `phase = PLAYING`, free allowance remains (`hintsUsed - hintPointsSpent < maxHints`), and `nextHint` yields a move |
| `HINT` (`POINT`) | `phase = PLAYING` and `nextHint` yields a move. The *balance* check is the service's job, not the engine's — see §13.3 |
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
- `HINT`: run `nextHint(state, seat)` (§13.2) against the player's **current grid**, fill the cell
  it names, increment `hintsUsed` (and `hintPointsSpent` when `funding = 'POINT'`), emit
  `HINT_USED` carrying `{ index, value, techniqueKey }`. **This is the only path by which a
  solution digit legitimately reaches a client**, and it reveals exactly one cell.

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
  /** Free hints per seat per match, before hint points are touched (§13). */
  maxHints: z.number().int().min(0).max(10).default(3),
  /** Whether a seat may spend banked hint points once `maxHints` is exhausted.
   *  `false` makes the match a pure test of the player, which is what a
   *  tournament preset would want. */
  allowHintPoints: z.boolean().default(true),
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
| 3 | Given count | Between 20 and 41 — the dig floor and the easy band's top. **Not** asserted per difficulty: §1's counts are observed, and pinning them would fail the build on a legitimately harder-than-usual medium |
| 4 | Grading | Hardest-technique classification matches the requested band for ≥90% of puzzles per difficulty; `graded` reports the truth when it does not |
| 4a | Every implemented technique fires | A fixture per technique, so none becomes dead code that silently degrades grading to `guess` |
| 5 | `SET_CELL` on a given cell | `IllegalMoveError` |
| 6 | `SET_CELL` with a wrong value | **Accepted**; no flag until `CHECK` or completion |
| 7 | Complete but incorrect grid | `mistakes++`, incorrect cells flagged, phase stays `PLAYING` |
| 8 | Complete and correct grid | `phase = SOLVED`, `solvedAt` set |
| 9 | `HINT` (`FREE`) beyond `maxHints` | `IllegalMoveError` — the service must fund it as `POINT` or refuse |
| 10 | `HINT` on a full grid | `HINT_NONE`, nothing charged |
| 9a | `nextHint` on a solvable grid | Names a cell whose value matches `solution`, with a `techniqueKey` |
| 9b | `nextHint` on a grid with a wrong entry | `kind: 'MISTAKE'` listing the contradicting cells |
| 9c | 3rd solve grants a point; 4th and 5th do not; 6th does | Balance 1 → 1 → 1 → 2 |
| 9d | Settlement replayed for the same match | No second grant (idempotency key collides) |
| 9e | Spend with balance 0 and no free hints | `HINT_UNAVAILABLE`, grid untouched, no ledger row |
| 9f | Spend where the move transaction then fails | Balance unchanged — debit rolled back |
| 9g | Grant beyond the 20-point cap | `CAP_REJECTED` row, amount 0, balance stays 20 |
| 9h | Guest seat requests a point-funded hint | `HINT_UNAVAILABLE`; no `HINT` wallet is created |
| 9i | **Leak: `HINT_USED` broadcast to other seats** | Carries the count only — no `index`, no `value` |
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

## 13. Hints & Hint Points

A hint is not a free action and it is not a giveaway. Two ideas, kept separate on purpose:

1. **What a hint tells you** — the *next logically deducible cell*, with the technique that proves
   it. Not a random answer. §13.2.
2. **What a hint costs you** — a small free per-match allowance (`maxHints`, default 3), and after
   that a **hint point**: a persistent, earned balance that survives the match. §13.1, §13.3.

### 13.1 Earning — the `HINT` wallet asset

Hint points are **not** a bespoke counter. They are a fourth `assetCode` on the existing wallet
(`COIN | GEM | TICKET | HINT`), which means they inherit, for free, every property the coin economy
was already built to guarantee ([../10-economy-and-rewards.md](../10-economy-and-rewards.md) §2):
an append-only `WalletTransaction` row per change, a balance that is Σ transactions rather than a
mutable number, a derived idempotency key under a DB unique constraint, the row-locked debit path,
admin oversight, and the reconciliation job.

| | |
|---|---|
| **Earn rate** | **1 point per 3 solved puzzles**, any difficulty |
| **Counter** | `PlayerStats(userId, 'sudoku').extraJson.solves` — incremented once per `SOLVED` match, in the settlement transaction |
| **Grant trigger** | The increment crosses a multiple of 3 |
| **Idempotency key** | `sudoku-hint:{userId}:{milestone}` where `milestone = floor(solves / 3)` |
| **Cap** | 20 points. A grant over the cap writes the existing `CAP_REJECTED` audit row (amount `0`) rather than silently vanishing |
| **Transaction kinds** | `HINT_GRANT` (credit) and `HINT_SPEND` (debit), new members of `TRANSACTION_KINDS` |
| **Not earned by** | `GIVE_UP`, an idle-abandoned match, or a race seat that never completed its grid |
| **Guests** | **Do not accrue hint points at all.** `GET /wallet` already surfaces `COIN` alone for a guest holder, and that stays true |

> **Why guests are excluded rather than provisional.** Coins are provisional for guests because a
> coin balance is worth carrying across the claim boundary. A hint point is only meaningful *across
> matches*, and a guest session is precisely the case where there is no reliable "across". Making
> it user-only removes a branch from the grant path, a branch from the spend path, and the entire
> question of what claiming a half-accrued milestone means — at the cost of nothing a guest would
> notice. The free `maxHints` allowance is per-match and still applies to guests in full.

The milestone-derived key is what makes this safe under retry. The unique constraint on
`(walletId, idempotencyKey)` means a settlement replayed twice, a reconnect that re-triggers the
path, or an operator re-running a job all collapse to the same single grant — the key is a function
of *how many puzzles you have solved*, not of when the code happened to run.

> **Not purchasable.** Hint points confer a gameplay advantage, so per the platform's hard rule
> they are earned only: no store item, no premium grant, no coin→hint exchange. Premium may not
> raise the earn rate either. The moment a hint point can be bought, the difficulty tiers stop
> meaning anything.

### 13.2 What a hint reveals — `nextHint`

```ts
type HintResult =
  | { kind: 'MOVE'; index: number; value: number; techniqueKey: string }
  | { kind: 'MISTAKE'; cells: number[] }   // the grid contradicts the solution
  | { kind: 'NONE' }                       // grid already complete

/** Pure. Exported from the engine module so the service can preview a hint
 *  without applying it (§13.3). */
function nextHint(state: SudokuState, seat: SeatId): HintResult
```

`nextHint` runs the **grading solver from §5** — the same technique-ranked solver that classifies a
puzzle's difficulty — against the player's live grid, and returns the *easiest* cell it can prove.
That reuse is the point: the solver has to exist for generation anyway, and a hint that names a
technique is the difference between a crutch and a teaching tool.

`techniqueKey` is an i18n key (`sudoku.technique.hiddenSingle`, `…nakedPair`,
`…pointingPair`, `…boxLineReduction`, `…xWing`), never a rendered sentence — same rule as every
other error and label on the platform. The client renders "R3C5 must be 7 — hidden single in box 2".

**The `MISTAKE` branch matters.** If the player has already entered a digit that contradicts the
solution, no technique can prove a next move, and the honest answer is not a cell — it is "you have
a wrong entry, here". `nextHint` returns the contradicting cells, the engine flags them exactly as
`CHECK` would, and — per §13.3 — **this costs nothing**.

### 13.3 Spending — where the debit happens

The engine is pure (I1): it cannot read a balance and cannot write a ledger row. So the order is
**compute, then charge, then apply**, inside `GameSessionService.applyWithin` — that is, within the
same transaction that already rebuilds state and appends the move's events:

```
client emits  { type: 'HINT' }           ← no funding field; one is ignored if sent
  │
  1. preview   nextHint(state, seat)
  │            └─ kind !== 'MOVE'  → apply the MISTAKE/NONE outcome, charge NOTHING, done
  │
  2. fund      free allowance left?      → funding = 'FREE'
  │            else allowHintPoints and balance > 0
  │                                      → debit 1 HINT (row-locked) → funding = 'POINT'
  │            else                      → HINT_UNAVAILABLE, no move applied
  │
  3. apply     engine.applyMove(state, seat, { type: 'HINT', funding }, rng)
```

Computing before charging is deliberate and it is the whole reason `nextHint` is exported as a pure
function rather than hidden inside `applyMove`. The alternative — charge, apply, refund on failure —
means a ledger that records a spend and a refund for something that never happened, and a refund
path is exactly the kind of code that is written once and then never exercised until it is wrong.
**A hint that cannot be given is never paid for.**

All three steps share the move's existing transaction, which requires a `WalletService.debitWithin`
mirroring the `creditWithin` that settlement already uses. That symmetry is the point: a move whose
event-append fails must not leave a point spent, and the only way to guarantee that without a
refund path is to let the same rollback cover both. The debit still goes through the row-locked
`balanceForUpdate` read, so two tabs racing for the last point cannot both spend it; the loser gets
`InsufficientFundsError`, surfaced as `HINT_UNAVAILABLE`.

| Failure | Result |
|---|---|
| No free hints, no points | `HINT_UNAVAILABLE` (`i18nKey` + `details.balance`), grid untouched |
| `allowHintPoints: false`, free hints spent | `HINT_UNAVAILABLE` |
| Grid contradicts the solution | `HINT_MISTAKE` event, cells flagged, **nothing charged** |
| Grid already complete | `HINT_NONE`, **nothing charged** |
| Guest seat | Free `maxHints` allowance only; no balance exists to spend (§13.1) |
| Move transaction rolls back after the debit | The debit rolls back with it — one transaction, no refund path |

### 13.4 Projection

`hintsUsed`, `hintPointsSpent` and the player's **hint-point balance** go to the owning seat.
In race mode, opponents see `hintsUsed` only — a hint is public information in a race (§6) — and
never a balance, which is account state rather than match state. The `HINT_USED` event broadcast to
other seats carries the *count*, never the `index`/`value`: telling the table which cell you were
given would hand them a free hint too.

### 13.5 Reward interaction

Hints still do not reduce the match reward (§12) — they already cost the player time, their free
allowance, and a balance that took three solved puzzles to build. But **a hint-funded solve does
not itself feed the earn counter any differently**: three solves is three solves, hinted or not.
That keeps the rule explainable in one sentence, which was the point of choosing it.

---

**Related:** [../05-game-engine-spec.md](../05-game-engine-spec.md) · [../04-realtime-protocol.md](../04-realtime-protocol.md) · [../10-economy-and-rewards.md](../10-economy-and-rewards.md) · [../08-roadmap.md](../08-roadmap.md) M1
