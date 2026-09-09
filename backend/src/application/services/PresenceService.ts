import type { Logger } from 'pino'
import type { PresenceEntry, PresenceState } from '../../contracts/dto/presence.js'
import { PRESENCE_AWAY_AFTER_MS, PRESENCE_SWEEP_MS } from '../../config/socketLimits.js'
import type { TableMember } from '../../domain/entities/table.js'
import type { GameRegistry } from '../../domain/games/registry.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import { holderKey, type IdentityRef } from '../../domain/value-objects/identity.js'
import type { Clock, TimerHandle } from '../ports/clock.js'
import { tableRoom, type IRealtimePublisher } from '../ports/realtime.js'
import type { MetricsRegistry } from './MetricsRegistry.js'

/**
 * Presence and the disconnect grace timer — S25, 04 §5.2.
 *
 * ### What this service is for
 *
 * When somebody's phone drops out of signal, every other seat sees a player who
 * is *thinking*. Presence is what turns that into "Sara reconnecting… 0:58",
 * and the difference decides whether the other three wait or write off the
 * evening.
 *
 * ### Where the state lives, and why
 *
 * Live presence is **in process**, keyed by identity, and is deliberately
 * ephemeral: it is cheap to lose and cheap to recompute (02 §3.2 — the same
 * reasoning that lets rate limits live in Redis). After a restart, whoever is
 * still connected reconnects within seconds and re-announces themselves; a
 * persisted `state: 'online'` column, by contrast, would survive the restart as
 * a *lie* about people who are no longer there.
 *
 * Exactly one thing is persisted: **`TableMember.disconnectedAt`**. The grace
 * deadline is derived from it, so an API restart re-arms the timer from where
 * it actually stood rather than gifting the absent player a fresh 90 seconds
 * (04 §5.4). That single column is the difference between a restart being
 * invisible and a restart being an exploit.
 *
 * ### Multi-tab
 *
 * Presence is tracked per **identity**, holding a set of that identity's live
 * socket ids. Closing one of two tabs therefore does nothing: the seat stays
 * `online`, because the person is still there. Only the last socket closing
 * starts the grace clock. Getting this wrong produces the most annoying
 * possible bug — a phantom "reconnecting…" badge on somebody who is playing.
 */

/** Everything the grace-expiry hook needs. S33 turns this into an ejection. */
export interface GraceExpired {
  readonly tableId: string
  readonly memberId: string
  readonly seat: number | null
  readonly identity: IdentityRef
  readonly gameSlug: string
  /** When the transport actually dropped, not when the timer fired. */
  readonly disconnectedAt: Date
}

export type GraceExpiredHandler = (event: GraceExpired) => void | Promise<void>

interface Tracked {
  readonly identity: IdentityRef
  readonly memberId: string
  seat: number | null
  readonly sockets: Set<string>
  state: PresenceState
  lastSeenAt: number
  disconnectedAt: Date | null
  graceEndsAt: number | null
  timer: TimerHandle | null
}

export interface PresenceServiceDeps {
  readonly repos: Repositories
  readonly registry: GameRegistry
  readonly realtime: IRealtimePublisher
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly clock: Clock
  /**
   * Tests hand in a tiny grace so a real 15–90 second window does not have to
   * elapse. Production leaves it unset and every game gets its own
   * `meta.disconnectGraceMs` — Blackjack 45 s, Shelem 90 s, Sudoku effectively
   * never, because a solo puzzle has nobody to hold up.
   */
  readonly graceMsOverride?: number
  /**
   * S27, optional. Publishes a *copy* of this table's presence to Redis so a
   * second API instance can render the seat map without asking this one.
   *
   * Optional because it must be: with no Redis there is one instance, and the
   * in-process map above is the whole truth. Nothing ever reads the mirror to
   * make a decision — ejection and reward eligibility read
   * `TableMember.disconnectedAt` from the database — so losing it costs one
   * recomputation and nothing else.
   */
  readonly mirror?: { publish(tableId: string, entries: readonly PresenceEntry[]): Promise<void> }
}

export class PresenceService {
  /** `tableId` → `holderKey` → tracked presence. */
  private readonly tables = new Map<string, Map<string, Tracked>>()
  private readonly onExpired: GraceExpiredHandler[] = []
  private sweeper: TimerHandle | null = null

