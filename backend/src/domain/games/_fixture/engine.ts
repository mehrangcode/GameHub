import { IllegalMoveError, NotYourTurnError } from '../../errors/errors.js'
import type { SeatId } from '../../value-objects/seat.js'
import type {
  BotStrategy,
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
import { fixtureMeta } from './meta.js'

/**
 * The `fixture` engine — 11-build-plan.md §1.1, S30.
 *
 * The first implementation of {@link GameEngine}, and therefore the first proof
 * that the interface written at S17 is usable. It is deliberately trivial:
 * seats take turns pressing a button, and the first to `target` presses wins.
 *
 * What it is *not* is a toy. Three properties make it carry real weight for the
 * rest of M0:
 *
 *   1. **It has hidden information.** Each seat is dealt a `secret` number at
 *      creation, and `projectState` reveals only the viewer's own. That gives
 *      the generic leak-test harness (`tests/helpers/leak.ts`) something real to
 *      catch four sessions before Sudoku exists, and it is what makes the two
 *      terminals in S30's verification step visibly differ.
 *   2. **It has a genuine `advance()`.** Winning does not finish the game inside
 *      `applyMove`; it sets `pendingWinner`, and the *next* `advance()` turns
 *      that into the `FINISHED` phase and a `PHASE` event. That is the same
 *      shape a real game uses to resolve a trick or deal the next street, so
 *      `GameSessionService`'s advance loop is exercised rather than merely
 *      written.
 *   3. **It obeys all five invariants**, and `tests/unit/games/fixture-engine.test.ts`
 *      asserts each of them by name. State holds no `Set`, no `Map`, no `Date`
 *      and no class instance (I5); every transition returns fresh objects (I2);
 *      randomness arrives only through the injected `Rng` (I1).
 *
 * It is **not deleted at M1**. It stays as the interface's regression fixture
 * and the reference implementation the real engines are copied from.
 */

export type FixturePhase = 'PLAYING' | 'FINISHED'

export interface FixtureMove {
  readonly kind: 'press' | 'pass'
}

/**
 * ★ Every field is a JSON primitive, an array, or a plain record — never a
 * `Set`, a `Map` or a `Date` (I5). `counts` is keyed by the seat's decimal
 * string because that is what `JSON.stringify` produces for a numeric key
 * anyway, and pretending otherwise is how a round-trip test starts failing on a
 * type nobody changed.
 */
export interface FixtureState {
  readonly phase: FixturePhase
  readonly target: number
  readonly seats: readonly SeatId[]
  /** Whose turn it is. `null` once the game is over. */
  readonly toAct: SeatId | null
  /** Seat → presses so far. */
  readonly counts: Readonly<Record<string, number>>
  /** ★ Seat → a private number. The thing the leak tests hunt for. */
  readonly secrets: Readonly<Record<string, number>>
  /** Total moves applied. Drives nothing; makes a replay mismatch legible. */
  readonly turn: number
  /** Set by the winning press, consumed by the next `advance()`. */
  readonly pendingWinner: SeatId | null
  readonly winner: SeatId | null
}

interface FixtureOptions {
  readonly target: number
  readonly strikesResetOnAction: boolean
}

/** The projection a seat or a spectator actually receives. */
export interface FixtureView {
  readonly phase: FixturePhase
  readonly target: number
  readonly seats: readonly number[]
  readonly toAct: number | null
  readonly counts: Readonly<Record<string, number>>
  readonly turn: number
  readonly winner: number | null
  /**
   * ★ The viewer's **own** secret, or `null` for a spectator. Note what is not
   * here: there is no field in which another seat's secret could travel, so the
   * leak is prevented by the shape rather than by a filter somebody has to
   * remember to apply.
   */
  readonly secret: number | null
}

/**
 * What `omniscient` gets — server-internal replay and dispute tooling only
 * (05 §1). Never reachable from a broadcast: `GameSessionService` projects for
 * seats and for spectators, and there is no third call site.
 */
export interface FixtureOmniscientView extends FixtureView {
  readonly secrets: Readonly<Record<string, number>>
}

/** Distinct 7-digit numbers, so a substring search for one cannot match another. */
function dealSecrets(seats: readonly SeatId[], rng: Rng): Record<string, number> {
  const secrets: Record<string, number> = {}
  const used = new Set<number>()

  for (const seat of seats) {
    let value = 0
    // Drawn until distinct. Collisions are rare and the retry is deterministic
    // under a seeded generator, which is what keeps replay byte-identical — a
    // near-miss here would make the leak assertions pass by coincidence.
    do {
      value = 1_000_000 + rng.int(9_000_000)
    } while (used.has(value))
    used.add(value)
    secrets[String(seat)] = value
  }

  return secrets
}

function nextActing(state: FixtureState, from: SeatId): SeatId | null {
  const index = state.seats.indexOf(from)
  if (index === -1) return state.seats[0] ?? null
  return state.seats[(index + 1) % state.seats.length] ?? null
}

function isFixtureMove(value: unknown): value is FixtureMove {
  return (
    typeof value === 'object' &&
    value !== null &&
    ((value as FixtureMove).kind === 'press' || (value as FixtureMove).kind === 'pass')
  )
}

export const fixtureEngine: GameEngine<FixtureState, FixtureMove> = {
  meta: fixtureMeta,

  createInitialState(config: GameConfig, rng: Rng): FixtureState {
    const options = config.options as FixtureOptions
    const seats = [...config.seats].sort((a, b) => a - b)

    if (seats.length === 0) {
      throw new IllegalMoveError('a fixture game needs at least one seated player')
    }

    return {
      phase: 'PLAYING',
      target: options.target,
      seats,
      toAct: seats[0] ?? null,
      counts: Object.fromEntries(seats.map((seat) => [String(seat), 0])),
      secrets: dealSecrets(seats, rng),
      turn: 0,
      pendingWinner: null,
      winner: null,
    }
  },

  legalMoves(state: FixtureState, seat: SeatId): FixtureMove[] {
    // Empty when it is not their turn — which is the contract, and is why
    // `legalMoves` alone is never the enforcement point.
    if (state.phase !== 'PLAYING' || state.toAct !== seat) return []
    return [{ kind: 'press' }, { kind: 'pass' }]
  },

  applyMove(
    state: FixtureState,
    seat: SeatId,
    move: FixtureMove,
    _rng: Rng,
  ): MoveResult<FixtureState> {
    if (state.phase !== 'PLAYING') {
      throw new IllegalMoveError('the game is over', { phase: state.phase })
    }
    if (!state.seats.includes(seat)) {
      throw new IllegalMoveError('that seat is not in this game', { seat })
    }
    // ★ Turn before legality: "not your turn" and "that is not a move" are
    // different answers and the player acts on them differently.
    if (state.toAct !== seat) {
      throw new NotYourTurnError('it is not your turn', { seat, toAct: state.toAct })
    }
    if (!isFixtureMove(move)) {
      throw new IllegalMoveError('unknown move', { move })
    }

    const key = String(seat)
    const pressed = move.kind === 'press'
    const count = (state.counts[key] ?? 0) + (pressed ? 1 : 0)
    const reachedTarget = pressed && count >= state.target

    const next: FixtureState = {
      ...state,
      counts: { ...state.counts, [key]: count },
      toAct: reachedTarget ? state.toAct : nextActing(state, seat),
      turn: state.turn + 1,
      pendingWinner: reachedTarget ? seat : null,
    }

    const events: GameEventPayload[] = [
      { kind: 'MOVE', seat, payload: { move: { kind: move.kind }, count } },
    ]

    return { state: next, events }
  },

  /**
   * The only thing that happens with nobody acting: converting a winning press
   * into the finished phase.
   *
   * It returns `null` on the second call, which is what makes the session
   * service's `while (advance())` loop terminate — and there is a test named
   * after exactly that, because a non-terminating `advance` would hang a real
   * request rather than failing it.
   */
  advance(state: FixtureState, _rng: Rng): MoveResult<FixtureState> | null {
    if (state.phase !== 'PLAYING' || state.pendingWinner === null) return null

    const winner = state.pendingWinner
    const next: FixtureState = {
      ...state,
      phase: 'FINISHED',
      toAct: null,
      pendingWinner: null,
      winner,
    }

    return {
      state: next,
      events: [{ kind: 'PHASE', seat: null, payload: { phase: 'FINISHED', winner } }],
    }
  },

  /** ★ I4 — the anti-cheat boundary. One state in, N different payloads out. */
  projectState(state: FixtureState, viewer: Viewer): FixtureView | FixtureOmniscientView {
    const base: FixtureView = {
      phase: state.phase,
      target: state.target,
      seats: [...state.seats],
      toAct: state.toAct,
      counts: { ...state.counts },
      turn: state.turn,
      winner: state.winner,
      secret: viewer.kind === 'seat' ? (state.secrets[String(viewer.seat)] ?? null) : null,
    }

    if (viewer.kind === 'omniscient') return { ...base, secrets: { ...state.secrets } }
    return base
  },

  isTerminal(state: FixtureState): boolean {
    return state.phase === 'FINISHED'
  },

  result(state: FixtureState): GameResult {
    if (state.phase !== 'FINISHED') {
      throw new IllegalMoveError('result() is only valid on a terminal state')
    }

    const standings: GameStanding[] = state.seats.map((seat) => ({
      seat,
      rank: seat === state.winner ? 1 : 2,
      score: state.counts[String(seat)] ?? 0,
      /**
       * Every seat reports `COMPLETED` here. Ejection is not the engine's
       * business — it is `GameSessionService`'s (S33), which overwrites the
       * per-seat outcome from `TableMember.ejectionReason` before settlement.
       * An engine that read ejection state would need to know about timers,
       * and a timer is exactly the kind of I/O I1 forbids.
       */
      outcome: 'COMPLETED',
      playedFraction: 1,
    }))

    return {
      standings,
      summary: { winner: state.winner, turns: state.turn, target: state.target },
      reason: 'NORMAL',
    }
  },

  bot: {
    difficulty: 'medium',
    chooseMove(_state, _seat, legal): FixtureMove {
      // Presses if it can. A bot that passed forever would make S33's
      // "the table plays on" exit criterion vacuously true.
      return legal.find((move) => move.kind === 'press') ?? (legal[0] as FixtureMove)
    },
  } satisfies BotStrategy<FixtureState, FixtureMove>,

  describeMove(_state: FixtureState, seat: SeatId, move: FixtureMove): MoveDescription {
    return {
      key: move.kind === 'press' ? 'games.fixture.move.press' : 'games.fixture.move.pass',
      params: { seat },
    }
  },
}
