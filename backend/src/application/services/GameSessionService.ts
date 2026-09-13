import type { Logger } from 'pino'
import { ILLEGAL_MOVE_ALERT_RULE } from '../../config/socketLimits.js'
import { SYSTEM_MESSAGE_KEYS } from '../../contracts/dto/chat.js'
import type { GameEventKind, SecuritySeverity } from '../../contracts/enums.js'
import type {
  GameFinishedPayload,
  GameNarrationPayload,
  GameStatePayload,
  NarrationKind,
  SeatingView,
} from '../../contracts/events.js'
import type { SeatAssignment, GameEvent, GameInstance } from '../../domain/entities/game.js'
import type { Table, TableMember } from '../../domain/entities/table.js'
import { AppError } from '../../domain/errors/AppError.js'
import {
  ForbiddenError,
  IllegalMoveError,
  IllegalPhaseTransitionError,
  NotFoundError,
  ValidationError,
} from '../../domain/errors/errors.js'
import type {
  AnyGameEngine,
  GameConfig,
  GameEventPayload,
  MoveResult,
  Viewer,
} from '../../domain/games/GameEngine.js'
import { OMNISCIENT, SPECTATOR, seatViewer } from '../../domain/games/GameEngine.js'
import type { GameRegistry } from '../../domain/games/registry.js'
import {
  DEAL_RNG_KEY,
  commitSeed,
  createSecureRng,
  gameRng,
  generateSeed,
  type Rng,
} from '../../domain/games/shared/rng.js'
import type { NewGameEvent } from '../../domain/repositories/games.js'
import type { IUnitOfWork, Repositories } from '../../domain/repositories/Repositories.js'
import type { IdentityRef } from '../../domain/value-objects/identity.js'
import { seatId, type SeatId } from '../../domain/value-objects/seat.js'
import { seatingNameOf } from '../mappers/tables.js'
import type { Clock } from '../ports/clock.js'
import type { IRateLimiter } from '../ports/rateLimiter.js'
import { systemClock } from '../ports/clock.js'
import { seatRoom, spectatorRoom, tableRoom, type IRealtimePublisher } from '../ports/realtime.js'
import { isTimerEvent, type TurnObserver } from '../ports/turns.js'
import type { ChatService } from './ChatService.js'
import type { GameCatalogService } from './GameCatalogService.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { SecurityEventService } from './SecurityEventService.js'
import type { SettlementService } from './SettlementService.js'
import type { TableService } from './TableService.js'

/**
 * ★ The event log, made a service — Phase G (S28–S30), 03 §4, 05 §6.
 *
 * This is the file where P4 ("the event log is the source of truth") stops
 * being an architectural sentence and becomes running code. Four properties
 * hold here and are each tested by name:
 *
 * | | |
 * |---|---|
 * | **Nothing lives in process memory** | Every move rebuilds state from `snapshot + events`. There is no `Map<gameId, state>` in this codebase, which is why an API restart loses zero games |
 * | **The database enforces idempotency** | `(gameId, clientMoveId)` is unique; a retried move returns the original ack rather than playing a second card (03 §4.4) |
 * | **Randomness is keyed by the log** | `gameRng(seed, seq)` — see the long note in `domain/games/shared/rng.ts`. Snapshot-independent, replay-exact, and not client-influenceable |
 * | **Projection happens once per viewer** | {@link GameSessionService.broadcastState} loops over seated members. There is deliberately no `publishToTable('game:state', …)` to reach for |
 *
 * ### The one thing to be careful about when extending this
 *
 * The *inputs* to a replay are the events that carry a `move`. Everything else
 * an engine emits — `PHASE`, `DEAL`, the narration — is **derived**, and
 * replaying it would apply the same transition twice. {@link isInputEvent} is
 * the single place that distinction is made; S32's timeout-applied default
 * actions are inputs too, which is why it tests for a `move` payload rather
 * than for `kind === 'MOVE'`.
 */

/** 03 §4.3 — every 25 events, always at a phase boundary, always on `FINISHED`. */
export const SNAPSHOT_EVERY = 25

/** 04 §5.3 — beyond this gap a `delta` stops being cheaper than a `full`. */
export const MAX_DELTA_GAP = 50

/** Snapshots kept per game by {@link GameSessionService.pruneSnapshots}. */
export const SNAPSHOTS_RETAINED = 2

export interface GameSessionDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly registry: GameRegistry
  readonly catalog: GameCatalogService
  readonly tables: TableService
  readonly chat: ChatService
  readonly realtime: IRealtimePublisher
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly clock?: Clock
  /**
   * Phase I. Optional for the same reason `IRealtimePublisher` is detachable:
   * a great many tests exercise the move pipeline with no economy at all, and
   * a settlement that is simply absent is more honest there than a stub that
   * pretends to pay. `container.ts` always provides one.
   */
  readonly settlement?: SettlementService
  /** Injected in tests so a deal is reproducible; production draws from the CSPRNG. */
  readonly seedRng?: Rng
  /** Counts rejections for the illegal-move escalation. Optional; absent ⇒ never escalate. */
  readonly rateLimiter?: IRateLimiter
  /**
   * S31, optional. Told after every state change so turn timers can arm and
   * bots can play — see `application/ports/turns.ts` for why this is a port and
   * not a call. Absent in every unit test of the move pipeline, which has no
   * interest in either.
   */
  readonly turns?: TurnObserver
}

/** Who is asking. `isHost` is derived from the table row, never from a request. */
export interface GameActor {
  readonly identity: IdentityRef
  readonly isHost: boolean
}

/** A game rebuilt from the log, with everything a caller needs to act on it. */
export interface RebuiltGame {
  readonly instance: GameInstance
  readonly engine: AnyGameEngine
  readonly state: unknown
  /** The seq of the newest event applied. `0` when the log is empty. */
  readonly seq: number
}

