import type { Logger } from 'pino'
import type { GameInstance } from '../../domain/entities/game.js'
import { holderOf } from '../../domain/entities/game.js'
import { hintGrantKey, hintSpendKey } from '../../domain/economy/idempotency.js'
import { ForbiddenError } from '../../domain/errors/errors.js'
import {
  freeHintsLeft,
  nextHint,
  type HintFunding,
  type SudokuState,
} from '../../domain/games/sudoku/engine.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import type { IdentityRef } from '../../domain/value-objects/identity.js'
import type { SeatId } from '../../domain/value-objects/seat.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { WalletService } from './WalletService.js'

/**
 * ★ Hint points — `games/sudoku.md` §13.
 *
 * The two halves of one rule, kept in one file because they are one rule:
 *
 *   - **{@link authorizeHint}** decides who pays for a hint and charges them,
 *     inside the move's own transaction, *before* the pure engine runs.
 *   - **{@link grantForSolve}** hands a point back every third solved puzzle,
 *     inside settlement's transaction.
 *
 * Everything money-shaped here goes through `WalletService`, on the `HINT`
 * asset. That is the whole reason hint points are a wallet asset rather than a
 * counter on a stats row: the append-only ledger, the derived idempotency key
 * under a unique constraint, the row-locked debit and the reconciliation job
 * already exist and are already tested. A private counter would have to earn
 * all four back, and the first bug would be silent.
 */

/** §13.1 — the ceiling on banked points. */
export const HINT_POINT_CAP = 20

/** §13.1 — puzzles solved per point earned. */
export const SOLVES_PER_HINT_POINT = 3

/** Where the per-game solve counter lives inside `PlayerStats.extraJson`. */
export const SOLVES_STAT_KEY = 'sudokuSolves'

export interface SudokuHintServiceDeps {
  readonly wallets: WalletService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
}

export interface AuthorizeHintInput {
  readonly repos: Repositories
  readonly instance: GameInstance
  readonly state: SudokuState
  readonly seat: SeatId
  /** The seq the input event will take — derived, so a retry cannot double-charge. */
  readonly inputSeq: number
}

export class SudokuHintService {
  constructor(private readonly deps: SudokuHintServiceDeps) {}

  /**
   * ★ Decide the funding for a hint and charge for it — §13.3.
   *
   * The order is **compute, then charge**, and it is the reason `nextHint` is
   * exported as a pure function instead of living inside `applyMove`:
   *
   *   1. Preview the hint. If the player's grid contradicts the solution, or
   *      there is nothing left to fill, **nothing is charged** and the engine is
   *      told `FREE` — it will recompute the same preview, take the
   *      `MISTAKE`/`NONE` branch, and consume neither a free hint nor a point.
   *      The two calls cannot disagree because `nextHint` is deterministic on
   *      the same grid.
   *   2. Spend a free hint if one remains.
   *   3. Otherwise debit one `HINT` point, in the caller's transaction, through
   *      the row-locked path.
   *
   * The alternative — charge first, refund on failure — writes a spend and a
   * refund for something that never happened, and leans on a refund path that
   * is written once and exercised never. A hint that cannot be given is never
   * paid for.
   */
  async authorizeHint(input: AuthorizeHintInput): Promise<HintFunding> {
    const { repos, instance, state, seat, inputSeq } = input

    const player = state.players[String(seat)]
    if (player === undefined) {
      throw new ForbiddenError('that seat is not in this game', {
        i18nKey: 'games.sudoku.error.hintUnavailable',
        seat,
      })
    }

    // (1) Nothing to charge for. The engine reaches the same conclusion.
    const preview = nextHint(player.grid, state.solution)
    if (preview.kind !== 'MOVE') return 'FREE'

    // (2) The free allowance first — always, before a point is touched.
    if (freeHintsLeft(state, player) > 0) return 'FREE'

    if (!state.options.allowHintPoints) {
      throw new ForbiddenError('hint points are disabled for this table', {
        i18nKey: 'games.sudoku.error.hintPointsDisabled',
      })
    }

    const holder = this.holderFor(instance, seat)

    /**
     * ★ A guest has no hint points to spend — §13.1.
     *
     * `WalletService.debitWithin` would refuse a guest anyway ("guests cannot
     * spend"), but that error says nothing a player can act on. Answering here
     * lets the client render "sign up to bank hint points", which is the honest
     * and useful version of the same refusal.
     */
    if (holder === null || holder.kind !== 'user') {
      throw new ForbiddenError('hint points need an account', {
        i18nKey: 'games.sudoku.error.hintNeedsAccount',
      })
    }

    // (3) The debit rides the caller's transaction, so a move that fails to
    // append its events rolls the spend back with it — no refund path.
    await this.deps.wallets.debitWithin(repos, {
      holder,
      asset: 'HINT',
      amount: 1,
      kind: 'HINT_SPEND',
      idempotencyKey: hintSpendKey(instance.id, seat, inputSeq),
      reason: 'SUDOKU_HINT',
      refKind: 'gameInstance',
      refId: instance.id,
    })

    this.deps.metrics.increment('sudoku_hint_points_spent')
    return 'POINT'
  }

