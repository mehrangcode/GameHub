import type { GameInstanceStatus } from '../../contracts/enums.js'
import type { GameEvent, GameInstance, GameSnapshot } from '../entities/game.js'
import type { PlayerStats } from '../entities/user.js'
import type { Draft, IRepository } from './IRepository.js'

export type NewGameInstance = Draft<
  GameInstance,
  'status' | 'seedRevealedAt' | 'seq' | 'startedAt' | 'finishedAt'
> & {
  /**
   * ★ The one entity in the schema whose id the **caller** may choose, and the
   * reason is the commitment: `seedCommit = sha256(rngSeed + id)` has to be
   * computed before the row exists, because it is published before the deal
   * (03 §5, 04 §7). Letting the database mint the id would force a
   * create-then-update, and for the window between those two writes the
   * committed value on disk would be wrong.
   *
   * Omit it and the database's `cuid()` default applies, exactly as before.
   */
  readonly id?: string
}

export interface IGameInstanceRepository extends IRepository<GameInstance> {
  create(data: NewGameInstance): Promise<GameInstance>
  findActiveByTable(tableId: string): Promise<GameInstance | null>
  /**
   * Every game still in play, anywhere — the startup re-arm of S34, 04 §5.4.
   *
   * Deliberately unbounded and unpaged: it is called once, at boot, and a
   * platform with enough live games for that to matter has bigger problems than
   * one query. Ordered oldest-first so the deadline closest to expiry is
   * re-armed first.
   */
  listActive(): Promise<GameInstance[]>
  listByTable(tableId: string): Promise<GameInstance[]>
  finish(id: string, status: GameInstanceStatus, at: Date): Promise<GameInstance>
  /** Publishes the deal seed once the hand is over (05 §3, 07 §4). */
  revealSeed(id: string, at: Date): Promise<GameInstance>
}

/** `seq` is assigned by {@link IGameEventRepository.append}, never by a caller. */
export type NewGameEvent = Omit<
  Draft<GameEvent, 'seat' | 'actorUserId' | 'actorGuestId' | 'clientMoveId'>,
  'seq'
>

/**
 * P4 — the log is the truth.
 *
 * Deliberately **not** an `IRepository`: there is no `update` and no `delete`,
 * because an event that can be rewritten is not an audit trail. A correction is
 * a new event.
 */
export interface IGameEventRepository {
  /**
   * Appends at `lastSeq + 1` and bumps `GameInstance.seq` in the same breath.
   *
   * Returns the **existing** event when `clientMoveId` has already been used
   * for this game: a socket retry after a dropped ack must be a no-op, not a
   * second card on the table. The `(gameId, clientMoveId)` unique constraint —
   * not a cache a restart could lose — is what enforces that (03 §4.4).
   */
  append(event: NewGameEvent): Promise<GameEvent>
  findById(id: string): Promise<GameEvent | null>
  /** Inclusive range, ordered by `seq`. `fromSeq` defaults to the beginning. */
  listByGame(gameId: string, fromSeq?: number, toSeq?: number): Promise<GameEvent[]>
  findByClientMoveId(gameId: string, clientMoveId: string): Promise<GameEvent | null>
  lastSeq(gameId: string): Promise<number>
  countByGame(gameId: string): Promise<number>
  /**
   * Claim transaction (03 §7): the guest's moves become the new user's moves,
   * so match history survives the signup. Returns the number of rows rewritten.
   */
  reattributeActor(guestSessionId: string, userId: string): Promise<number>
}

export type NewGameSnapshot = Draft<GameSnapshot, never>

/** A cache in front of the log. Losing every row here costs replay time, nothing more. */
export interface IGameSnapshotRepository {
  save(snapshot: NewGameSnapshot): Promise<GameSnapshot>
  findById(id: string): Promise<GameSnapshot | null>
  /** The newest snapshot at or before `atOrBeforeSeq` — the rebuild starting point. */
  findLatest(gameId: string, atOrBeforeSeq?: number): Promise<GameSnapshot | null>
  deleteOlderThan(gameId: string, seq: number): Promise<number>
}

export type StatsPatch = Partial<Omit<PlayerStats, 'id' | 'userId' | 'gameSlug' | 'updatedAt'>>

export interface IStatsRepository {
  findByUserAndGame(userId: string, gameSlug: string): Promise<PlayerStats | null>
  listByUser(userId: string): Promise<PlayerStats[]>
  /** Create-or-patch; `(userId, gameSlug)` is unique. */
  upsert(userId: string, gameSlug: string, patch: StatsPatch): Promise<PlayerStats>
  /** Adds to the counters instead of replacing them — the post-match path. */
  increment(userId: string, gameSlug: string, deltas: StatsPatch): Promise<PlayerStats>
}
