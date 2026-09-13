import type { Logger } from 'pino'
import type { TurnEnforcement } from '../../contracts/dto/turnEnforcement.js'
import { withTurnEnforcementDefaults } from '../policies/turnEnforcement.js'
import type { GameInstance } from '../../domain/entities/game.js'
import type { GameMeta } from '../../domain/games/GameEngine.js'
import type { GameRegistry } from '../../domain/games/registry.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import { seatId, type SeatId } from '../../domain/value-objects/seat.js'
import type { Clock, TimerHandle } from '../ports/clock.js'
import { seatRoom, tableRoom, type IRealtimePublisher } from '../ports/realtime.js'
import {
  TIMER_EVENT_MARKER,
  isTimerEvent,
  type TurnContext,
  type TurnObserver,
} from '../ports/turns.js'
import type { MetricsRegistry } from './MetricsRegistry.js'

/**
 * ★ Turn deadlines — S31, 04 §5.4 and §6.1.
 *
 * ### The one property everything here exists to hold
 *
 * **A deadline is an absolute instant, and it is written down.** Not "30
 * seconds from now" held in a variable, not a countdown the client owns. Three
 * consequences follow, and each of them is a bug this service is built to
 * prevent:
 *
 * | | |
 * |---|---|
 * | The client's clock cannot be trusted | `endsAt` travels with a `serverTime`, so a phone that is ten minutes fast still renders the right ring (04 §5.4) |
 * | A restart must not gift anyone time | The deadline is appended as a `PHASE` event, so `resume()` re-arms the *same* instant rather than a fresh 30 seconds (S34) |
 * | A second API instance must be able to read it | Mirrored to Redis when Redis exists — a cache, never the record |
 *
 * The `PHASE` event is the durable copy and Redis is the convenience. That
 * order matters: `REDIS_URL` is unset in development, and a timer that only
 * existed in Redis would silently stop surviving restarts on exactly the
 * machine where nobody would notice.
 *
 * ### What this service deliberately does not do
 *
 * It does not decide anything. Expiry calls {@link TurnTimerDeps.onExpired} and
 * stops; strikes, default actions, warnings-turned-ejections and bots are
 * `SeatEnforcementService`'s (S32–S34). Keeping the two apart is what lets "was
 * the deadline right?" and "was the punishment right?" be separate failures
 * with separate tests.
 *
 * ### And what the engine does not do
 *
 * An engine never sees a clock — invariant I1. `GameMeta.turnTimeoutMs` is a
 * **declaration**, read from here. There is an import-graph test asserting no
 * file under `domain/games/**` names this service.
 */

/** A deadline the service is currently counting down. */
export interface ArmedDeadline {
  readonly gameId: string
  readonly tableId: string
  readonly seat: SeatId
  readonly endsAt: Date
  readonly strikes: number
}

export interface TurnExpired {
  readonly gameId: string
  readonly tableId: string
  readonly seat: SeatId
  readonly endsAt: Date
}

export interface TurnTimerDeps {
  readonly repos: Repositories
  readonly registry: GameRegistry
  readonly realtime: IRealtimePublisher
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly clock: Clock
  /**
   * S27, optional and a *mirror*. Nothing reads it to make a decision — the
   * `PHASE` event is what `resume()` reads — so losing Redis costs nothing here
   * but a second instance's ability to render a countdown it did not arm.
   */
  readonly mirror?: {
    set(gameId: string, endsAt: Date): Promise<void>
    clear(gameId: string): Promise<void>
  }
}

interface Armed {
  readonly deadline: ArmedDeadline
  warning: TimerHandle | null
  expiry: TimerHandle | null
}

export class TurnTimerService implements TurnObserver {
  private readonly armed = new Map<string, Armed>()
  private onExpired: ((event: TurnExpired) => void | Promise<void>) | null = null

  constructor(private readonly deps: TurnTimerDeps) {}

  /**
   * Registers the consequence. Late-bound for the same reason the realtime
   * publisher is: `SeatEnforcementService` needs this service to cancel and
   * re-arm around an ejection, so one of the two has to be attached afterwards.
   */
  onTurnExpired(handler: (event: TurnExpired) => void | Promise<void>): void {
    this.onExpired = handler
  }

  // ── The observer seam ─────────────────────────────────────────────────────