/** Who moved, for the turn observers. See `application/ports/turns.ts`. */
export type ActedBy = { readonly seat: SeatId; readonly by: 'human' | 'timeout' | 'bot' }

export interface AppliedMove {
  readonly instance: GameInstance
  readonly seq: number
  readonly replayed: boolean
}

export interface SyncOutcome {
  readonly mode: 'delta' | 'full'
  readonly fromSeq: number | null
  readonly toSeq: number
}

export class GameSessionService {
  constructor(private readonly deps: GameSessionDeps) {}

  // ── S28: creating the instance, and the commitment ────────────────────────

  /**
   * Deals a new game at a table — S28.
   *
   * The order of the four steps is the security property (04 §7):
   *
   *   1. draw the seed,
   *   2. compute `seedCommit = sha256(seed + gameId)`,
   *   3. persist both,
   *   4. **broadcast the commit — and only then** may anything be dealt.
   *
   * That is why the game id is chosen here rather than by the database: the
   * commitment includes it, so it must exist before the row does. A
   * create-then-update would leave a window in which the committed value on
   * disk was wrong, which is precisely the window the commitment exists to
   * close.
   */
  async createInstance(tableId: string, actor: GameActor): Promise<GameInstance> {
    const table = await this.deps.tables.require(tableId)

    // Host authority lives here rather than in the socket handler because a
    // matchmade table auto-starts with no socket involved (S43), and two gates
    // are how the two paths end up disagreeing.
    if (!actor.isHost) {
      throw new ForbiddenError('Only the host may start the game', { reason: 'HOST_REQUIRED' })
    }
    if (table.status !== 'WAITING') {
      throw new IllegalPhaseTransitionError(table.status, 'IN_PROGRESS', { tableId })
    }

    const existing = await this.deps.repos.games.findActiveByTable(tableId)
    if (existing !== null) {
      throw new IllegalPhaseTransitionError('ACTIVE', 'ACTIVE', {
        tableId,
        gameId: existing.id,
        reason: 'GAME_ALREADY_ACTIVE',
      })
    }

    const members = await this.deps.repos.tables.listMembers(tableId)
    const seated = seatedMembers(members)

    const meta = this.deps.catalog.assertPlayable(table.gameSlug, table.seatCount)
    if (!meta.playableCounts.includes(seated.length)) {
      throw new ValidationError(
        `${table.gameSlug} cannot be played by ${seated.length}`,
        { seats: ['errors.seatCountNotPlayable'] },
        { seated: seated.length, playableCounts: [...meta.playableCounts] },
      )
    }
    // Refuses before anything is written, so "announced but unplayable" never
    // produces a half-started table.
    this.deps.registry.requireEngine(table.gameSlug)

    const rng = this.deps.seedRng ?? createSecureRng()
    const rngSeed = generateSeed(rng)
    // Prefixed like every other id in the schema so a log line says what it is
    // at a glance. 24 hex characters — 96 bits, from the same source as the seed.
    const id = `gam${generateSeed(rng, 12)}`
    const seedCommit = commitSeed(rngSeed, id)

    const seating = await this.seatingOf(table, seated)

    const instance = await this.deps.repos.games.create({
      id,
      tableId,
      gameSlug: table.gameSlug,
      rngSeed,
      seedCommit,
      seating,
      options: table.options,
    })

    await this.deps.repos.tables.update(tableId, {
      status: 'IN_PROGRESS',
      startedAt: this.now(),
    })

    this.deps.metrics.increment('games_started')
    this.deps.logger.info(
      { tableId, gameId: instance.id, gameSlug: instance.gameSlug, seats: seated.length },
      'game started',
    )

    /**
     * ★ The commit goes out **before** the first projection, which is the whole
     * of 04 §7. Emitted from the service rather than from the socket handler —
     * a deliberate exception to the Phase F rule that seat announcements come
     * from the handler — because a game also starts with no socket in the
     * picture (matchmaking auto-start, S43) and two announcement paths are how
     * one of them ends up silent.
     */
    this.deps.realtime.publish(tableRoom(tableId), 'game:started', {
      tableId,
      gameId: instance.id,
      gameSlug: instance.gameSlug,
      seedCommit: instance.seedCommit,
      seating: seating.map(toSeatingView),
      startedAt: instance.startedAt.toISOString(),
      seq: instance.seq,
    })
    this.deps.realtime.publish(tableRoom(tableId), 'table:statusChanged', {
      tableId,
      status: 'IN_PROGRESS',
    })
    await this.deps.chat.system(tableId, SYSTEM_MESSAGE_KEYS.gameStarted, {
      game: instance.gameSlug,
    })

    // Only now does anybody learn a card. The deal itself is derived from the
    // seed on the first rebuild — there is no dealt state to leak until then.
    const rebuilt = await this.rebuildState(instance.id)
    await this.broadcastState(rebuilt)

    return instance
  }

  // ── S29: rebuilding from the log ──────────────────────────────────────────

  /**
   * ★ `state = replay(snapshot.state, events where seq > snapshot.seq)` — 03 §4.1.
   *
   * Called on **every** move, on every reconnect, and after every restart.
   * That sounds expensive and is not: the snapshot policy bounds the replay at
   * {@link SNAPSHOT_EVERY} events plus one JSON parse, and the alternative — a
   * mutable process map — is what makes a deploy lose every game in flight.
   */
  async rebuildState(gameId: string, repos: Repositories = this.deps.repos): Promise<RebuiltGame> {
    const instance = await repos.games.findById(gameId)
    if (instance === null) throw new NotFoundError('Game', { gameId })

    const engine = this.deps.registry.requireEngine(instance.gameSlug)
    const snapshot = await repos.snapshots.findLatest(gameId)

    let state: unknown =
      snapshot === null
        ? engine.createInitialState(configOf(instance), gameRng(instance.rngSeed, DEAL_RNG_KEY))
        : snapshot.state

    const fromSeq = snapshot?.seq ?? 0
    const events = await repos.events.listByGame(gameId, fromSeq + 1)
    let seq = fromSeq

    for (const event of events) {
      seq = Math.max(seq, event.seq)
      if (!isInputEvent(event)) continue

      // ★ One generator per input event, seeded from the event's own `seq`, and
      // shared by `applyMove` and the `advance` loop that follows it — so the
      // draws happen in the same order here as they did live, whether or not a
      // snapshot stands in front of them.
      const rng = gameRng(instance.rngSeed, event.seq)
      state = engine.applyMove(state, event.seat as SeatId, event.payload['move'], rng).state
      state = this.runAdvance(engine, state, rng).state
    }

    this.deps.metrics.increment('game_rebuilds')
    return { instance, engine, state, seq }
  }

