import { IllegalMoveError } from '../../errors/errors.js'
import type { SeatId } from '../../value-objects/seat.js'
import type {
  GameConfig,
  GameEngine,
  GameEventPayload,
  GameResult,
  GameStanding,
  MoveDescription,
  MoveResult,
  Viewer,
} from '../GameEngine.js'
import type { Rng } from '../shared/rng.js'
import { CELLS, SIZE, colOf, isGiven, isGridString, rowOf } from './grid.js'
import { generate } from './generator.js'
import { sudokuMeta } from './meta.js'
import { type Difficulty, type Technique, nextHint, techniqueKey } from './solver.js'

/**
 * ★ Sudoku — `games/sudoku.md`. M1's engine, and the first real one.
 *
 * Three things make it worth reading even though the rules are trivial:
 *
 *   1. **It is the projection mechanism's first real test.** `solution` lives in
 *      state and must never appear in a projection. There is no branch in
 *      `projectState` that emits it — the guard is the *shape* of the view type,
 *      not a filter somebody has to remember (I4).
 *   2. **A wrong entry is a legal move.** Every other game rejects an illegal
 *      move; Sudoku accepts a wrong digit, because refusing it would do the
 *      player's deduction for them (§3). The asymmetry is deliberate and is
 *      called out here so it does not read as a missing check.
 *   3. **It has no turns.** `toAct` does not exist, `legalMoves` is non-empty
 *      for every seated player at once, and `NotYourTurnError` is unreachable.
 *      `meta.turnTimeoutMs` is `null` for the same reason.
 *
 * **On time.** The engine cannot read a clock (I1), so it does not pretend to:
 * there is no `startedAt`/`solvedAt` in state. Race order is `solvedOrder`, an
 * integer assigned in the order seats finish, which is what actually decides a
 * race and is pure. Wall-clock duration is added by `GameSessionService` from
 * the event log, where the timestamps already are. The same applies to `CHECK`'s
 * 1-per-5-seconds limit (§3) — a rate limit is a clock, and clocks live outside.
 */

export type SudokuPhase = 'PLAYING' | 'SOLVED' | 'ABANDONED'

export type SudokuMode = 'solo' | 'race'

/** Who paid for a hint. **Server-authored** — never read from a client payload (§13.3). */
export type HintFunding = 'FREE' | 'POINT'

export type SudokuMove =
  | { readonly type: 'SET_CELL'; readonly index: number; readonly value: number }
  | { readonly type: 'CLEAR_CELL'; readonly index: number }
  | { readonly type: 'SET_NOTES'; readonly index: number; readonly digits: readonly number[] }
  | { readonly type: 'CHECK' }
  | { readonly type: 'HINT'; readonly funding: HintFunding }
  | { readonly type: 'GIVE_UP' }

export interface SudokuOptions {
  readonly difficulty: Difficulty
  readonly mode: SudokuMode
  readonly maxHints: number
  readonly allowHintPoints: boolean
  readonly allowNotes: boolean
  readonly autoCheckOnComplete: boolean
  readonly raceFinishWindowSec: number
}

/** What the last hint told this seat. Kept so a reconnect restores it (case 18). */
export interface LastHint {
  readonly index: number
  readonly value: number
  readonly techniqueKey: string
  readonly unit: { readonly kind: 'row' | 'col' | 'box'; readonly n: number } | null
}

/**
 * ★ Every field is a JSON primitive, array or plain record — no `Set`, `Map`,
 * `Date` or class instance (I5). `notes` and `flagged` are keyed by the cell's
 * decimal string because that is what `JSON.stringify` produces for a numeric
 * key anyway; §2 says so explicitly, and pretending otherwise is how a
 * round-trip test starts failing on a type nobody changed.
 */
