import type { Logger } from 'pino'
import { SYSTEM_MESSAGE_KEYS } from '../../contracts/dto/chat.js'
import type { TurnEnforcement } from '../../contracts/dto/turnEnforcement.js'
import { reclaimDeadline, withTurnEnforcementDefaults } from '../policies/turnEnforcement.js'
import type { EjectionReason } from '../../contracts/enums.js'
import type { GameEvent, GameInstance } from '../../domain/entities/game.js'
import type { TableMember } from '../../domain/entities/table.js'
import { AppError } from '../../domain/errors/AppError.js'
import { ForbiddenError, SeatNotReclaimableError } from '../../domain/errors/errors.js'
import type { AnyGameEngine } from '../../domain/games/GameEngine.js'
import { gameRng } from '../../domain/games/shared/rng.js'
import type { GameRegistry } from '../../domain/games/registry.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import type { IdentityRef } from '../../domain/value-objects/identity.js'
import { seatId, type SeatId } from '../../domain/value-objects/seat.js'
import type { Clock, TimerHandle } from '../ports/clock.js'
import { seatRoom, tableRoom, type IRealtimePublisher } from '../ports/realtime.js'
import type { TurnContext, TurnObserver } from '../ports/turns.js'
import type { GraceExpired } from './PresenceService.js'
import type { ChatService } from './ChatService.js'
import type { GameSessionService, RebuiltGame } from './GameSessionService.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { TurnExpired, TurnTimerService } from './TurnTimerService.js'

/**
 * ★ What happens when somebody stops playing — S32–S34, 04 §6.2–§6.5.
 *
 * `TurnTimerService` decides *when*; this decides *what*. The escalation it
 * implements is 04 §6.2, in order:
 *
 * ```
 *   deadline passes → strike++ → safest default action → play continues
 *   deadline passes → strike++ → strikes == ejectAfterStrikes → ejected,
 *                                bot takes the seat, reward forfeited,
 *                                seat reclaimable for 120 s
 * ```
 *
 * ### The four rules that make this fair rather than punitive
 *
 * | | |
 * |---|---|
 * | **The default action never spends anything** | 04 §6.5. `meta.defaultActionOnTimeout` returns the *safest* move — stand, never hit; fold or check, never call; the lowest legal card, never a bid. A strike costs the turn, not the stack |
 * | **Strikes measure current absence** | `strikesResetOnAction` clears the count on any real move, so one lapse twenty minutes ago cannot combine with one now |
 * | **The consequence is explained before and after** | `game:ejectionWarning` before, `game:rewardPreview { integrityFactor: 0 }` at the moment of ejection. Nobody discovers a forfeit by looking at their wallet |
 * | **Coming back beats staying away** | The seat is held by a bot but stays reclaimable for `reclaimWindowSec`, at half reward (04 §6.4). Ejected twice in one match and it is final |
 *
 * ### Two timers, one destination, two different truths
 *
 * A turn timeout and a disconnect are **not** the same ejection and must never
 * be conflated (04 §5.2's warning): `EJECTED_TIMEOUT` is "you were here and did
 * not act", `EJECTED_ABANDON` is "your connection went". 10 §5.1 pays them
 * differently. Both timers run concurrently for a player who drops mid-turn,
 * and whichever fires first wins — in practice the disconnect grace is shorter,
 * so a dropped player is recorded under the truthful reason. {@link eject} is
 * idempotent precisely so the loser of that race is a no-op.
 */

/**
 * How long a bot "thinks" before playing.
 *
 * Not realism for its own sake: a bot that answered instantly would make a
 * four-handed game finish in a blur of state updates no human could follow, and
 * — more practically — would make a takeover indistinguishable from a bug in
 * the client's animation queue. Short enough that a table never feels stalled.
 */
export const BOT_MOVE_DELAY_MS = 250

/** 04 §6.4 — a returned player earns half, which is more than staying away pays. */
export const RETURNED_REWARD_FACTOR = 0.5

export interface SeatEnforcementDeps {
  readonly repos: Repositories
  readonly registry: GameRegistry
  readonly games: GameSessionService
  readonly timers: TurnTimerService
  readonly realtime: IRealtimePublisher
  readonly chat: ChatService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly clock: Clock
}

export interface ReclaimOutcome {
  readonly seat: SeatId
  readonly applied: boolean
  readonly pendingUntilBoundary: boolean
}