  /**
   * ★ Earn a point every third solved puzzle — §13.1.
   *
   * `solves` is the player's **lifetime** solved count *after* this match, so
   * the milestone is `floor(solves / 3)` and the key is a function of the
   * player's history rather than of when this code ran. Settlement replayed,
   * a backfill re-run, two workers racing — all three derive the same milestone
   * and collide on the unique constraint instead of paying twice.
   *
   * Returns the credited amount: `1` on a milestone, `0` otherwise, and `0`
   * again at the cap — where a zero-amount `CAP_REJECTED` row is written rather
   * than nothing, so "why did I not get a point?" is answerable from the ledger.
   */
  async grantForSolve(
    repos: Repositories,
    holder: IdentityRef,
    solves: number,
    refId: string,
  ): Promise<number> {
    if (holder.kind !== 'user') return 0
    if (solves <= 0 || solves % SOLVES_PER_HINT_POINT !== 0) return 0

    const milestone = Math.floor(solves / SOLVES_PER_HINT_POINT)

    const wallet = await repos.wallets.findByHolder(holder, 'HINT')
    const balance = wallet?.balance ?? 0
    const atCap = balance >= HINT_POINT_CAP

    const result = await this.deps.wallets.creditWithin(repos, {
      holder,
      asset: 'HINT',
      // ★ Zero at the cap, which `creditWithin` turns into a `CAP_REJECTED`
      // audit row carrying this reason. Never silence.
      amount: atCap ? 0 : 1,
      kind: 'HINT_GRANT',
      idempotencyKey: hintGrantKey(holder.userId, milestone),
      reason: atCap ? 'CAP_HINT_POINTS' : 'SUDOKU_SOLVE_MILESTONE',
      refKind: 'matchResult',
      refId,
      // Coin caps are denominated in coins; a 1-point grant measured against a
      // 500-coin hourly ceiling is a category error that happens to pass.
      exemptFromCaps: true,
    })

    if (result.applied && result.credited > 0) {
      this.deps.metrics.increment('sudoku_hint_points_granted')
      this.deps.logger.info(
        { userId: holder.userId, solves, milestone },
        'sudoku hint point granted',
      )
    }

    return result.credited > 0 ? result.credited : 0
  }

  /** Read the running solve count out of a stats row's free-form `extra` blob. */
  static solvesFrom(extra: Record<string, unknown> | null | undefined): number {
    const value = extra?.[SOLVES_STAT_KEY]
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
  }

  /**
   * The `SettlementHook` registered for the `sudoku` slug — §13.1's earn rule.
   *
   * **Only a solved puzzle counts.** Giving up, being ejected, or running the
   * idle timer out all settle through here and none of them advance the
   * counter: the rule is "three puzzles solved", and a player who abandons
   * three matches has solved nothing.
   *
   * The count and any grant it earns are written in one transaction, so they
   * cannot disagree — and because the grant's key is derived from the count
   * rather than from this match, a replayed settlement recomputes the same
   * milestone and collides instead of paying twice.
   */
  asSettlementHook(): {
    onSeatSettled: (input: {
      repos: Repositories
      instance: GameInstance
      result: { summary: Record<string, unknown> }
      matchResultId: string
      seat: SeatId
      holder: IdentityRef
      previousExtra: Record<string, unknown> | null
    }) => Promise<Record<string, unknown> | null>
  } {
    return {
      onSeatSettled: async ({ repos, result, matchResultId, seat, holder, previousExtra }) => {
        if (holder.kind !== 'user') return null

        const perSeat = result.summary['perSeat']
        const mine =
          typeof perSeat === 'object' && perSeat !== null
            ? (perSeat as Record<string, { solvedOrder?: unknown }>)[String(seat)]
            : undefined

        const solvedThisMatch = typeof mine?.solvedOrder === 'number'
        if (!solvedThisMatch) return null

        const solves = SudokuHintService.solvesFrom(previousExtra) + 1
        await this.grantForSolve(repos, holder, solves, matchResultId)

        return { ...(previousExtra ?? {}), [SOLVES_STAT_KEY]: solves }
      },
    }
  }

  private holderFor(instance: GameInstance, seat: SeatId): IdentityRef | null {
    const assignment = instance.seating.find((entry) => entry.seat === seat)
    return assignment === undefined ? null : holderOf(assignment)
  }

  /**
   * The `MoveAuthorizer` `GameSessionService` registers for the `sudoku` slug.
   *
   * Every move but `HINT` passes through untouched — this hook exists to fund
   * one move type, and a game where every move went through a wallet lookup
   * would be a different and much worse design.
   *
   * ★ `funding` is **overwritten, never read**. Whatever the client sent is
   * discarded, exactly as a claimed seat number would be.
   */
  asMoveAuthorizer(): {
    authorize: (input: {
      repos: Repositories
      instance: GameInstance
      state: unknown
      seat: SeatId
      move: Record<string, unknown>
      inputSeq: number
    }) => Promise<Record<string, unknown>>
  } {
    return {
      authorize: async ({ repos, instance, state, seat, move, inputSeq }) => {
        if (move['type'] !== 'HINT') return move

        const funding = await this.authorizeHint({
          repos,
          instance,
          state: state as SudokuState,
          seat,
          inputSeq,
        })
        return { ...move, funding }
      },
    }
  }
}