export interface SudokuSeatState {
  readonly grid: string
  readonly notes: Readonly<Record<string, readonly number[]>>
  readonly filled: number
  readonly mistakes: number
  /** Total hints taken, free and point-funded alike (§13.1). */
  readonly hintsUsed: number
  /** Of those, how many were paid for with a hint point. */
  readonly hintPointsSpent: number
  /** Cells the server has confirmed wrong. Truth, unlike a client conflict mark. */
  readonly flagged: Readonly<Record<string, true>>
  /** 1-based finish order, `null` while unsolved. The race's actual ranking. */
  readonly solvedOrder: number | null
  readonly gaveUp: boolean
  readonly moves: number
  readonly lastHint: LastHint | null
}

export interface SudokuState {
  readonly phase: SudokuPhase
  /** The band that was requested — what the player chose and is rewarded for. */
  readonly difficulty: Difficulty
  /** What the grader says the puzzle actually is. Usually equal; §5 on why not always. */
  readonly graded: Difficulty
  /** 81 chars, `'0'` empty. Immutable for the game's life. */
  readonly puzzle: string
  /** ★ 81 chars. SERVER ONLY — must never appear in any projection. */
  readonly solution: string
  readonly seats: readonly SeatId[]
  readonly players: Readonly<Record<string, SudokuSeatState>>
  readonly mode: SudokuMode
  readonly winnerSeat: SeatId | null
  readonly solvedCount: number
  readonly options: SudokuOptions
}

/** The opponent-facing slice: progress, never a grid (§4). */
export interface SudokuOpponentView {
  readonly filled: number
  readonly mistakes: number
  /** Public in a race — a hint is information the table is entitled to (§6). */
  readonly hintsUsed: number
  readonly solvedOrder: number | null
  readonly gaveUp: boolean
}

export interface SudokuOwnView {
  readonly grid: string
  readonly notes: Readonly<Record<string, readonly number[]>>
  readonly filled: number
  readonly mistakes: number
  readonly hintsUsed: number
  readonly hintPointsSpent: number
  readonly freeHintsLeft: number
  readonly flagged: Readonly<Record<string, true>>
  readonly solvedOrder: number | null
  readonly gaveUp: boolean
  readonly lastHint: LastHint | null
}

/**
 * ★ What a viewer receives. Note what has no field here: `solution`. The leak is
 * prevented because there is nowhere for it to travel, not because a filter
 * removes it.
 */
export interface SudokuView {
  readonly phase: SudokuPhase
  readonly difficulty: Difficulty
  readonly puzzle: string
  readonly mode: SudokuMode
  readonly winnerSeat: number | null
  readonly seats: readonly number[]
  readonly maxHints: number
  readonly allowNotes: boolean
  /** The viewer's own board, or `null` for a spectator. */
  readonly me: SudokuOwnView | null
  /** Every *other* seat's progress. Counts only. */
  readonly others: Readonly<Record<string, SudokuOpponentView>>
}

/** Server-internal replay and dispute tooling only (05 §1). */
export interface SudokuOmniscientView extends SudokuView {
  readonly solution: string
  readonly graded: Difficulty
}

// ── Move narrowing ───────────────────────────────────────────────────────────

function isCellIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < CELLS
}

function isDigit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SIZE
}

function isSudokuMove(value: unknown): value is SudokuMove {
  if (typeof value !== 'object' || value === null) return false
  const move = value as { type?: unknown }

  switch (move.type) {
    case 'SET_CELL':
      return (
        isCellIndex((value as { index: unknown }).index) &&
        isDigit((value as { value: unknown }).value)
      )
    case 'CLEAR_CELL':
      return isCellIndex((value as { index: unknown }).index)
    case 'SET_NOTES': {
      const digits = (value as { digits: unknown }).digits
      return (
        isCellIndex((value as { index: unknown }).index) &&
        Array.isArray(digits) &&
        digits.length <= SIZE &&
        digits.every(isDigit) &&
        new Set(digits).size === digits.length
      )
    }
    case 'CHECK':
    case 'GIVE_UP':
      return true
    case 'HINT': {
      const funding = (value as { funding: unknown }).funding
      return funding === 'FREE' || funding === 'POINT'
    }
    default:
      return false
  }
}

// ── Seat helpers ─────────────────────────────────────────────────────────────