export class SeatEnforcementService implements TurnObserver {
  /** In-flight bot moves, so a re-broadcast cannot queue a second one. */
  private readonly botTurns = new Map<string, TimerHandle>()
  /**
   * Reclaims accepted but waiting for a hand boundary (`reclaimAt:
   * 'HAND_BOUNDARY'` — Poker and Blackjack).
   *
   * In process, and deliberately so at M0: the *right* to reclaim is durable
   * (`TableMember.reclaimableUntil` is a column), and only the queued intent is
   * lost on a restart. A player whose deferred reclaim evaporates in a deploy
   * re-sends one event and is still inside their window; persisting the intent
   * would mean a second source of truth about who holds a seat, which is a far
   * worse thing to get wrong.
   */
  private readonly pendingReclaims = new Map<string, Set<number>>()

  constructor(private readonly deps: SeatEnforcementDeps) {}

  /** Wires both expiry sources. The container calls this once. */
  attach(): void {
    this.deps.timers.onTurnExpired((event) => this.onTurnExpired(event))
  }

  stop(): void {
    for (const handle of this.botTurns.values()) this.deps.clock.cancel(handle)
    this.botTurns.clear()
    this.pendingReclaims.clear()
  }

  // ── S32: the strike ladder ────────────────────────────────────────────────

  /**
   * A deadline passed — 04 §6.2.
   *
   * Reads the strike count, decides between "struck" and "ejected", and either
   * way makes sure the table keeps moving. The default action goes through
   * `applySystemMove`, which is what gets it an idempotency key, an entry in
   * the log, the snapshot policy and a per-viewer broadcast — the same pipeline
   * a human's move takes, because a quieter second write path is how a
   * timed-out move ends up missing from a replay.
   */
  async onTurnExpired(event: TurnExpired): Promise<void> {
    const instance = await this.activeInstance(event.gameId)
    if (instance === null) return

    const member = await this.deps.repos.tables.findMemberBySeat(instance.tableId, event.seat)
    // Already ejected, already left, or a bot: nothing to strike. This is the
    // no-op end of the two-timer race described in the class docblock.
    if (member === null || member.leftAt !== null) return
    if (member.ejectedAt !== null || member.isBot || member.botSubstituted) return

    const settings = await this.settingsOf(instance.tableId)
    const strikes = member.timeoutStrikes + 1
    await this.deps.repos.tables.updateMember(member.id, { timeoutStrikes: strikes })

    this.deps.logger.info(
      { gameId: instance.id, seat: event.seat, strikes, limit: settings.ejectAfterStrikes },
      'turn deadline expired',
    )

    if (strikes >= settings.ejectAfterStrikes) {
      await this.eject(instance, event.seat, 'TURN_TIMEOUT', strikes)
      return
    }

    await this.applyDefaultAction(instance, event.seat, strikes)
  }

  /**
   * ★ The safest move, applied on the player's behalf — 04 §6.5.
   *
   * `meta.defaultActionOnTimeout` may legitimately answer `null`: there is no
   * safe move, or the state moved on while the timer was firing. In that case
   * the strike stands and the deadline is simply re-armed, which is the
   * honest outcome — the alternative, guessing a move for them, is the exact
   * thing this method exists not to do.
   */
  private async applyDefaultAction(
    instance: GameInstance,
    seat: SeatId,
    strikes: number,
  ): Promise<void> {
    const rebuilt = await this.deps.games.rebuildState(instance.id)
    const move = rebuilt.engine.meta.defaultActionOnTimeout(rebuilt.state, seat)

    if (move === null || typeof move !== 'object') {
      await this.deps.timers.arm(
        instance.id,
        instance.tableId,
        instance.gameSlug,
        seat,
        phaseOf(rebuilt),
      )
      return
    }

    try {
      await this.deps.games.applySystemMove({
        gameId: instance.id,
        seat,
        move: move as Record<string, unknown>,
        // ★ Server-generated, and keyed by the seq the move will take: the
        // retry rule that protects a human's dropped ack protects this too, and
        // two expiries racing for one deadline cannot play the same seat twice.
        clientMoveId: `timeout:${instance.id}:${rebuilt.seq + 1}`,
        by: 'timeout',
        extra: { timeout: true, strikes },
      })
    } catch (error) {
      // A default action the engine refuses is a bug in that game's meta, not a
      // reason to stall the table: the strike is recorded, the deadline is
      // re-armed, and the next lapse ejects.
      this.deps.logger.error(
        { err: error, gameId: instance.id, seat, move },
        'default timeout action was refused by the engine',
      )
      await this.deps.timers.arm(
        instance.id,
        instance.tableId,
        instance.gameSlug,
        seat,
        phaseOf(rebuilt),
      )
    }
  }