  // ── S30: the move pipeline ────────────────────────────────────────────────

  /**
   * ★ The pipeline of 05 §6, in order. Every line of it is load-bearing.
   *
   * @throws {ForbiddenError} the caller holds no seat at this table
   * @throws {NotYourTurnError} / {@link IllegalMoveError} from the engine — both
   * of which are recorded as `AUDIT` events in the same ordered stream before
   * they are rethrown (03 §4.2), because a rejected move is the primary
   * cheating signal (07 §6).
   */
  async applyMove(input: {
    readonly gameId: string
    readonly identity: IdentityRef
    readonly move: Record<string, unknown>
    readonly clientMoveId: string
  }): Promise<AppliedMove> {
    const instance = await this.requireActive(input.gameId)

    /**
     * ★ The seat comes from the database, keyed by the socket's frozen
     * identity. There is no seat field on `game:move` to read even if this
     * wanted to — see the schema's docblock — so the entire
     * seat-impersonation class is closed by the *absence* of a branch here.
     */
    const seat = await this.seatOf(instance.tableId, input.identity)

    return this.apply({ instance, seat, move: input.move, clientMoveId: input.clientMoveId })
  }

  /**
   * ★ A move the **server** makes on a seat's behalf — S32's timeout default
   * action and S33's bot, 04 §6.5.
   *
   * It goes through the same pipeline as a human's move, on purpose, and that
   * single decision is what gets it the idempotency key, the `AUDIT` trail on
   * rejection, the snapshot policy, the per-viewer broadcast and the replay
   * guarantee for free. A second, quieter write path for automated moves is how
   * a bot's card ends up missing from a replay eighteen months from now.
   *
   * Two things differ from a human's move and both are deliberate:
   *
   * | | |
   * |---|---|
   * | `kind` | `TIMEOUT` for a default action, so the log distinguishes "played" from "did not play in time". `isInputEvent` tests for a `move` in the payload rather than for `kind === 'MOVE'`, so it still replays |
   * | attribution | A timeout's default action **is** the seat's move and is attributed to them; a bot's move after ejection carries no actor, because attributing it to the absent human would make the match history claim they played it |
   */
  async applySystemMove(input: {
    readonly gameId: string
    readonly seat: SeatId
    readonly move: Record<string, unknown>
    readonly clientMoveId: string
    readonly by: 'timeout' | 'bot'
    /** Merged into the input event's payload — `strikes`, for the narration. */
    readonly extra?: Record<string, unknown>
  }): Promise<AppliedMove> {
    const instance = await this.requireActive(input.gameId)

    return this.apply({
      instance,
      seat: input.seat,
      move: input.move,
      clientMoveId: input.clientMoveId,
      kind: input.by === 'timeout' ? 'TIMEOUT' : 'MOVE',
      anonymous: input.by === 'bot',
      ...(input.extra === undefined ? {} : { extra: input.extra }),
    })
  }

  private async apply(input: {
    readonly instance: GameInstance
    readonly seat: SeatId
    readonly move: Record<string, unknown>
    readonly clientMoveId: string
    readonly kind?: GameEventKind
    readonly anonymous?: boolean
    readonly extra?: Record<string, unknown>
  }): Promise<AppliedMove> {
    const { instance, seat } = input

    // Idempotency before any work: a retry after a dropped ack must cost one
    // indexed lookup, not a rebuild and a second card on the table.
    const prior = await this.deps.repos.events.findByClientMoveId(instance.id, input.clientMoveId)
    if (prior !== null) {
      this.deps.metrics.increment('moves_replayed')
      return { instance, seq: prior.seq, replayed: true }
    }

    let outcome: MoveOutcome
    try {
      outcome = await this.deps.uow.run(async (repos) =>
        this.applyWithin(repos, instance, seat, input.move, input.clientMoveId, {
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          anonymous: input.anonymous ?? false,
          extra: input.extra ?? {},
        }),
      )
    } catch (error) {
      // The transaction has rolled back, so the rejection is audited in its own
      // — which is correct: the AUDIT row must survive precisely because the
      // move did not.
      if (error instanceof AppError) await this.auditRejection(instance, seat, input, error)
      throw error
    }

    const rebuilt: RebuiltGame = {
      instance: outcome.instance,
      engine: outcome.engine,
      state: outcome.state,
      seq: outcome.seq,
    }

    this.narrate(rebuilt, outcome.appended)
    await this.broadcastState(rebuilt, {
      seat,
      by: input.kind === 'TIMEOUT' ? 'timeout' : (input.anonymous ?? false) ? 'bot' : 'human',
    })
    if (outcome.finished !== null) {
      this.announceFinish(outcome.instance, outcome.finished)
      await this.settle(outcome.instance, outcome.finished)
    }

    this.deps.metrics.increment('moves_applied')
    return { instance: outcome.instance, seq: outcome.seq, replayed: false }
  }