  /**
   * Called after **every** state change (see `application/ports/turns.ts`): the
   * deal, a human move, a timeout's default action, and a bot's move all land
   * here. That is the whole of "acting cancels the timer; the next turn
   * re-arms" — there is no second place that has to remember.
   */
  async onTurn(context: TurnContext): Promise<void> {
    if (context.terminal || context.seat === null) {
      await this.clear(context.gameId)
      return
    }

    // ★ Awaited, not fired and forgotten. The `PHASE` append below would
    // otherwise be in flight when the next move opens its own transaction, and
    // the two would race for a `seq` — absorbed by the repository's retry loop,
    // but only after a wall of unique-constraint errors and a log whose order
    // depended on which write won.
    await this.arm(context.gameId, context.tableId, context.gameSlug, context.seat, context.phase)
  }

  // ── Arming ────────────────────────────────────────────────────────────────

  /**
   * Computes the deadline, writes it down, announces it, and schedules the two
   * callbacks.
   *
   * A game whose limit is `null` — Sudoku is a solo puzzle, Chess has its own
   * clock — arms nothing and clears whatever was armed. That is not a special
   * case bolted on; it is what `turnTimeoutMs: null` means.
   */
  async arm(
    gameId: string,
    tableId: string,
    gameSlug: string,
    seat: SeatId,
    phase: string | null,
  ): Promise<ArmedDeadline | null> {
    const meta = this.metaOf(gameSlug)
    const timeoutMs = meta === null ? null : turnTimeoutFor(meta, phase)
    if (timeoutMs === null) {
      await this.clear(gameId)
      return null
    }

    /**
     * ★ A bot-held seat gets no deadline.
     *
     * Not an optimisation — a correctness rule. A turn timer exists to decide
     * whether a *human* has abandoned the table; pointing one at a bot would
     * strike and then "eject" a seat that is already ejected, and the ejected
     * human's strike count would keep climbing while they were nowhere near it.
     * The bot is driven by `SeatEnforcementService`, which observes the same
     * turn this method is declining to time.
     */
    const member = await this.deps.repos.tables.findMemberBySeat(tableId, seat)
    if (member !== null && (member.isBot || member.botSubstituted)) {
      await this.clear(gameId)
      return null
    }

    const endsAt = new Date(this.deps.clock.now() + timeoutMs)
    const strikes = member?.timeoutStrikes ?? 0
    const settings = await this.settingsOf(tableId)
    const deadline: ArmedDeadline = { gameId, tableId, seat, endsAt, strikes }

    // ★ Durable first, announced second. If the append throws, nobody has been
    // promised a countdown that no restart could honour.
    await this.persist(gameId, deadline)
    this.schedule(deadline, timeoutMs, settings)
    this.announce(deadline, settings)

    this.deps.metrics.increment('turn_timers_armed')
    return deadline
  }

  /** Stops counting — the game ended, the seat was ejected, nobody is to act. */
  async clear(gameId: string): Promise<void> {
    const existing = this.armed.get(gameId)
    if (existing !== undefined) {
      if (existing.warning !== null) this.deps.clock.cancel(existing.warning)
      if (existing.expiry !== null) this.deps.clock.cancel(existing.expiry)
      this.armed.delete(gameId)
    }
    await this.deps.mirror?.clear(gameId).catch(() => undefined)
  }

  /** Cancels every in-process timer. `container.shutdown()` calls this. */
  stop(): void {
    for (const armed of this.armed.values()) {
      if (armed.warning !== null) this.deps.clock.cancel(armed.warning)
      if (armed.expiry !== null) this.deps.clock.cancel(armed.expiry)
    }
    this.armed.clear()
  }

  deadlineOf(gameId: string): ArmedDeadline | null {
    return this.armed.get(gameId)?.deadline ?? null
  }

  /**
   * Sends the live deadline to one socket — what a reconnecting client needs.
   *
   * Timer rows are skipped when a `delta` replays narration (they would be one
   * "phase changed" line per turn of the match), so the current countdown has
   * to arrive some other way. This is that way, and it is called by the
   * `game:requestSync` handler for both `delta` and `full`.
   */
  async announceToSocket(socketId: string, gameId: string): Promise<void> {
    const deadline = this.deadlineOf(gameId)
    if (deadline === null) return

    const settings = await this.settingsOf(deadline.tableId)
    this.deps.realtime.publishToSocket(socketId, 'game:turnTimer', {
      gameId: deadline.gameId,
      tableId: deadline.tableId,
      seat: deadline.seat,
      endsAt: deadline.endsAt.toISOString(),
      strikes: deadline.strikes,
      ejectAfterStrikes: settings.ejectAfterStrikes,
      serverTime: this.deps.clock.now(),
    })
  }