  // ── S33: ejection, and the bot that takes over ────────────────────────────

  /**
   * The disconnect path — `PresenceService.onGraceExpired`, 04 §5.2.
   *
   * Same destination as a turn timeout, different reason, and the difference is
   * load-bearing: 10 §5.1 treats `EJECTED_ABANDON` and `EJECTED_TIMEOUT` as
   * distinct outcomes. Registered by the container.
   */
  async onGraceExpired(event: GraceExpired): Promise<void> {
    if (event.seat === null) return

    const instance = await this.deps.repos.games.findActiveByTable(event.tableId)
    // No game in play means there is nothing to eject *from*: the seat is
    // released by the ordinary table flow, and forfeiting a reward for a match
    // that never started would be a punishment with no crime.
    if (instance === null) return

    const seat = seatId(event.seat)
    const member = await this.deps.repos.tables.findMemberBySeat(event.tableId, seat)
    await this.eject(instance, seat, 'ABANDON', member?.timeoutStrikes ?? 0)
  }

  /**
   * ★ Ejection — 04 §6.2, and **idempotent by construction**.
   *
   * Two expiries can genuinely arrive for one seat: the turn timer and the
   * disconnect grace both point here, and a duplicate timer would too. The
   * `ejectedAt !== null` guard is what makes the second one free, and there is
   * a test named for it — double-ejecting would double-append the takeover
   * event, reset the reclaim window, and hand the player a second ejection that
   * makes their own seat unreclaimable.
   */
  async eject(
    instance: GameInstance,
    seat: SeatId,
    reason: EjectionReason,
    strikes: number,
  ): Promise<void> {
    const member = await this.deps.repos.tables.findMemberBySeat(instance.tableId, seat)
    if (member === null || member.leftAt !== null || member.isBot) return
    if (member.ejectedAt !== null) return

    const engine = this.deps.registry.requireEngine(instance.gameSlug)
    const settings = await this.settingsOf(instance.tableId)
    const now = new Date(this.deps.clock.now())

    const canSubstitute = engine.meta.supportsBots && engine.bot !== undefined
    const priorEjections = await this.countEjections(instance.id, seat)

    /**
     * ★ "Ejected twice in one match → the seat is final" (04 §6.4).
     *
     * Counted from the log rather than from a column, because the log is the
     * one record that cannot be rewritten and the question is genuinely about
     * this *match* — a column would either need resetting per game or would
     * follow the player between tables.
     */
    const reclaimableUntil =
      canSubstitute && priorEjections === 0 && engine.meta.reclaimAt !== 'NEVER'
        ? reclaimDeadline(now, settings)
        : null

    await this.deps.repos.tables.updateMember(member.id, {
      ejectedAt: now,
      ejectionReason: reason,
      botSubstituted: canSubstitute,
      reclaimableUntil,
      timeoutStrikes: strikes,
    })

    await this.deps.timers.clear(instance.id)
    await this.appendSystemEvent(instance.id, seat, {
      system: canSubstitute ? 'BOT_TOOK_OVER' : 'SEAT_ABANDONED',
      ejection: true,
      reason,
      strikes,
    })

    this.deps.realtime.publish(tableRoom(instance.tableId), 'game:playerEjected', {
      gameId: instance.id,
      tableId: instance.tableId,
      seat,
      reason,
      replacedByBot: canSubstitute,
      reclaimableUntil: reclaimableUntil?.toISOString() ?? null,
      strikes,
    })

    /**
     * ★ To the ejected seat alone, and stated plainly — 04 §6.6.
     *
     * The forfeit is the part people argue about afterwards, so it is said at
     * the moment it happens rather than inferred later from a wallet that did
     * not move. `estimatedCoins: 0` and `integrityFactor: 0` are the shape S35
     * will fill in with a real computation.
     */
    this.deps.realtime.publish(seatRoom(instance.tableId, seat), 'game:rewardPreview', {
      gameId: instance.id,
      tableId: instance.tableId,
      seat,
      estimatedCoins: 0,
      integrityFactor: 0,
      reasonKey:
        reason === 'TURN_TIMEOUT'
          ? 'games.reward.forfeitedTimeout'
          : 'games.reward.forfeitedAbandon',
    })

    await this.deps.chat
      .system(instance.tableId, SYSTEM_MESSAGE_KEYS.playerEjected, {
        seat,
        reason,
        replacedByBot: canSubstitute,
      })
      .catch((error: unknown) =>
        this.deps.logger.error({ err: error }, 'ejection narration failed'),
      )

    this.deps.metrics.increment('ejections')
    if (!canSubstitute) this.deps.metrics.increment('seats_abandoned')

    this.deps.logger.warn(
      { gameId: instance.id, seat, reason, replacedByBot: canSubstitute },
      'seat ejected',
    )

    // The seat may well be the one to act, and no timer is arming it now. This
    // is what makes "the table plays on" true — the M0 exit criterion.
    await this.driveSeat(instance.id)
  }