  /**
   * The transactional core. Everything here is one all-or-nothing write: a
   * rebuilt state that produced events, the events themselves, the bumped
   * instance `seq`, the snapshot if the policy says so, and the finish.
   */
  private async applyWithin(
    repos: Repositories,
    loaded: GameInstance,
    seat: SeatId,
    move: Record<string, unknown>,
    clientMoveId: string,
    system: SystemMoveOptions = { anonymous: false, extra: {} },
  ): Promise<MoveOutcome> {
    const { instance, engine, state, seq } = await this.rebuildState(loaded.id, repos)

    /**
     * ★ The seq the input event is about to take, computed *before* the engine
     * runs because the generator is keyed by it.
     *
     * It is then verified against what `append` actually assigned. They differ
     * only if another writer interleaved between the rebuild and the insert —
     * which cannot happen on SQLite (one writer per transaction) and which a
     * turn-based game makes vanishingly unlikely anywhere. If it ever does, the
     * state this move was computed from is stale, so the honest answer is to
     * roll the whole transaction back and let the client retry under the same
     * `clientMoveId` rather than to commit a move derived from a state that no
     * longer existed.
     */
    const inputSeq = seq + 1
    const rng = gameRng(instance.rngSeed, inputSeq)

    const first = engine.applyMove(state, seat, move, rng)
    const advanced = this.runAdvance(engine, first.state, rng)

    const emitted = [...first.events, ...advanced.events]
    const state2 = advanced.state

    const appended: GameEvent[] = []
    for (const [index, event] of emitted.entries()) {
      const row = await repos.events.append({
        gameId: instance.id,
        // The override applies to the *input* event alone: a timeout still
        // deals the next street as a `DEAL`, and relabelling everything the
        // transition emitted would make the log lie about what happened after.
        kind: index === 0 ? (system.kind ?? event.kind) : event.kind,
        seat: event.seat,
        ...(system.anonymous ? {} : actorFields(seat, instance)),
        // ★ Only the *input* event carries the idempotency key. A derived
        // `PHASE` row that also carried it would occupy the unique slot and
        // make a legitimate retry look like a replay of something it never sent.
        ...(index === 0 ? { clientMoveId } : {}),
        payload: index === 0 ? { ...event.payload, ...system.extra, move } : event.payload,
      } satisfies NewGameEvent)

      if (index === 0 && row.seq !== inputSeq) {
        throw new IllegalPhaseTransitionError('STALE', 'MOVE', {
          gameId: instance.id,
          expectedSeq: inputSeq,
          actualSeq: row.seq,
          reason: 'CONCURRENT_APPEND',
        })
      }
      appended.push(row)
    }

    const newSeq = appended.at(-1)?.seq ?? seq
    const terminal = engine.isTerminal(state2)

    if (shouldSnapshot(seq, newSeq, appended, terminal)) {
      await repos.snapshots.save({
        gameId: instance.id,
        seq: newSeq,
        state: state2 as Record<string, unknown>,
      })
      this.deps.metrics.increment('game_snapshots_written')
    }

    let finished: GameFinish | null = null
    let current = instance
    if (terminal) {
      const at = this.now()
      current = await repos.games.finish(instance.id, 'FINISHED', at)
      // The seed is published here and nowhere earlier (03 §5). Revealing it
      // while the hand is live would hand every player every other player's
      // cards, since the deal is a pure function of it.
      current = await repos.games.revealSeed(instance.id, at)
      await repos.tables.update(instance.tableId, { status: 'FINISHED' })
      finished = { result: engine.result(state2), at }
    }

    return {
      instance: { ...current, seq: newSeq },
      engine,
      state: state2,
      seq: newSeq,
      appended,
      finished,
    }
  }

  /**
   * `advance()` until it returns `null` — 05 §6.
   *
   * Bounded rather than a bare `while (true)`: an engine whose `advance` never
   * settles is a bug, and the difference between failing that request and
   * hanging the process is the difference between a stack trace and an outage.
   */
  private runAdvance(engine: AnyGameEngine, state: unknown, rng: Rng): MoveResult<unknown> {
    const events: GameEventPayload[] = []
    let current = state

    for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
      const next = engine.advance?.(current, rng) ?? null
      if (next === null) return { state: current, events }
      current = next.state
      events.push(...next.events)
    }