  // ── S34: surviving a restart ──────────────────────────────────────────────

  /**
   * ★ Re-arms every `ACTIVE` game from its persisted deadline — 04 §5.4.
   *
   * The headline property is what it does **not** do: it never computes a new
   * `endsAt`. A player who was five seconds from timing out when the process
   * died is five seconds from timing out when it comes back, and a deploy is
   * therefore not a way to buy yourself half a minute of thinking time.
   *
   * A deadline that passed while the process was down fires **immediately**,
   * for the same reason. The alternative — a grace period on boot — is a free
   * extra turn for whoever happened to be idling during a restart, and the
   * other three players at that table paid for the downtime already.
   */
  async resume(): Promise<number> {
    const active = await this.deps.repos.games.listActive()
    let rearmed = 0

    for (const instance of active) {
      const persisted = await this.persistedDeadline(instance)
      if (persisted === null) continue

      const remaining = persisted.endsAt.getTime() - this.deps.clock.now()
      const settings = await this.settingsOf(instance.tableId)
      this.schedule(persisted, Math.max(remaining, 0), settings)
      this.announce(persisted, settings)
      await this.deps.mirror?.set(instance.id, persisted.endsAt).catch(() => undefined)

      this.deps.metrics.increment('turn_timers_rearmed')
      rearmed += 1
      this.deps.logger.info(
        { gameId: instance.id, seat: persisted.seat, endsAt: persisted.endsAt, remaining },
        remaining > 0 ? 'turn deadline re-armed' : 'turn deadline already expired; firing now',
      )
    }

    return rearmed
  }

  /**
   * The newest timer `PHASE` row for a game, or `null`.
   *
   * Read from the log rather than from Redis deliberately: Redis is optional
   * and is cleared on restart in this codebase anyway, so a resume that
   * depended on it would work in production and quietly do nothing in
   * development — the worst possible split, because S34's verification step is
   * run by hand on a laptop with no Redis.
   */
  async persistedDeadline(instance: GameInstance): Promise<ArmedDeadline | null> {
    const events = await this.deps.repos.events.listByGame(instance.id)

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (!isTimerEvent(event.payload)) continue

      const timer = event.payload[TIMER_EVENT_MARKER] as {
        seat: number
        endsAt: string
        strikes?: number
      }
      return {
        gameId: instance.id,
        tableId: instance.tableId,
        seat: seatId(timer.seat),
        endsAt: new Date(timer.endsAt),
        strikes: timer.strikes ?? 0,
      }
    }

    return null
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private schedule(deadline: ArmedDeadline, remainingMs: number, settings: TurnEnforcement): void {
    const existing = this.armed.get(deadline.gameId)
    if (existing !== undefined) {
      if (existing.warning !== null) this.deps.clock.cancel(existing.warning)
      if (existing.expiry !== null) this.deps.clock.cancel(existing.expiry)
    }

    const armed: Armed = { deadline, warning: null, expiry: null }
    this.armed.set(deadline.gameId, armed)

    armed.expiry = this.deps.clock.schedule(remainingMs, () => {
      // Cleared before the handler runs, so a handler that throws cannot leave
      // a game permanently un-expirable, and a handler that re-arms (which is
      // exactly what a non-final strike does) is not fighting its own entry.
      this.armed.delete(deadline.gameId)

      this.deps.metrics.increment('turn_timeouts')
      void this.fireExpired(deadline)
    })

    this.scheduleWarning(armed, remainingMs, settings)
  }