  // ── S33: the bot ──────────────────────────────────────────────────────────

  /**
   * Observes the same turns the timer service does.
   *
   * A bot-held seat is not timed (see `TurnTimerService.arm`), so *something*
   * has to play it, and this is that something. The delay is scheduled through
   * the injected clock rather than `setTimeout`, so a test drives a whole
   * bot-finished match without waiting.
   */
  async onTurn(context: TurnContext): Promise<void> {
    const pending = this.botTurns.get(context.gameId)
    if (pending !== undefined) {
      this.deps.clock.cancel(pending)
      this.botTurns.delete(context.gameId)
    }

    await this.clearStrikesOnAction(context)

    if (context.terminal || context.seat === null) return

    await this.maybeCompleteReclaim(context)
    await this.scheduleBotMove(context.gameId, context.tableId, context.seat)
  }

  /**
   * ★ `strikesResetOnAction` — 04 §6.3, and the reason it is the default.
   *
   * Strikes are meant to measure whether somebody is *currently* absent, not to
   * keep a record. A player who misses one turn to answer the door and then
   * plays cleanly for ten tricks should not be ejected by a second lapse twenty
   * minutes later, which is exactly what a lifetime counter would do in a
   * 45-minute Shelem match.
   *
   * Only a **human** move clears it. The timeout's own default action is the
   * strike, and a bot's move is not the ejected player returning — that is what
   * `game:reclaimSeat` is for.
   */
  private async clearStrikesOnAction(context: TurnContext): Promise<void> {
    if (context.acted === null || context.acted.by !== 'human') return

    /**
     * ★ The member row is read **before** the table's settings, and the order
     * matters for cost rather than correctness.
     *
     * This runs on every human move in the platform, and the overwhelmingly
     * common case is a player with no strikes at all — for whom there is
     * nothing to clear whatever the setting says. Reading the policy first
     * would put an extra table lookup on the critical path of every move to
     * decide not to do anything.
     */
    const member = await this.deps.repos.tables.findMemberBySeat(
      context.tableId,
      context.acted.seat,
    )
    if (member === null || member.timeoutStrikes === 0) return

    const settings = await this.settingsOf(context.tableId)
    if (!settings.strikesResetOnAction) return

    await this.deps.repos.tables.updateMember(member.id, { timeoutStrikes: 0 })
  }

  private async scheduleBotMove(gameId: string, tableId: string, seat: SeatId): Promise<void> {
    const member = await this.deps.repos.tables.findMemberBySeat(tableId, seat)
    if (member === null || !(member.isBot || member.botSubstituted)) return

    const handle = this.deps.clock.schedule(BOT_MOVE_DELAY_MS, () => {
      this.botTurns.delete(gameId)
      void this.playBotMove(gameId, seat)
    })
    this.botTurns.set(gameId, handle)
  }

  /**
   * One bot move, chosen from `legalMoves` and applied through the same
   * pipeline as everything else.
   *
   * ★ The choice is made from `legalMoves`, and `applyMove` re-checks it
   * anyway. That redundancy is the point: a bot is *our* code and still gets no
   * more trust than a client, so a strategy with a bug produces a rejected move
   * and a log line rather than an illegal card on the table. There is a
   * thousand-seed property test for it.
   */
  private async playBotMove(gameId: string, seat: SeatId): Promise<void> {
    try {
      const instance = await this.activeInstance(gameId)
      if (instance === null) return

      const rebuilt = await this.deps.games.rebuildState(gameId)
      const move = this.chooseBotMove(rebuilt, seat)
      if (move === null) return

      await this.deps.games.applySystemMove({
        gameId,
        seat,
        move,
        clientMoveId: `bot:${gameId}:${rebuilt.seq + 1}`,
        by: 'bot',
      })
      this.deps.metrics.increment('bot_moves_applied')
    } catch (error) {
      // Inside a timer callback there is nobody to catch. A bot that cannot
      // move stalls one table; an unhandled rejection stops the process.
      const level = error instanceof AppError ? 'warn' : 'error'
      this.deps.logger[level]({ err: error, gameId, seat }, 'bot move failed')
    }
  }