function freshSeat(puzzle: string): SudokuSeatState {
  return {
    grid: puzzle,
    notes: {},
    filled: countFilledCells(puzzle),
    mistakes: 0,
    hintsUsed: 0,
    hintPointsSpent: 0,
    flagged: {},
    solvedOrder: null,
    gaveUp: false,
    moves: 0,
    lastHint: null,
  }
}

function countFilledCells(grid: string): number {
  let n = 0
  for (let i = 0; i < CELLS; i++) if (grid.charCodeAt(i) !== 48) n++
  return n
}

function seatOf(state: SudokuState, seat: SeatId): SudokuSeatState {
  const player = state.players[String(seat)]
  if (player === undefined) {
    throw new IllegalMoveError('that seat is not in this game', { seat })
  }
  return player
}

/** Free hints still available to this seat, per `maxHints` (§13.1). */
export function freeHintsLeft(state: SudokuState, player: SudokuSeatState): number {
  return Math.max(0, state.options.maxHints - (player.hintsUsed - player.hintPointsSpent))
}

function writeCell(grid: string, index: number, digit: number): string {
  return grid.slice(0, index) + String(digit) + grid.slice(index + 1)
}

/** Cells this seat has filled that disagree with the solution. */
function wrongCells(grid: string, solution: string): number[] {
  const out: number[] = []
  for (let i = 0; i < CELLS; i++) {
    const entered = grid.charCodeAt(i)
    if (entered !== 48 && entered !== solution.charCodeAt(i)) out.push(i)
  }
  return out
}

function withPlayer(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
  extra: Partial<Pick<SudokuState, 'phase' | 'winnerSeat' | 'solvedCount'>> = {},
): SudokuState {
  return {
    ...state,
    players: { ...state.players, [String(seat)]: player },
    ...extra,
  }
}

/**
 * Has the match ended?
 *
 * In solo the first solve ends it. In a race it ends when **every** seat has
 * either solved or given up — `winnerSeat` already records who won, so keeping
 * the phase open is what lets the rest play for their own placing (§6) rather
 * than having the match yanked out from under them. The 60-second finish window
 * that bounds that wait is a timer, so it belongs to `GameSessionService`, which
 * abandons the stragglers when it expires.
 */
function allSeatsDone(state: SudokuState): boolean {
  return state.seats.every((seat) => {
    const player = state.players[String(seat)]
    return player !== undefined && (player.solvedOrder !== null || player.gaveUp)
  })
}

// ── The engine ───────────────────────────────────────────────────────────────