    throw new IllegalMoveError('advance() did not settle', {
      gameSlug: engine.meta.slug,
      steps: MAX_ADVANCE_STEPS,
    })
  }

  // ── S29: resync ───────────────────────────────────────────────────────────

  /**
   * `game:requestSync` — 04 §5.3.
   *
   * `delta` replays the missed narration and then sends one current state;
   * `full` sends the lobby snapshot and one current state. **`full` is always
   * correct** and is the fallback whenever anything is ambiguous, which is why
   * an absent `lastSeq`, a `lastSeq` ahead of the server, and a gap wider than
   * {@link MAX_DELTA_GAP} all land in the same branch.
   */
  async resync(input: {
    readonly gameId: string
    readonly identity: IdentityRef
    readonly socketId: string
    readonly lastSeq?: number
  }): Promise<SyncOutcome> {
    const rebuilt = await this.rebuildState(input.gameId)
    const { instance } = rebuilt
    const serverSeq = Math.max(instance.seq, rebuilt.seq)

    const viewer = await this.viewerFor(instance.tableId, input.identity)
    const behind = input.lastSeq === undefined ? null : serverSeq - input.lastSeq

    if (input.lastSeq !== undefined && input.lastSeq > serverSeq) {
      // A client claiming to be ahead of the log is a client whose state cannot
      // be reconciled by any amount of replay. Say so, then send it everything.
      this.deps.realtime.publishToSocket(input.socketId, 'game:syncRequired', {
        gameId: instance.id,
        reason: 'AHEAD_OF_SERVER',
      })
    }

    const full = behind === null || behind < 0 || behind > MAX_DELTA_GAP

    if (full) {
      const table = await this.deps.tables.require(instance.tableId)
      this.deps.realtime.publishToSocket(input.socketId, 'table:statusChanged', {
        tableId: table.id,
        status: table.status,
      })
      this.deps.realtime.publishToSocket(input.socketId, 'game:started', {
        tableId: instance.tableId,
        gameId: instance.id,
        gameSlug: instance.gameSlug,
        seedCommit: instance.seedCommit,
        seating: instance.seating.map(toSeatingView),
        startedAt: instance.startedAt.toISOString(),
        seq: serverSeq,
      })
      this.deps.realtime.publishToSocket(
        input.socketId,
        'game:state',
        this.statePayload(rebuilt, viewer, serverSeq),
      )

      this.deps.metrics.increment('game_resyncs_full')
      return { mode: 'full', fromSeq: null, toSeq: serverSeq }
    }

    const missed = await this.deps.repos.events.listByGame(instance.id, input.lastSeq! + 1)
    for (const event of missed) {
      // A persisted deadline is bookkeeping, not narration: replaying it would
      // put one "phase changed" line per turn into a reconnecting client's move
      // log. The *current* deadline reaches the socket separately, from
      // `TurnTimerService.announceToSocket` — a stale one would be worse than
      // none, since the client would count down to an instant already passed.
      if (isTimerEvent(event.payload)) continue
      this.deps.realtime.publishToSocket(
        input.socketId,
        'game:event',
        this.narrationOf(rebuilt, event),
      )
    }
    this.deps.realtime.publishToSocket(
      input.socketId,
      'game:state',
      this.statePayload(rebuilt, viewer, serverSeq),
    )

    this.deps.metrics.increment('game_resyncs_delta')
    return { mode: 'delta', fromSeq: input.lastSeq! + 1, toSeq: serverSeq }
  }

  // ── Projection ────────────────────────────────────────────────────────────

  /**
   * ★ `projectState` once per viewer — 04 §4.1, 05 §6.
   *
   * One state goes in; N different payloads come out, each addressed to the one
   * room entitled to it. **There is deliberately no `publish(tableRoom(id),
   * 'game:state', …)` anywhere in this codebase**, and
   * `tests/unit/socket/projection-boundary.test.ts` fails the build if one
   * appears — because that single line is the whole of the anti-cheat
   * architecture undone.
   *
   * The spectator projection is built from `SPECTATOR`, never from a seat, and
   * goes to `spectators:{id}`. That is one payload to many viewers and is
   * correct: a spectator view is public by definition, and the leak suite
   * asserts it holds no seat's hidden information for any seat.
   */
  async broadcastState(rebuilt: RebuiltGame, acted: ActedBy | null = null): Promise<void> {
    const { instance } = rebuilt
    const table = await this.deps.tables.require(instance.tableId)
    const members = await this.deps.repos.tables.listMembers(instance.tableId)
    const seq = Math.max(instance.seq, rebuilt.seq)

    for (const member of seatedMembers(members)) {
      const seat = seatId(member.seat as number)
      this.deps.realtime.publish(
        seatRoom(instance.tableId, seat),
        'game:state',
        this.statePayload(rebuilt, seatViewer(seat), seq),
      )
      this.deps.metrics.increment('game_states_projected')
    }

    if (table.allowSpectators) {
      this.deps.realtime.publish(
        spectatorRoom(instance.tableId),
        'game:state',
        this.statePayload(rebuilt, SPECTATOR, seq),
      )
      this.deps.metrics.increment('game_states_projected')
    }

    /**
     * ★ The Phase H seam, and the *only* one — `application/ports/turns.ts`.
     *
     * Every path that can change whose turn it is ends here: the deal, a human
     * move, a timeout's default action and a bot's move. Announcing once, from
     * the one place that already knows the new state, is what stops "re-arm the
     * turn timer" from being a line four callers have to remember.
     *
     * It is the last thing this method does, and it is **awaited**: the timer's
     * own `PHASE` append would otherwise race the next move's transaction for a
     * `seq`. It still cannot throw — the observer hub swallows — because a move
     * already written to the log must not be undone by a timer that failed to
     * arm.
     */
    await this.deps.turns?.onTurn({
      gameId: instance.id,
      tableId: instance.tableId,
      gameSlug: instance.gameSlug,
      seat: readToAct(rebuilt.state) === null ? null : seatId(readToAct(rebuilt.state)!),
      phase: readPhase(rebuilt.state),
      seq,
      terminal: rebuilt.engine.isTerminal(rebuilt.state),
      acted,
    })
  }

  /** One viewer's payload. The only place `projectState` is called for the wire. */
  statePayload(rebuilt: RebuiltGame, viewer: Viewer, seq: number): GameStatePayload {
    const { instance, engine, state } = rebuilt
    const toAct = readToAct(state)

    return {
      gameId: instance.id,
      tableId: instance.tableId,
      seq,
      phase: readPhase(state),
      view: engine.projectState(state, viewer),
      toAct,
      /**
       * ★ Only for the seat that is to act. Sending every seat its own legal
       * moves would be harmless in this game and a hand leak in Poker, where
       * "can you raise?" answers "how much is in front of you?". Being
       * consistent costs nothing and removes the judgement call per game.
       */
      legalMoves:
        viewer.kind === 'seat' && toAct === viewer.seat
          ? (engine.legalMoves(state, viewer.seat) as readonly unknown[])
          : null,
      isTerminal: engine.isTerminal(state),
      serverTime: this.now().getTime(),
    }
  }

  /** The omniscient projection — replay, dispute resolution, never a broadcast. */
  inspect(rebuilt: RebuiltGame): unknown {
    return rebuilt.engine.projectState(rebuilt.state, OMNISCIENT)
  }

  // ── S34: boot reconciliation ──────────────────────────────────────────────

  /**
   * Finishes any `ACTIVE` game whose rebuilt state is already terminal — the
   * startup half of S34.
   *
   * ### When this can actually fire
   *
   * Rarely, and that is the point of writing it down. A move and its `finish`
   * commit in one transaction, so the ordinary path cannot leave the two
   * disagreeing. What *can* is a transition the process died in the middle of
   * announcing, or — the case this is really for — a row left `ACTIVE` by an
   * older version of this code, a restored backup, or a hand-edited database.
   *
   * Running it at boot costs one rebuild per live game and turns a class of
   * "this table is stuck forever" bug into a log line. It is deliberately
   * separate from `TurnTimerService.resume()`, which runs straight after: a
   * finished game must not have a deadline re-armed against it.
   */
  async reconcileActive(): Promise<number> {
    const active = await this.deps.repos.games.listActive()
    let settled = 0

    for (const instance of active) {
      try {
        const rebuilt = await this.rebuildState(instance.id)
        if (!rebuilt.engine.isTerminal(rebuilt.state)) continue

        const at = this.now()
        await this.deps.repos.games.finish(instance.id, 'FINISHED', at)
        const revealed = await this.deps.repos.games.revealSeed(instance.id, at)
        await this.deps.repos.tables.update(instance.tableId, { status: 'FINISHED' })

        const finish = { result: rebuilt.engine.result(rebuilt.state), at }
        this.announceFinish(revealed, finish)
        await this.settle(revealed, finish)
        settled += 1

        this.deps.logger.warn(
          { gameId: instance.id, tableId: instance.tableId },
          'active game was already terminal at boot; settled',
        )
      } catch (error) {
        // One unreconcilable game must not stop the process from booting — and
        // must not stop the other games' deadlines from being re-armed.
        this.deps.logger.error(
          { err: error, gameId: instance.id },
          'could not reconcile active game at boot',
        )
      }
    }

    return settled
  }

  // ── Snapshot maintenance ──────────────────────────────────────────────────

  /**
   * Keeps the {@link SNAPSHOTS_RETAINED} newest snapshots and deletes the rest —
   * the weekly job of 03 §4.3.
   *
   * ★ **Events are never pruned.** Snapshots are a cache and can be rebuilt
   * from the log at any time; the log is the match itself, and it is what makes
   * a "that scored wrong" complaint into a regression test a year later.
   */
  async pruneSnapshots(gameId: string): Promise<number> {
    let cutoff: number | null = null
    for (let kept = 0; kept < SNAPSHOTS_RETAINED; kept += 1) {
      const next: { seq: number } | null = await this.deps.repos.snapshots.findLatest(
        gameId,
        cutoff === null ? undefined : cutoff - 1,
      )
      if (next === null) return 0
      cutoff = next.seq
    }

    const removed = await this.deps.repos.snapshots.deleteOlderThan(gameId, cutoff ?? 0)
    if (removed > 0) this.deps.metrics.increment('game_snapshots_pruned', removed)
    return removed
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async requireActive(gameId: string): Promise<GameInstance> {
    const instance = await this.deps.repos.games.findById(gameId)
    if (instance === null) throw new NotFoundError('Game', { gameId })
    if (instance.status !== 'ACTIVE') {
      throw new IllegalPhaseTransitionError(instance.status, 'ACTIVE', { gameId })
    }
    return instance
  }

  /** @throws {ForbiddenError} when the caller holds no live seat at the table. */
  private async seatOf(tableId: string, identity: IdentityRef): Promise<SeatId> {
    const member = await this.deps.repos.tables.findMemberByIdentity(tableId, identity)
    if (member === null || member.leftAt !== null || member.seat === null) {
      throw new ForbiddenError('You are not seated at this table', { reason: 'NOT_SEATED' })
    }
    return seatId(member.seat)
  }

  /** A seated caller sees their own hand; everyone else gets the spectator view. */
  private async viewerFor(tableId: string, identity: IdentityRef): Promise<Viewer> {
    const member = await this.deps.repos.tables.findMemberByIdentity(tableId, identity)
    if (member === null || member.leftAt !== null || member.seat === null) return SPECTATOR
    return seatViewer(seatId(member.seat))
  }

  /** Public narration for each appended event, to the table room. */
  private narrate(rebuilt: RebuiltGame, appended: readonly GameEvent[]): void {
    for (const event of appended) {
      this.deps.realtime.publish(
        tableRoom(rebuilt.instance.tableId),
        'game:event',
        this.narrationOf(rebuilt, event),
      )
    }
  }

  private narrationOf(rebuilt: RebuiltGame, event: GameEvent): GameNarrationPayload {
    const strikes = event.payload['strikes']

    return {
      gameId: rebuilt.instance.id,
      tableId: rebuilt.instance.tableId,
      seq: event.seq,
      kind: narrationKindOf(event),
      seat: event.seat,
      ...(typeof strikes === 'number' ? { strikes } : {}),
      /**
       * ★ An i18n key plus params, never a rendered sentence (02 §8.1) — the
       * same discipline as `SYSTEM` chat rows. A move log written in English
       * prose is a move log a Persian reader cannot read, forever.
       *
       * `describeMove` is asked to describe the move against the state the
       * table now holds, which is why narration is emitted after the
       * transaction rather than inside the engine.
       */
      descriptor: describeSafely(rebuilt, event),
    }
  }

  /**
   * ★ Settlement runs **after** the move's transaction commits — S36.
   *
   * Not inside it, and the distinction matters in both directions:
   *
   *   - A failure while paying must not un-play the last card. The log is the
   *     truth (P4); a game that finished, finished. Rolling the move back
   *     because a wallet write failed would make the match disagree with the
   *     event log that produced it.
   *   - A failure here must not turn a played card into a 500 either. The error
   *     is logged and swallowed, and the game stays settleable: `MatchResult`
   *     does not exist, so `reconcileActive()` picks it up at the next boot and
   *     `settle` is idempotent besides.
   *
   * Settlement owns its own all-or-nothing transaction, so *within* it a
   * partially-paid match is still impossible — which is the property 11 S36
   * actually asks for.
   */
  private async settle(instance: GameInstance, finish: GameFinish): Promise<void> {
    if (this.deps.settlement === undefined) return
    try {
      await this.deps.settlement.settle(instance, finish.result, finish.at)
    } catch (error) {
      this.deps.logger.error(
        { err: error, gameId: instance.id, tableId: instance.tableId },
        'settlement failed; the match stands and will be retried at boot',
      )
    }
  }

  private announceFinish(instance: GameInstance, finish: GameFinish): void {
    const payload: GameFinishedPayload = {
      gameId: instance.id,
      tableId: instance.tableId,
      seq: instance.seq,
      reason: finish.result.reason,
      winningTeam: finish.result.winningTeam ?? null,
      standings: finish.result.standings.map((standing) => ({
        seat: standing.seat,
        rank: standing.rank,
        score: standing.score,
        outcome: standing.outcome,
      })),
      summary: finish.result.summary,
      // ★ The reveal. Everything above it in this file exists to make sure this
      // line runs *after* the hand and never before it.
      seedRevealed: instance.rngSeed,
      seedCommit: instance.seedCommit,
    }

    this.deps.realtime.publish(tableRoom(instance.tableId), 'game:finished', payload)
    void this.deps.chat
      .system(instance.tableId, SYSTEM_MESSAGE_KEYS.gameFinished, {
        game: instance.gameSlug,
      })
      .catch((error: unknown) => this.deps.logger.error({ err: error }, 'finish narration failed'))

    this.deps.metrics.increment('games_finished')
  }

  /**
   * A rejected move, recorded as an `AUDIT` event in the same ordered stream
   * (03 §4.2) and as a `SecurityEvent` (07 §6).
   *
   * ★ The `clientMoveId` goes in the **payload**, never in the column. The
   * column is unique per game and is how a retry is recognised — putting a
   * rejected move's key there would make the honest retry of a corrected move
   * come back as "already applied".
   */
  private async auditRejection(
    instance: GameInstance,
    seat: SeatId,
    input: { readonly move: Record<string, unknown>; readonly clientMoveId: string },
    error: AppError,
  ): Promise<void> {
    const api = error.toApiError()

    try {
      await this.deps.repos.events.append({
        gameId: instance.id,
        kind: 'AUDIT',
        seat,
        payload: {
          rejected: true,
          code: api.code,
          i18nKey: api.i18nKey,
          clientMoveId: input.clientMoveId,
          attempted: input.move,
        },
      })
    } catch (appendError: unknown) {
      // An audit failure must not turn a refused move into a 500 — the player
      // is already being told no, and the reason they are being told it is
      // recorded in the security log below either way.
      this.deps.logger.error({ err: appendError }, 'could not append AUDIT event')
    }

    if (api.code === 'ILLEGAL_MOVE' || api.code === 'NOT_YOUR_TURN') {
      this.deps.security.record(
        api.code,
        {
          tableId: instance.tableId,
          gameId: instance.id,
          details: { seat, clientMoveId: input.clientMoveId },
        },
        await this.rejectionSeverity(instance, seat),
      )
    }

    this.deps.metrics.increment('moves_rejected')
  }

  /**
   * ★ One rejection is a mis-click; five in thirty seconds is a probe (04 §8).
   *
   * The rate limiter is used here as a *counter*, not as a gate — nothing is
   * refused by exceeding it. What changes is the severity of the audit row,
   * which is the difference between a line nobody reads and a line that pages
   * somebody. Keyed per identity rather than per socket, because opening a
   * second tab is exactly what an attacker would do to stay under a per-socket
   * count.
   */
  private async rejectionSeverity(instance: GameInstance, seat: SeatId): Promise<SecuritySeverity> {
    if (this.deps.rateLimiter === undefined) return 'INFO'

    const decision = await this.deps.rateLimiter.consume(
      `game:rejected:${instance.id}:${seat}`,
      ILLEGAL_MOVE_ALERT_RULE,
    )
    return decision.allowed ? 'INFO' : 'ALERT'
  }

  /** The seating snapshot, so history survives every later seat change. */
  private async seatingOf(table: Table, seated: readonly TableMember[]): Promise<SeatAssignment[]> {
    const directory = await this.deps.tables.directory(table, seated)

    return seated
      .map((member) => ({
        seat: seatId(member.seat as number),
        userId: member.userId,
        guestSessionId: member.guestSessionId,
        isBot: member.isBot,
        displayName: seatingNameOf(member, directory),
        team: member.team,
      }))
      .sort((a, b) => a.seat - b.seat)
  }

  private now(): Date {
    return new Date((this.deps.clock ?? systemClock).now())
  }
}