  private chooseBotMove(rebuilt: RebuiltGame, seat: SeatId): Record<string, unknown> | null {
    const engine: AnyGameEngine = rebuilt.engine
    const legal = engine.legalMoves(rebuilt.state, seat)
    if (legal.length === 0) return null

    // Keyed exactly as the move's own transition will be, so a replayed match
    // reproduces the bot's choice as faithfully as a human's (05 §4.6).
    const rng = gameRng(rebuilt.instance.rngSeed, rebuilt.seq + 1)
    const chosen =
      engine.bot === undefined ? legal[0] : engine.bot.chooseMove(rebuilt.state, seat, legal, rng)

    return (chosen ?? legal[0]) as Record<string, unknown>
  }

  /** Plays for the seat that is to act, if a bot now holds it. */
  private async driveSeat(gameId: string): Promise<void> {
    const rebuilt = await this.deps.games.rebuildState(gameId)
    if (rebuilt.engine.isTerminal(rebuilt.state)) return

    const toAct = toActOf(rebuilt)
    if (toAct === null) return

    await this.scheduleBotMove(gameId, rebuilt.instance.tableId, toAct)
  }

  // ── S34: taking the seat back ─────────────────────────────────────────────

  /**
   * `game:reclaimSeat` — 04 §6.4.
   *
   * The matrix, in four refusals and one success: inside the window with a bot
   * holding your seat, you get it back at half reward; outside it, or after a
   * second ejection, or in a game that never allows it, the answer is
   * `SEAT_NOT_RECLAIMABLE` and the bot plays to the end.
   *
   * `reclaimAt: 'HAND_BOUNDARY'` (Poker, Blackjack) accepts the claim and
   * defers the handover, because walking into a hand where a bot has already
   * committed your chips is unfair in both directions.
   */
  async reclaim(gameId: string, identity: IdentityRef): Promise<ReclaimOutcome> {
    const instance = await this.deps.games.requireActive(gameId)
    const member = await this.deps.repos.tables.findMemberByIdentity(instance.tableId, identity)

    if (member === null || member.leftAt !== null || member.seat === null) {
      throw new ForbiddenError('You are not seated at this table', { reason: 'NOT_SEATED' })
    }

    const seat = seatId(member.seat)
    const meta = this.deps.registry.meta(instance.gameSlug)
    const now = this.deps.clock.now()

    if (member.ejectedAt === null || !member.botSubstituted) {
      // Nothing to take back. Reported as not-reclaimable rather than as
      // success, because a client that thinks it just recovered a seat it never
      // lost will render a "welcome back" over a live hand.
      throw new SeatNotReclaimableError('This seat was never ejected', {
        seat,
        reason: 'NOT_EJECTED',
      })
    }
    if (meta.reclaimAt === 'NEVER') {
      throw new SeatNotReclaimableError('This game does not allow reclaiming a seat', {
        seat,
        reason: 'GAME_FORBIDS_RECLAIM',
      })
    }
    if (member.reclaimableUntil === null) {
      // Set to null at ejection when this was the seat's *second* — 04 §6.4.
      throw new SeatNotReclaimableError('This seat is final for the rest of the match', {
        seat,
        reason: 'SEAT_FINAL',
      })
    }
    if (member.reclaimableUntil.getTime() <= now) {
      throw new SeatNotReclaimableError('The reclaim window has closed', {
        seat,
        reason: 'WINDOW_EXPIRED',
        expiredAt: member.reclaimableUntil.toISOString(),
      })
    }

    if (meta.reclaimAt === 'HAND_BOUNDARY') {
      this.queueReclaim(instance.id, seat)
      return { seat, applied: false, pendingUntilBoundary: true }
    }

    await this.completeReclaim(instance, member, seat)
    return { seat, applied: true, pendingUntilBoundary: false }
  }