export const sudokuEngine: GameEngine<SudokuState, SudokuMove> = {
  meta: sudokuMeta,

  createInitialState(config: GameConfig, rng: Rng): SudokuState {
    const options = config.options as SudokuOptions
    const seats = [...config.seats].sort((a, b) => a - b)

    if (seats.length === 0) {
      throw new IllegalMoveError('a sudoku game needs at least one seated player')
    }

    // ★ One puzzle, one solution, every seat. Race fairness is not a policy
    // here — it is that there is only one puzzle to hand out (§6).
    const generated = generate(rng, options.difficulty)

    return {
      phase: 'PLAYING',
      difficulty: options.difficulty,
      graded: generated.graded,
      puzzle: generated.puzzle,
      solution: generated.solution,
      seats,
      players: Object.fromEntries(
        seats.map((seat) => [String(seat), freshSeat(generated.puzzle)]),
      ),
      mode: options.mode,
      winnerSeat: null,
      solvedCount: 0,
      options,
    }
  },

  /**
   * Every placement this seat could make, plus the control moves.
   *
   * **`SET_NOTES` is deliberately not enumerated.** Its `digits` parameter
   * ranges over all 512 subsets of 1–9 per cell, so a complete enumeration
   * would be tens of thousands of entries describing a pencil mark — a UI
   * affordance with no effect on the game's outcome. `applyMove` validates it
   * directly instead, and the I3 test asserts the throw-iff-illegal property
   * over the enumerable moves. Spelling that out here because a reader
   * comparing this list against `applyMove` should find the gap documented
   * rather than suspect it.
   */
  legalMoves(state: SudokuState, seat: SeatId): SudokuMove[] {
    if (state.phase !== 'PLAYING') return []
    const player = state.players[String(seat)]
    if (player === undefined || player.gaveUp || player.solvedOrder !== null) return []

    const moves: SudokuMove[] = [{ type: 'CHECK' }, { type: 'GIVE_UP' }]

    // A hint is only offered when one can actually be funded. `POINT` funding
    // depends on a wallet balance the engine cannot see, so it is never listed:
    // the service adds it when it has paid for it.
    if (freeHintsLeft(state, player) > 0) moves.push({ type: 'HINT', funding: 'FREE' })

    for (let index = 0; index < CELLS; index++) {
      if (isGiven(state.puzzle, index)) continue
      if (player.grid.charCodeAt(index) !== 48) moves.push({ type: 'CLEAR_CELL', index })
      for (let value = 1; value <= SIZE; value++) {
        // ★ No legality filter on `value`. A wrong digit is a legal move (§3).
        moves.push({ type: 'SET_CELL', index, value })
      }
    }

    return moves
  },

  applyMove(
    state: SudokuState,
    seat: SeatId,
    move: SudokuMove,
    _rng: Rng,
  ): MoveResult<SudokuState> {
    if (state.phase !== 'PLAYING') {
      throw new IllegalMoveError('the game is over', { phase: state.phase })
    }
    if (!isSudokuMove(move)) {
      throw new IllegalMoveError('unknown move', { move })
    }

    const player = seatOf(state, seat)
    if (player.gaveUp) {
      throw new IllegalMoveError('this seat gave up', { seat })
    }
    if (player.solvedOrder !== null) {
      throw new IllegalMoveError('this seat has already solved the puzzle', { seat })
    }

    const bumped: SudokuSeatState = { ...player, moves: player.moves + 1 }

    switch (move.type) {
      case 'SET_CELL':
        return applySetCell(state, seat, bumped, move.index, move.value)
      case 'CLEAR_CELL':
        return applyClearCell(state, seat, bumped, move.index)
      case 'SET_NOTES':
        return applySetNotes(state, seat, bumped, move.index, move.digits)
      case 'CHECK':
        return applyCheck(state, seat, bumped)
      case 'HINT':
        return applyHint(state, seat, bumped, move.funding)
      case 'GIVE_UP':
        return applyGiveUp(state, seat, bumped)
    }
  },

  /** ★ I4. One state in, N different payloads out — and never the solution. */
  projectState(state: SudokuState, viewer: Viewer): SudokuView | SudokuOmniscientView {
    const own = viewer.kind === 'seat' ? state.players[String(viewer.seat)] : undefined

    const others: Record<string, SudokuOpponentView> = {}
    for (const [key, player] of Object.entries(state.players)) {
      if (viewer.kind === 'seat' && key === String(viewer.seat)) continue
      others[key] = {
        filled: player.filled,
        mistakes: player.mistakes,
        hintsUsed: player.hintsUsed,
        solvedOrder: player.solvedOrder,
        gaveUp: player.gaveUp,
      }
    }

    const base: SudokuView = {
      phase: state.phase,
      difficulty: state.difficulty,
      puzzle: state.puzzle,
      mode: state.mode,
      winnerSeat: state.winnerSeat,
      seats: [...state.seats],
      maxHints: state.options.maxHints,
      allowNotes: state.options.allowNotes,
      me:
        own === undefined
          ? null
          : {
              grid: own.grid,
              notes: { ...own.notes },
              filled: own.filled,
              mistakes: own.mistakes,
              hintsUsed: own.hintsUsed,
              hintPointsSpent: own.hintPointsSpent,
              freeHintsLeft: freeHintsLeft(state, own),
              flagged: { ...own.flagged },
              solvedOrder: own.solvedOrder,
              gaveUp: own.gaveUp,
              lastHint: own.lastHint,
            },
      others,
    }

    if (viewer.kind === 'omniscient') {
      return { ...base, solution: state.solution, graded: state.graded }
    }
    return base
  },

  isTerminal(state: SudokuState): boolean {
    return state.phase !== 'PLAYING'
  },

  result(state: SudokuState): GameResult {
    if (state.phase === 'PLAYING') {
      throw new IllegalMoveError('result() is only valid on a terminal state')
    }

    const ordered = [...state.seats].sort((a, b) => {
      const pa = state.players[String(a)]
      const pb = state.players[String(b)]
      const oa = pa?.solvedOrder ?? Number.POSITIVE_INFINITY
      const ob = pb?.solvedOrder ?? Number.POSITIVE_INFINITY
      if (oa !== ob) return oa - ob
      return a - b
    })

    const standings: GameStanding[] = ordered.map((seat, i) => {
      const player = seatOf(state, seat)
      return {
        seat,
        rank: player.solvedOrder === null ? ordered.length : i + 1,
        // Fewer moves is a better solve. The wall-clock time §8 reports is
        // added by the session service from the event log — see the note at the
        // top of this file on why the engine has no clock.
        score: player.moves,
        /**
         * Every seat reports `COMPLETED` or `RESIGNED` from what the engine can
         * see. Ejection is `GameSessionService`'s business (S33) and it
         * overwrites this before settlement — an engine that knew about
         * ejection would need to know about timers, which I1 forbids.
         */
        outcome: player.gaveUp ? 'RESIGNED' : 'COMPLETED',
        playedFraction: 1,
      }
    })

    const anySolved = state.seats.some((s) => state.players[String(s)]?.solvedOrder !== null)

    return {
      standings,
      summary: {
        difficulty: state.difficulty,
        graded: state.graded,
        mode: state.mode,
        givens: countFilledCells(state.puzzle),
        winnerSeat: state.winnerSeat,
        perSeat: Object.fromEntries(
          Object.entries(state.players).map(([key, player]) => [
            key,
            {
              solvedOrder: player.solvedOrder,
              moves: player.moves,
              mistakes: player.mistakes,
              hintsUsed: player.hintsUsed,
              hintPointsSpent: player.hintPointsSpent,
              gaveUp: player.gaveUp,
            },
          ]),
        ),
      },
      reason: anySolved ? 'NORMAL' : state.phase === 'ABANDONED' ? 'ABANDONED' : 'RESIGNATION',
    }
  },

  describeMove(_state: SudokuState, seat: SeatId, move: SudokuMove): MoveDescription {
    switch (move.type) {
      case 'SET_CELL':
        return {
          key: 'games.sudoku.move.setCell',
          params: { seat, row: rowOf(move.index) + 1, col: colOf(move.index) + 1, value: move.value },
        }
      case 'CLEAR_CELL':
        return {
          key: 'games.sudoku.move.clearCell',
          params: { seat, row: rowOf(move.index) + 1, col: colOf(move.index) + 1 },
        }
      case 'SET_NOTES':
        return {
          key: 'games.sudoku.move.setNotes',
          params: { seat, row: rowOf(move.index) + 1, col: colOf(move.index) + 1 },
        }
      case 'CHECK':
        return { key: 'games.sudoku.move.check', params: { seat } }
      case 'HINT':
        return { key: 'games.sudoku.move.hint', params: { seat, funding: move.funding } }
      case 'GIVE_UP':
        return { key: 'games.sudoku.move.giveUp', params: { seat } }
    }
  },
}