// ── Free functions ───────────────────────────────────────────────────────────

/** An `advance()` loop that has not settled by here is a bug, not a slow game. */
const MAX_ADVANCE_STEPS = 1_000

interface GameFinish {
  readonly result: ReturnType<AnyGameEngine['result']>
  readonly at: Date
}

/** What {@link GameSessionService.applySystemMove} changes about an ordinary move. */
interface SystemMoveOptions {
  /** `TIMEOUT` for a default action applied on a strike. Input event only. */
  readonly kind?: GameEventKind
  /** A bot's move records no actor: the absent human did not play it. */
  readonly anonymous: boolean
  /** Merged into the input event's payload — `strikes`, for the narration. */
  readonly extra: Record<string, unknown>
}

/**
 * ★ The log's vocabulary → the table's — 03 §4 vs 04 §5.2/§6.2.
 *
 * Six kinds are persisted and ten are narrated, and the difference is not an
 * inconsistency between the two documents: a timeout is *stored* as `TIMEOUT`
 * so `isInputEvent` replays the default action it applied, and *narrated* as
 * `TURN_TIMEOUT` so the client can render "Sara timed out — strike 1 of 2"
 * instead of a bare phase change. Ejection, substitution and return are stored
 * as `SYSTEM` rows carrying a `system` discriminator for exactly the same
 * reason.
 *
 * Derived here, from the row, rather than by the client guessing from a
 * payload — which is what makes it one function with one test rather than a
 * convention every renderer re-implements.
 */