  /**
   * ★ The warning goes to `seat:{table}:{n}`, never to `table:{id}` — 04 §6.2.
   *
   * This is a private nudge, and broadcasting it would do two bad things at
   * once: shame somebody in front of the table, and tell the other three
   * exactly when to expect a free trick. There is an integration test in which
   * a second client asserts it receives *nothing*.
   */
  private scheduleWarning(armed: Armed, remainingMs: number, settings: TurnEnforcement): void {
    const warnAfterMs = remainingMs - settings.warningSeconds * 1_000

    // Nothing to warn about when the window is off, or when so little time is
    // left that the warning and the strike would arrive together — which is
    // also the resume case for a deadline that is nearly up.
    if (settings.warningSeconds === 0 || warnAfterMs <= 0) return

    armed.warning = this.deps.clock.schedule(warnAfterMs, () => {
      armed.warning = null
      this.deps.realtime.publish(
        seatRoom(armed.deadline.tableId, armed.deadline.seat),
        'game:ejectionWarning',
        {
          gameId: armed.deadline.gameId,
          tableId: armed.deadline.tableId,
          seat: armed.deadline.seat,
          secondsRemaining: settings.warningSeconds,
          /**
           * Stated, not implied. 04 §6.6: the consequence is explained before
           * it happens, because "you will earn nothing from this match" is not
           * something anyone should have to infer from an empty wallet.
           */
          consequence: 'EJECTION_NO_REWARD',
        },
      )
      this.deps.metrics.increment('turn_warnings_sent')
    })
  }

  private async fireExpired(deadline: ArmedDeadline): Promise<void> {
    await this.deps.mirror?.clear(deadline.gameId).catch(() => undefined)

    try {
      await this.onExpired?.({
        gameId: deadline.gameId,
        tableId: deadline.tableId,
        seat: deadline.seat,
        endsAt: deadline.endsAt,
      })
    } catch (error) {
      // Inside a timer callback there is nobody to catch. A failed ejection
      // must not take the process down with it.
      this.deps.logger.error(
        { err: error, gameId: deadline.gameId, seat: deadline.seat },
        'turn-expiry handler threw',
      )
    }
  }

  /**
   * The deadline, written twice — 04 §6.1.
   *
   * The `PHASE` event is the record; Redis is a mirror for other instances.
   * Note the event is **not** an input event (`isInputEvent` tests for a `move`
   * in the payload), so it replays as a no-op and costs one `seq` — which is
   * the price of a deadline that survives a deploy.
   */
  private async persist(gameId: string, deadline: ArmedDeadline): Promise<void> {
    await this.deps.repos.events.append({
      gameId,
      kind: 'PHASE',
      seat: deadline.seat,
      payload: {
        [TIMER_EVENT_MARKER]: {
          seat: deadline.seat,
          endsAt: deadline.endsAt.toISOString(),
          strikes: deadline.strikes,
        },
      },
    })

    await this.deps.mirror?.set(gameId, deadline.endsAt).catch(() => undefined)
  }

  private announce(deadline: ArmedDeadline, settings: TurnEnforcement): void {
    this.deps.realtime.publish(tableRoom(deadline.tableId), 'game:turnTimer', {
      gameId: deadline.gameId,
      tableId: deadline.tableId,
      seat: deadline.seat,
      endsAt: deadline.endsAt.toISOString(),
      strikes: deadline.strikes,
      ejectAfterStrikes: settings.ejectAfterStrikes,
      // ★ Shipped with every deadline so the client re-measures the offset
      // between its clock and ours on every turn, rather than trusting one
      // reading taken at handshake and drifting for the rest of the match.
      serverTime: this.deps.clock.now(),
    })
  }

  private async settingsOf(tableId: string): Promise<TurnEnforcement> {
    return withTurnEnforcementDefaults(
      (await this.deps.repos.tables.findById(tableId))?.turnEnforcement,
    )
  }

  private metaOf(gameSlug: string): GameMeta | null {
    try {
      return this.deps.registry.meta(gameSlug)
    } catch {
      // An unknown slug on a live table is a data problem. Arming nothing is
      // the safe failure: no deadline means nobody is ejected by mistake.
      this.deps.logger.error({ gameSlug }, 'no meta for slug; arming no turn timer')
      return null
    }
  }
}

// ── Free functions ───────────────────────────────────────────────────────────

/**
 * Per-phase overrides beat the default — 04 §6.1.
 *
 * Shelem bids for 45 seconds and plays for 30, because deciding a contract is a
 * genuinely harder question than following suit. Expressed as a map on the meta
 * rather than as engine logic, because the engine may not look at a clock at
 * all (I1).
 */
export function turnTimeoutFor(meta: GameMeta, phase: string | null): number | null {
  if (phase !== null && meta.turnTimeoutByPhaseMs?.[phase] !== undefined) {
    return meta.turnTimeoutByPhaseMs[phase]
  }
  return meta.turnTimeoutMs
}