// ── Move handlers ────────────────────────────────────────────────────────────

function applySetCell(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
  index: number,
  value: number,
): MoveResult<SudokuState> {
  if (isGiven(state.puzzle, index)) {
    throw new IllegalMoveError('that cell is a given', { index })
  }

  const grid = writeCell(player.grid, index, value)
  const flagged = { ...player.flagged }
  // Re-entering a flagged cell clears the flag: the player has answered the
  // server's "this is wrong", and leaving the mark would make it a permanent
  // accusation about a cell that may now be right.
  delete flagged[String(index)]

  const notes = { ...player.notes }
  delete notes[String(index)]

  const next: SudokuSeatState = {
    ...player,
    grid,
    notes,
    flagged,
    filled: countFilledCells(grid),
  }

  const events: GameEventPayload[] = [
    { kind: 'MOVE', seat, payload: { move: { type: 'SET_CELL', index, value } } },
  ]

  if (next.filled < CELLS || !state.options.autoCheckOnComplete) {
    return { state: withPlayer(state, seat, next), events }
  }

  return completeGrid(state, seat, next, events)
}

/**
 * The grid just filled up. Either it matches the solution or it does not, and a
 * mismatch is **not** the end of the game (§3) — the mistakes are flagged and
 * play continues.
 */
function completeGrid(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
  events: GameEventPayload[],
): MoveResult<SudokuState> {
  const wrong = wrongCells(player.grid, state.solution)

  if (wrong.length > 0) {
    const flagged: Record<string, true> = { ...player.flagged }
    for (const index of wrong) flagged[String(index)] = true

    const next: SudokuSeatState = {
      ...player,
      flagged,
      mistakes: player.mistakes + wrong.length,
    }
    events.push({
      kind: 'MOVE',
      seat,
      payload: { result: 'GRID_INCORRECT', wrong: wrong.length },
    })
    return { state: withPlayer(state, seat, next), events }
  }

  const solvedOrder = state.solvedCount + 1
  const next: SudokuSeatState = { ...player, solvedOrder, flagged: {} }
  const winnerSeat = state.winnerSeat ?? seat

  const provisional = withPlayer(state, seat, next, {
    winnerSeat,
    solvedCount: solvedOrder,
  })
  const finished = state.mode === 'solo' || allSeatsDone(provisional)

  events.push({ kind: 'MOVE', seat, payload: { result: 'SOLVED', solvedOrder } })
  if (finished) {
    events.push({ kind: 'PHASE', seat: null, payload: { phase: 'SOLVED', winnerSeat } })
  }

  return {
    state: finished ? { ...provisional, phase: 'SOLVED' } : provisional,
    events,
  }
}

