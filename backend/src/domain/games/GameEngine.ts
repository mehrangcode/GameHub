import type { z } from 'zod'
import type {
  BotDifficulty,
  GameEventKind,
  MatchReason,
  SeatOutcome,
} from '../../contracts/enums.js'
import type { SeatId } from '../value-objects/seat.js'
import type { Rng } from './shared/rng.js'

/**
 * ★ The engine contract — 05-game-engine-spec.md §1.
 *
 * Written in full at S17, two milestones before the first real engine, and
 * deliberately so: every service built between here and M1 is built against
 * this shape, which is what stops "the platform" and "the games" from growing
 * two incompatible ideas of what a game is. The `_fixture` engine (S30) is the
 * first implementation and therefore the first proof the interface works.
 *
 * The five invariants every implementation is held to (05 §2):
 *
 * | | |
 * |---|---|
 * | **I1** | Pure & deterministic — no `Date.now()`, no `Math.random()`, no I/O, no globals |
 * | **I2** | Immutable — `applyMove` returns new state and never mutates its input |
 * | **I3** | Totally legal — `applyMove` throws for anything not in `legalMoves` |
 * | **I4** | Projection-complete — `projectState` strips everything the viewer may not know |
 * | **I5** | Serializable — state round-trips through `JSON.stringify`/`parse` unchanged |
 *
 * Time and randomness are *injected* (`rng`), which is what reduces every
 * reported bug to `(seed, moves[])`.
 */

/** Who is being shown state. `omniscient` is server-internal and replay tooling only. */
export type Viewer =
  | { readonly kind: 'seat'; readonly seat: SeatId }
  | { readonly kind: 'spectator' }
  | { readonly kind: 'omniscient' }

export function seatViewer(seat: SeatId): Viewer {
  return { kind: 'seat', seat }
}

export const SPECTATOR: Viewer = { kind: 'spectator' }
export const OMNISCIENT: Viewer = { kind: 'omniscient' }

/** Preview-card data for the welcome page. i18n keys, never literal text (02 §8.1). */
export interface GamePreview {
  readonly nameKey: string
  readonly taglineKey: string
  readonly complexity: 'light' | 'medium' | 'heavy'
  /** `[min, max]` minutes for a typical match. */
  readonly avgMinutes: readonly [number, number]
  /** Asset path, resolved by the client. */
  readonly art: string
  readonly hasHiddenInfo: boolean
  readonly usesStandardDeck: boolean
}

/**
 * A queueable matchmaking preset (09 §2).
 *
 * `options` must be a **fixed literal**, not user-adjustable: the pool key is
 * the preset id, and a preset whose options varied per player would put two
 * people in the same bucket playing different rules. House-rule experiments
 * belong on private tables.
 */
export interface MatchmakingPreset {
  readonly id: string
  readonly nameKey: string
  readonly seatCount: number
  readonly options: Record<string, unknown>
  /** Wait this long for a full human table before accepting bots. */
  readonly preferHumansMs: number
}

export interface GameMeta {
  /** Stable; appears in URLs, the registry, `RewardRule.gameSlug` and `Table.gameSlug`. */
  readonly slug: string
  readonly minPlayers: number
  readonly maxPlayers: number
  /** Seat counts that are actually playable — Shelem `[4]`, Poker `[2,3,4,5,6]`. */
  readonly playableCounts: readonly number[]
  readonly teams?: { readonly size: number; readonly count: number }

  /** Per-table options. `POST /tables` validates against this, `/games/:slug` publishes it. */
  readonly optionsSchema: z.ZodTypeAny
  readonly defaultOptions: Record<string, unknown>

  /**
   * The game is announced but not yet playable — the welcome page renders its
   * preview card greyed out, and `POST /tables` refuses the slug.
   *
   * Declared rather than derived from "has an engine", because the two are not
   * the same claim: an engine can exist and pass its unit tests while the
   * renderer, the reward rule or the bot is still missing. Each milestone flips
   * its own game's flag as the last step of shipping it, which is a decision
   * someone makes rather than a side effect of a file existing.
   *
   * `11-build-plan.md` S17 requires this field, and `05-game-engine-spec.md`
   * §1 has been amended to carry it.
   */
  readonly comingSoon: boolean

  readonly preview: GamePreview

  /**
   * Per-move turn limit; `null` = untimed (Sudoku is a puzzle; Chess's own
   * clock *is* the limit). 04 §6.1.
   *
   * Enforcement lives in `GameSessionService`, never here — an engine that read
   * a clock would break I1. This is a **declaration**, not a timer.
   */
  readonly turnTimeoutMs: number | null
  /** Per-phase overrides — Shelem's bidding gets longer than its card play. */
  readonly turnTimeoutByPhaseMs?: Readonly<Record<string, number>>