export function narrationKindOf(event: GameEvent): NarrationKind {
  if (event.kind === 'TIMEOUT') return 'TURN_TIMEOUT'

  if (event.kind === 'SYSTEM') {
    const system = event.payload['system']
    if (system === 'BOT_TOOK_OVER' || system === 'PLAYER_RETURNED' || system === 'SEAT_ABANDONED') {
      return system
    }
  }

  return event.kind
}

interface MoveOutcome {
  readonly instance: GameInstance
  readonly engine: AnyGameEngine
  readonly state: unknown
  readonly seq: number
  readonly appended: readonly GameEvent[]
  readonly finished: GameFinish | null
}

/**
 * ★ Which logged events are *inputs* to a replay.
 *
 * An event is an input when it carries a `move` and names a seat. Everything
 * else an engine emits — `PHASE`, `DEAL`, and the `AUDIT` rows for refused
 * moves — is **derived** or **rejected**, and re-applying it would either
 * double a transition or apply one that never happened.
 *
 * Tested on the payload rather than on `kind === 'MOVE'` on purpose: S32
 * applies a default action on a timeout strike and logs it as `TIMEOUT`, and
 * that move genuinely did change the state.
 */
export function isInputEvent(event: GameEvent): boolean {
  if (event.kind === 'AUDIT' || event.seat === null) return false
  return Object.hasOwn(event.payload, 'move')
}