function applyClearCell(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
  index: number,
): MoveResult<SudokuState> {
  if (isGiven(state.puzzle, index)) {
    throw new IllegalMoveError('that cell is a given', { index })
  }
  if (player.grid.charCodeAt(index) === 48) {
    throw new IllegalMoveError('that cell is already empty', { index })
  }

  const grid = writeCell(player.grid, index, 0)
  const flagged = { ...player.flagged }
  delete flagged[String(index)]

  return {
    state: withPlayer(state, seat, {
      ...player,
      grid,
      flagged,
      filled: countFilledCells(grid),
    }),
    events: [{ kind: 'MOVE', seat, payload: { move: { type: 'CLEAR_CELL', index } } }],
  }
}

function applySetNotes(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
  index: number,
  digits: readonly number[],
): MoveResult<SudokuState> {
  if (!state.options.allowNotes) {
    throw new IllegalMoveError('notes are disabled for this table')
  }
  if (isGiven(state.puzzle, index)) {
    throw new IllegalMoveError('that cell is a given', { index })
  }
  if (player.grid.charCodeAt(index) !== 48) {
    throw new IllegalMoveError('that cell is filled', { index })
  }

  const notes = { ...player.notes }
  if (digits.length === 0) delete notes[String(index)]
  else notes[String(index)] = [...digits].sort((a, b) => a - b)

  return {
    state: withPlayer(state, seat, { ...player, notes }),
    events: [{ kind: 'MOVE', seat, payload: { move: { type: 'SET_NOTES', index } } }],
  }
}

/**
 * `CHECK` — flag every filled cell that disagrees with the solution.
 *
 * Note what it does **not** return: the right answers. `flagged` says *which*
 * cells are wrong and never what belongs there (§4), so a player who spams
 * `CHECK` learns only what they already could have deduced from being told they
 * are wrong.
 */
function applyCheck(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
): MoveResult<SudokuState> {
  const wrong = wrongCells(player.grid, state.solution)
  const flagged: Record<string, true> = {}
  for (const index of wrong) flagged[String(index)] = true

  return {
    state: withPlayer(state, seat, {
      ...player,
      flagged,
      mistakes: player.mistakes + wrong.length,
    }),
    events: [{ kind: 'MOVE', seat, payload: { result: 'CHECKED', wrong: wrong.length } }],
  }
}