  private queueReclaim(gameId: string, seat: SeatId): void {
    const pending = this.pendingReclaims.get(gameId) ?? new Set<number>()
    pending.add(seat)
    this.pendingReclaims.set(gameId, pending)
  }

  /**
   * A deferred reclaim lands when the phase changes — the nearest thing this
   * platform has to "the hand ended" that every game already reports.
   */
  private async maybeCompleteReclaim(context: TurnContext): Promise<void> {
    const pending = this.pendingReclaims.get(context.gameId)
    if (pending === undefined || pending.size === 0 || context.seat === null) return
    if (!pending.has(context.seat)) return

    const instance = await this.activeInstance(context.gameId)
    if (instance === null) return

    const member = await this.deps.repos.tables.findMemberBySeat(instance.tableId, context.seat)
    if (member === null) return

    pending.delete(context.seat)
    await this.completeReclaim(instance, member, context.seat)
  }

  private async completeReclaim(
    instance: GameInstance,
    member: TableMember,
    seat: SeatId,
  ): Promise<void> {
    await this.deps.repos.tables.updateMember(member.id, {
      ejectedAt: null,
      ejectionReason: null,
      botSubstituted: false,
      reclaimableUntil: null,
      // ★ The slate is clean, but the *log* is not: `seatOutcomeOf` reads the
      // ejection event that is still there, so a returned player is paid at
      // `REPLACED_RETURNED`'s half rate rather than as though nothing happened.
      timeoutStrikes: 0,
    })

    await this.appendSystemEvent(instance.id, seat, {
      system: 'PLAYER_RETURNED',
      outcome: 'REPLACED_RETURNED',
    })

    this.deps.realtime.publish(tableRoom(instance.tableId), 'game:playerReturned', {
      gameId: instance.id,
      tableId: instance.tableId,
      seat,
      outcome: 'REPLACED_RETURNED',
      rewardFactor: RETURNED_REWARD_FACTOR,
    })

    await this.deps.chat
      .system(instance.tableId, SYSTEM_MESSAGE_KEYS.playerReturned, { seat })
      .catch((error: unknown) => this.deps.logger.error({ err: error }, 'return narration failed'))

    this.deps.metrics.increment('seats_reclaimed')
    this.deps.logger.info({ gameId: instance.id, seat }, 'seat reclaimed')

    // The human is back and it may be their turn: re-arm, or they would sit
    // untimed for the rest of the match.
    const rebuilt = await this.deps.games.rebuildState(instance.id)
    if (!rebuilt.engine.isTerminal(rebuilt.state) && toActOf(rebuilt) === seat) {
      await this.deps.timers.arm(
        instance.id,
        instance.tableId,
        instance.gameSlug,
        seat,
        phaseOf(rebuilt),
      )
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async appendSystemEvent(
    gameId: string,
    seat: SeatId,
    payload: Record<string, unknown>,
  ): Promise<GameEvent | null> {
    try {
      return await this.deps.repos.events.append({ gameId, kind: 'SYSTEM', seat, payload })
    } catch (error) {
      // The member row is already written and the table already told. Failing
      // the ejection now would leave the two disagreeing, which is worse than
      // an unnarrated takeover.
      this.deps.logger.error({ err: error, gameId, seat }, 'could not append SYSTEM event')
      return null
    }
  }

  private async countEjections(gameId: string, seat: SeatId): Promise<number> {
    const events = await this.deps.repos.events.listByGame(gameId)
    return events.filter((event) => event.seat === seat && event.payload['ejection'] === true)
      .length
  }

  private async activeInstance(gameId: string): Promise<GameInstance | null> {
    const instance = await this.deps.repos.games.findById(gameId)
    return instance !== null && instance.status === 'ACTIVE' ? instance : null
  }

  private async settingsOf(tableId: string): Promise<TurnEnforcement> {
    const table = await this.deps.repos.tables.findById(tableId)
    return withTurnEnforcementDefaults(table?.turnEnforcement)
  }
}

// ── Free functions ───────────────────────────────────────────────────────────

function phaseOf(rebuilt: RebuiltGame): string | null {
  const phase = (rebuilt.state as { phase?: unknown }).phase
  return typeof phase === 'string' ? phase : null
}

function toActOf(rebuilt: RebuiltGame): SeatId | null {
  const toAct = (rebuilt.state as { toAct?: unknown }).toAct
  return typeof toAct === 'number' ? seatId(toAct) : null
}