/**
 * 03 §4.3, in one predicate: every {@link SNAPSHOT_EVERY} events, always at a
 * phase boundary, always on terminal.
 *
 * The "every 25" arm tests whether the transition *crossed* a multiple rather
 * than landed on one — a move that appends two events must not be able to step
 * over the boundary and skip the snapshot, which would silently double the
 * replay cost of every rebuild after it.
 */
export function shouldSnapshot(
  fromSeq: number,
  toSeq: number,
  appended: readonly GameEvent[],
  terminal: boolean,
): boolean {
  if (terminal) return true
  if (appended.some((event) => event.kind === 'PHASE')) return true
  return Math.floor(toSeq / SNAPSHOT_EVERY) > Math.floor(fromSeq / SNAPSHOT_EVERY)
}

function configOf(instance: GameInstance): GameConfig {
  return {
    seats: instance.seating.map((assignment) => assignment.seat),
    options: instance.options,
  }
}

function seatedMembers(members: readonly TableMember[]): TableMember[] {
  return members
    .filter((member) => member.leftAt === null && member.seat !== null)
    .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
}

function toSeatingView(assignment: SeatAssignment): SeatingView {
  return {
    seat: assignment.seat,
    displayName: assignment.displayName,
    isBot: assignment.isBot,
    team: assignment.team,
  }
}

/**
 * Who acted, for re-attribution when a guest signs up mid-match (03 §7).
 *
 * Read from the frozen `seating` rather than from the live member row: the row
 * can change seats, leave, or be taken over by a bot, and a log that recorded
 * "whoever holds seat 2 now" would rewrite history every time somebody moved.
 */
function actorFields(
  seat: SeatId,
  instance: GameInstance,
): { actorUserId?: string; actorGuestId?: string } {
  const assignment = instance.seating.find((entry) => entry.seat === seat)
  if (assignment === undefined) return {}
  return {
    ...(assignment.userId === null ? {} : { actorUserId: assignment.userId }),
    ...(assignment.guestSessionId === null ? {} : { actorGuestId: assignment.guestSessionId }),
  }
}

/**
 * `phase` and `toAct` are read structurally from the state.
 *
 * Both are public in every game this platform will hold — whose turn it is and
 * which street you are on are things everyone at the table can see — so
 * surfacing them on the envelope saves every client from digging them out of a
 * `view` whose shape is per-game. An engine that names neither simply reports
 * `null`, which is what an untimed solo puzzle should say.
 */
function readPhase(state: unknown): string | null {
  const phase = (state as { phase?: unknown }).phase
  return typeof phase === 'string' ? phase : null
}

function readToAct(state: unknown): number | null {
  const toAct = (state as { toAct?: unknown }).toAct
  return typeof toAct === 'number' ? toAct : null
}

/**
 * Narration must never be able to fail a move that already committed.
 *
 * `describeMove` is engine code running against a state the engine has already
 * moved past, and an engine that throws there would otherwise turn a played
 * card into a 500 *after* it was written to the log.
 */
/**
 * The handful of payload fields a narration template may interpolate.
 *
 * A whitelist rather than a spread: an event payload can hold anything an
 * engine put there, and passing it wholesale to a translation string is how a
 * hidden field ends up rendered in a move log that spectators can read.
 */
function describableParams(payload: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const key of ['strikes', 'reason', 'phase'] as const) {
    if (Object.hasOwn(payload, key)) params[key] = payload[key]
  }
  return params
}

function describeSafely(
  rebuilt: RebuiltGame,
  event: GameEvent,
): { key: string; params: Record<string, unknown> } | null {
  if (!isInputEvent(event)) {
    // Keyed off the *narration* kind, so an ejection reads
    // `games.event.bot_took_over` rather than an undifferentiated
    // `games.event.system` that no translator could write a sentence for.
    return {
      key: `games.event.${narrationKindOf(event).toLowerCase()}`,
      params: { seat: event.seat, ...describableParams(event.payload) },
    }
  }

  try {
    const described = rebuilt.engine.describeMove(
      rebuilt.state,
      event.seat as SeatId,
      event.payload['move'],
    )
    return { key: described.key, params: described.params }
  } catch {
    return { key: 'games.event.move', params: { seat: event.seat } }
  }
}