/**
 * ★ `HINT` — `games/sudoku.md` §13.2.
 *
 * The engine computes the hint itself rather than trusting one supplied in the
 * move, and that is what keeps it honest: `nextHint` is deterministic, so the
 * service's pre-move preview (which decided whether to charge) and this call
 * necessarily agree. A hint passed in as data could be forged; a hint recomputed
 * cannot.
 *
 * `MISTAKE` and `NONE` consume nothing — not a free hint, not a point, not the
 * funding the caller arrived with. §13.3: a hint that cannot be given is never
 * paid for.
 */
function applyHint(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
  funding: HintFunding,
): MoveResult<SudokuState> {
  const hint = nextHint(player.grid, state.solution)

  if (hint.kind === 'MISTAKE') {
    const flagged: Record<string, true> = { ...player.flagged }
    for (const index of hint.cells) flagged[String(index)] = true
    return {
      state: withPlayer(state, seat, { ...player, flagged }),
      events: [
        {
          kind: 'MOVE',
          seat,
          payload: { result: 'HINT_MISTAKE', wrong: hint.cells.length },
        },
      ],
    }
  }

  if (hint.kind === 'NONE') {
    return {
      state: withPlayer(state, seat, player),
      events: [{ kind: 'MOVE', seat, payload: { result: 'HINT_NONE' } }],
    }
  }

  if (funding === 'FREE' && freeHintsLeft(state, player) <= 0) {
    throw new IllegalMoveError('no free hints left', {
      i18nKey: 'games.sudoku.error.noFreeHints',
      maxHints: state.options.maxHints,
    })
  }
  if (funding === 'POINT' && !state.options.allowHintPoints) {
    throw new IllegalMoveError('hint points are disabled for this table', {
      i18nKey: 'games.sudoku.error.hintPointsDisabled',
    })
  }

  const grid = writeCell(player.grid, hint.index, hint.value)
  const notes = { ...player.notes }
  delete notes[String(hint.index)]

  const lastHint: LastHint = {
    index: hint.index,
    value: hint.value,
    techniqueKey: techniqueKey(hint.technique),
    unit: hint.unit,
  }

  const next: SudokuSeatState = {
    ...player,
    grid,
    notes,
    filled: countFilledCells(grid),
    hintsUsed: player.hintsUsed + 1,
    hintPointsSpent: player.hintPointsSpent + (funding === 'POINT' ? 1 : 0),
    lastHint,
  }

  /**
   * ★ The broadcast payload carries the **count, never the cell** (§13.4).
   * Telling the table which cell you were given would hand every other seat the
   * same hint for free, and in a race that is the whole game.
   */
  const events: GameEventPayload[] = [
    {
      kind: 'MOVE',
      seat,
      payload: {
        result: 'HINT_USED',
        funding,
        hintsUsed: next.hintsUsed,
        technique: hint.technique satisfies Technique,
      },
    },
  ]

  if (next.filled < CELLS || !state.options.autoCheckOnComplete) {
    return { state: withPlayer(state, seat, next), events }
  }
  return completeGrid(state, seat, next, events)
}

function applyGiveUp(
  state: SudokuState,
  seat: SeatId,
  player: SudokuSeatState,
): MoveResult<SudokuState> {
  const next: SudokuSeatState = { ...player, gaveUp: true }
  const provisional = withPlayer(state, seat, next)
  const finished = state.mode === 'solo' || allSeatsDone(provisional)

  const events: GameEventPayload[] = [
    { kind: 'MOVE', seat, payload: { move: { type: 'GIVE_UP' } } },
  ]
  if (finished) {
    events.push({
      kind: 'PHASE',
      seat: null,
      payload: { phase: 'ABANDONED', winnerSeat: state.winnerSeat },
    })
  }

  return {
    state: finished
      ? { ...provisional, phase: state.winnerSeat === null ? 'ABANDONED' : 'SOLVED' }
      : provisional,
    events,
  }
}

/** Re-exported so the session service can preview a hint without applying it (§13.3). */
export { nextHint, isGridString }