  /**
   * The safest move to apply on a non-final timeout strike (04 §6.5). `null`
   * when there is no safe default and the strike simply passes.
   *
   * Method syntax, not a property, on purpose: under `strictFunctionTypes` a
   * property would make the `state` parameter contravariant and an engine's
   * concrete `(state: ShelemState, …)` would not satisfy a non-generic
   * `GameMeta`. Methods stay bivariant, which is what lets one registry hold
   * six differently-stated engines.
   *
   * It must never spend a resource the player did not authorize — no raise, no
   * insurance, no double.
   */
  defaultActionOnTimeout(state: unknown, seat: SeatId): unknown | null

  /** Disconnect grace before the seat is ejected and bot-substituted (04 §5.2). */
  readonly disconnectGraceMs: number
  /** Whether a bot-held seat may be reclaimed mid-hand, or only at a boundary (04 §6.4). */
  readonly reclaimAt: 'IMMEDIATE' | 'HAND_BOUNDARY' | 'NEVER'

  readonly supportsSpectators: boolean
  readonly supportsBots: boolean

  readonly matchmaking: {
    readonly enabled: boolean
    readonly presets: readonly MatchmakingPreset[]
  }
}

/** What an engine emits alongside a new state. Persisted, then broadcast and replayed. */
export interface GameEventPayload {
  readonly kind: GameEventKind
  readonly seat: SeatId | null
  readonly payload: Record<string, unknown>
}

export interface MoveResult<S> {
  readonly state: S
  readonly events: readonly GameEventPayload[]
}

export interface GameConfig {
  /** Occupied seats at the start of the deal. */
  readonly seats: readonly SeatId[]
  /** Already validated against `meta.optionsSchema` — an engine never re-checks. */
  readonly options: unknown
  /** `describeMove` convenience only. Never branch game rules on it. */
  readonly locale?: string
}

export interface GameStanding {
  readonly seat: SeatId
  readonly rank: number
  readonly score: number
  /** ★ Per **seat**, not per team: a winning partnership can contain an ejected player. */
  readonly outcome: SeatOutcome
  /** Fraction of the match this human actually played; the bot remainder is excluded. */
  readonly playedFraction: number
}

export interface GameResult {
  /** Best first. Ties share a rank. */
  readonly standings: readonly GameStanding[]
  readonly winningTeam?: number
  /** Free-form per-game summary; persisted to `MatchResult.summaryJson`. */
  readonly summary: Record<string, unknown>
  readonly reason: MatchReason
}

export interface BotStrategy<S, M> {
  /** Must be fast (< 50 ms) and pure. Difficulty tiers are separate strategies. */
  chooseMove(state: S, seat: SeatId, legal: readonly M[], rng: Rng): M
  readonly difficulty: BotDifficulty
}

/** A move rendered for chat, the move log and replay — i18n key + params, never prose. */
export interface MoveDescription {
  readonly key: string
  readonly params: Record<string, unknown>
}

export interface GameEngine<S, M> {
  readonly meta: GameMeta

  /** Deterministic given `(config, rng)`. No I/O. */
  createInitialState(config: GameConfig, rng: Rng): S

  /** Every currently legal move for a seat. Empty when it is not their turn. */
  legalMoves(state: S, seat: SeatId): M[]

  /**
   * @throws {IllegalMoveError} for a move outside `legalMoves` (I3)
   * @throws {NotYourTurnError} when it is another seat's turn
   *
   * `legalMoves` is a convenience for the UI. **This** is the enforcement
   * point, because the client is untrusted (P1).
   */
  applyMove(state: S, seat: SeatId, move: M, rng: Rng): MoveResult<S>

  /**
   * Moves the game forward with nobody acting: deal the next street, resolve a
   * finished trick, run the dealer's hand. The session service calls it in a
   * loop until it returns `null`.
   */
  advance?(state: S, rng: Rng): MoveResult<S> | null

  /** ★ The anti-cheat boundary (I4). Returns only what this viewer may know. */
  projectState(state: S, viewer: Viewer): unknown

  isTerminal(state: S): boolean

  /** Only valid when `isTerminal(state)`. */
  result(state: S): GameResult

  /** Optional. Required for the slug to appear in "fill with bot" UI. */
  readonly bot?: BotStrategy<S, M>

  describeMove(state: S, seat: SeatId, move: M): MoveDescription
}

/**
 * The registry's element type.
 *
 * `unknown` state and move parameters would be wrong here — `applyMove(state:
 * unknown, …)` cannot accept a `ShelemState` — so the erased form uses `never`,
 * which is the honest statement that a caller holding an unidentified engine
 * may not fabricate its state. `GameSessionService` narrows once, per slug.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGameEngine = GameEngine<any, any>