  constructor(private readonly deps: PresenceServiceDeps) {}

  /**
   * Registers the hook S33 turns into an ejection.
   *
   * The mechanism ships now and the consequence later, on purpose: a grace
   * timer that fires reliably is a testable claim today, whereas "and then a
   * bot takes over" needs an engine that does not exist until S30.
   */
  onGraceExpired(handler: GraceExpiredHandler): void {
    this.onExpired.push(handler)
  }

  /** Starts the `away` sweeper. Called once, by the gateway. */
  start(): void {
    if (this.sweeper !== null) return
    const tick = () => {
      this.sweepAway()
      this.sweeper = this.deps.clock.schedule(PRESENCE_SWEEP_MS, tick)
    }
    this.sweeper = this.deps.clock.schedule(PRESENCE_SWEEP_MS, tick)
  }

  /** Cancels every armed timer. Called by `container.shutdown()`. */
  stop(): void {
    if (this.sweeper !== null) {
      this.deps.clock.cancel(this.sweeper)
      this.sweeper = null
    }
    for (const members of this.tables.values()) {
      for (const tracked of members.values()) {
        if (tracked.timer !== null) this.deps.clock.cancel(tracked.timer)
        tracked.timer = null
      }
    }
    this.tables.clear()
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  /**
   * A socket joined a table.
   *
   * `reconnected` tells the caller to resend a full snapshot (04 §5.2) — what
   * makes a tunnel look like a hiccup rather than a restart. `firstSocket`
   * tells it whether to announce an arrival: on a second tab there is nobody
   * new to announce, and broadcasting one would put a duplicate "Sara joined"
   * in front of everyone every time she opened a window.
   */
  async attach(
    tableId: string,
    identity: IdentityRef,
    member: TableMember,
    socketId: string,
  ): Promise<{ reconnected: boolean; firstSocket: boolean }> {
    const members = this.tableMap(tableId)
    const key = holderKey(identity)
    const existing = members.get(key)
    const now = this.deps.clock.now()

    if (existing !== undefined) {
      const wasDisconnected = existing.state === 'disconnected'
      existing.sockets.add(socketId)
      existing.seat = member.seat
      existing.lastSeenAt = now
      this.cancelGrace(existing)

      if (existing.state !== 'online') {
        existing.state = 'online'
        await this.clearDisconnectedAt(member)
        this.announce(tableId, existing)
      }

      if (wasDisconnected) this.deps.metrics.increment('reconnects')
      return { reconnected: wasDisconnected, firstSocket: existing.sockets.size === 1 }
    }

    members.set(key, {
      identity,
      memberId: member.id,
      seat: member.seat,
      sockets: new Set([socketId]),
      state: 'online',
      lastSeenAt: now,
      disconnectedAt: null,
      graceEndsAt: null,
      timer: null,
    })

    // A member row carrying `disconnectedAt` from a previous session is a
    // player coming back after an API restart, not a new arrival. Clearing it
    // here is what makes the restart invisible from every other seat.
    const reconnected = member.disconnectedAt !== null
    if (reconnected) {
      await this.clearDisconnectedAt(member)
      this.deps.metrics.increment('reconnects')
    }

    this.announce(tableId, members.get(key)!)
    return { reconnected, firstSocket: true }
  }

  /**
   * A socket left a table — by `table:leave`, or by the transport closing.
   *
   * ★ The multi-tab check is the whole method. Only when the identity's **last**
   * socket at this table has gone does the grace clock start; a second tab
   * closing is a non-event, and treating it as a disconnect would put a
   * permanent "reconnecting…" badge on somebody who is sitting there playing.
   */
  async detach(tableId: string, identity: IdentityRef, socketId: string): Promise<void> {
    const members = this.tables.get(tableId)
    const tracked = members?.get(holderKey(identity))
    if (members === undefined || tracked === undefined) return

    tracked.sockets.delete(socketId)
    if (tracked.sockets.size > 0) return

    const member = await this.deps.repos.tables.findMemberByIdentity(tableId, identity)
    if (member === null || member.leftAt !== null) {
      this.forget(tableId, identity)
      return
    }

    const disconnectedAt = new Date(this.deps.clock.now())
    const graceMs = await this.graceMsFor(tableId)

    tracked.state = 'disconnected'
    tracked.disconnectedAt = disconnectedAt
    tracked.graceEndsAt = this.deps.clock.now() + graceMs
    tracked.seat = member.seat

    await this.deps.repos.tables.updateMember(member.id, { disconnectedAt })
    this.announce(tableId, tracked)
    this.armGrace(tableId, tracked, graceMs)
  }

  /** A heartbeat, or any other action — both prove the client is alive. */
  touch(tableId: string, identity: IdentityRef): void {
    const tracked = this.tables.get(tableId)?.get(holderKey(identity))
    if (tracked === undefined) return

    tracked.lastSeenAt = this.deps.clock.now()
    if (tracked.state === 'away') {
      tracked.state = 'online'
      this.announce(tableId, tracked)
    }
  }

  /** Keeps the tracked seat in step with a claim or a release. */
  noteSeat(tableId: string, identity: IdentityRef, member: TableMember): void {
    const tracked = this.tables.get(tableId)?.get(holderKey(identity))
    if (tracked === undefined) return
    tracked.seat = member.seat
  }

  /** Drops a member entirely — they left on purpose, so there is nothing to wait for. */
  forget(tableId: string, identity: IdentityRef): void {
    const members = this.tables.get(tableId)
    const tracked = members?.get(holderKey(identity))
    if (members === undefined || tracked === undefined) return

    this.cancelGrace(tracked)
    members.delete(holderKey(identity))
    if (members.size === 0) this.tables.delete(tableId)
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  stateOf(
    tableId: string,
    member: TableMember,
  ): { state: PresenceState; graceEndsAt: string | null } {
    // A bot has no transport to lose and is never "reconnecting".
    const identity = identityOfMember(member)
    if (identity === null) return { state: 'online', graceEndsAt: null }

    const tracked = this.tables.get(tableId)?.get(holderKey(identity))
    if (tracked === undefined) {
      // Untracked means "holds a seat but has no socket here" — which is exactly
      // how a seat claimed over REST looks. Reported honestly as disconnected
      // rather than as an optimistic `online` that the seat map would then have
      // to walk back the moment anyone looked at it.
      return { state: 'disconnected', graceEndsAt: null }
    }

    return {
      state: tracked.state,
      graceEndsAt:
        tracked.graceEndsAt === null ? null : new Date(tracked.graceEndsAt).toISOString(),
    }
  }

  entriesFor(tableId: string): PresenceEntry[] {
    return [...(this.tables.get(tableId)?.values() ?? [])].map((tracked) => ({
      memberId: tracked.memberId,
      seat: tracked.seat,
      state: tracked.state,
      graceEndsAt:
        tracked.graceEndsAt === null ? null : new Date(tracked.graceEndsAt).toISOString(),
    }))
  }

  /** Live socket ids for one identity at one table. Used to evict a kicked player. */
  socketsOf(tableId: string, identity: IdentityRef): readonly string[] {
    return [...(this.tables.get(tableId)?.get(holderKey(identity))?.sockets ?? [])]
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private tableMap(tableId: string): Map<string, Tracked> {
    let members = this.tables.get(tableId)
    if (members === undefined) {
      members = new Map()
      this.tables.set(tableId, members)
    }
    return members
  }

  /**
   * The grace window is the *game's*, not the platform's (04 §5.2). Shelem gets
   * 90 seconds because a four-player partnership match is ruined by a forfeit;
   * Sudoku gets effectively forever because there is nobody to hold up.
   */
  private async graceMsFor(tableId: string): Promise<number> {
    if (this.deps.graceMsOverride !== undefined) return this.deps.graceMsOverride

    const table = await this.deps.repos.tables.findById(tableId)
    if (table === null) return 0

    try {
      return this.deps.registry.meta(table.gameSlug).disconnectGraceMs
    } catch {
      // An unknown slug on a live table is a data problem, not a reason to hold
      // a seat forever. Fall back to the shortest sensible window.
      return 45_000
    }
  }

  private armGrace(tableId: string, tracked: Tracked, graceMs: number): void {
    // `clearTimer`, **not** `cancelGrace`. `cancelGrace` also forgets
    // `disconnectedAt` and `graceEndsAt`, which is right when somebody comes
    // back and catastrophic here: `detach` sets both immediately before this
    // call, so arming the timer would erase the two facts the timer exists to
    // act on — the countdown would render as absent and the hook would find
    // nothing to expire.
    this.clearTimer(tracked)

    tracked.timer = this.deps.clock.schedule(graceMs, () => {
      // The timer is cleared *before* the hook runs, so a handler that throws
      // cannot leave a member permanently un-expirable — and so the "exactly
      // once" property holds even if a hook re-enters this service.
      tracked.timer = null
      tracked.graceEndsAt = null

      const disconnectedAt = tracked.disconnectedAt
      if (disconnectedAt === null) return

      void this.fireExpired(tableId, tracked, disconnectedAt)
    })
  }

  /** Disarms the timer and nothing else. Safe to call before re-arming. */
  private clearTimer(tracked: Tracked): void {
    if (tracked.timer !== null) this.deps.clock.cancel(tracked.timer)
    tracked.timer = null
  }

  /**
   * The player is back, or gone for good: disarm the timer *and* forget the
   * absence it was counting down. Both facts have to go together — a cleared
   * timer with a live `disconnectedAt` would show a countdown that never ends.
   */
  private cancelGrace(tracked: Tracked): void {
    this.clearTimer(tracked)
    tracked.graceEndsAt = null
    tracked.disconnectedAt = null
  }

  private async fireExpired(
    tableId: string,
    tracked: Tracked,
    disconnectedAt: Date,
  ): Promise<void> {
    // Consumed here so a second firing — a duplicate timer, a hook that
    // reconnects and drops again — cannot produce a second ejection.
    tracked.disconnectedAt = null

    const table = await this.deps.repos.tables.findById(tableId)
    const event: GraceExpired = {
      tableId,
      memberId: tracked.memberId,
      seat: tracked.seat,
      identity: tracked.identity,
      gameSlug: table?.gameSlug ?? 'unknown',
      disconnectedAt,
    }

    this.deps.logger.info(
      { tableId, memberId: tracked.memberId, seat: tracked.seat },
      'disconnect grace expired',
    )
    this.deps.metrics.increment('presence_grace_expired')

    for (const handler of this.onExpired) {
      try {
        await handler(event)
      } catch (error) {
        // One bad hook must not stop the others, and must not take the process
        // down from inside a timer callback where nobody is catching.
        this.deps.logger.error({ err: error, tableId }, 'grace-expiry handler threw')
      }
    }
  }

  private async clearDisconnectedAt(member: TableMember): Promise<void> {
    if (member.disconnectedAt === null) return
    await this.deps.repos.tables.updateMember(member.id, { disconnectedAt: null })
  }

  /**
   * `away` is the soft state between "typing" and "gone": the transport is
   * still up but the client has stopped heart-beating, which is what a
   * backgrounded phone tab looks like. It never starts a grace timer — nothing
   * is at stake yet — it just stops the other players from waiting on somebody
   * whose screen is off.
   */
  private sweepAway(): void {
    const now = this.deps.clock.now()

    for (const [tableId, members] of this.tables) {
      for (const tracked of members.values()) {
        if (tracked.state !== 'online') continue
        if (now - tracked.lastSeenAt < PRESENCE_AWAY_AFTER_MS) continue

        tracked.state = 'away'
        this.announce(tableId, tracked)
      }
    }
  }

  private announce(tableId: string, tracked: Tracked): void {
    // Fire-and-forget, and deliberately after the broadcast is queued: the
    // mirror is a convenience for other instances, and a Redis hiccup must
    // never delay the badge the players at this table are waiting to see.
    void this.deps.mirror?.publish(tableId, this.entriesFor(tableId)).catch(() => undefined)

    this.deps.realtime.publish(tableRoom(tableId), 'table:presence', {
      tableId,
      memberId: tracked.memberId,
      seat: tracked.seat,
      state: tracked.state,
      graceEndsAt:
        tracked.graceEndsAt === null ? null : new Date(tracked.graceEndsAt).toISOString(),
    })
  }
}

function identityOfMember(member: TableMember): IdentityRef | null {
  if (member.userId !== null) return { kind: 'user', userId: member.userId }
  if (member.guestSessionId !== null) {
    return { kind: 'guest', guestSessionId: member.guestSessionId }
  }
  return null
}
