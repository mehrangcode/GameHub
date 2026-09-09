import type { GameInstanceStatus } from '../../../contracts/enums.js'
import type { GameEvent, GameInstance, GameSnapshot } from '../../../domain/entities/game.js'
import type { PlayerStats } from '../../../domain/entities/user.js'
import type {
  IGameEventRepository,
  IGameInstanceRepository,
  IGameSnapshotRepository,
  IStatsRepository,
  NewGameEvent,
  NewGameInstance,
  NewGameSnapshot,
  StatsPatch,
} from '../../../domain/repositories/games.js'
import { isUniqueViolation } from '../errors.js'
import {
  toGameEvent,
  toGameInstance,
  toGameSnapshot,
  toJson,
  toJsonOrNull,
  toPlayerStats,
} from '../mappers.js'
import { PrismaRepositoryBase } from './base.js'

export class PrismaGameInstanceRepository
  extends PrismaRepositoryBase
  implements IGameInstanceRepository
{
  async create(data: NewGameInstance): Promise<GameInstance> {
    const { seating, options, ...rest } = data
    return toGameInstance(
      await this.db.gameInstance.create({
        data: { ...rest, seatingJson: toJson(seating), optionsJson: toJson(options) },
      }),
    )
  }

  async findById(id: string): Promise<GameInstance | null> {
    const row = await this.db.gameInstance.findUnique({ where: { id } })
    return row ? toGameInstance(row) : null
  }

  async update(id: string, data: Partial<GameInstance>): Promise<GameInstance> {
    const { seating, options, ...rest } = data
    return this.mapMissing(
      async () =>
        toGameInstance(
          await this.db.gameInstance.update({
            where: { id },
            data: {
              ...rest,
              ...(seating === undefined ? {} : { seatingJson: toJson(seating) }),
              ...(options === undefined ? {} : { optionsJson: toJson(options) }),
            },
          }),
        ),
      'GameInstance',
      id,
    )
  }

  async delete(id: string): Promise<void> {
    await this.mapMissing(() => this.db.gameInstance.delete({ where: { id } }), 'GameInstance', id)
  }

  async findActiveByTable(tableId: string): Promise<GameInstance | null> {
    const row = await this.db.gameInstance.findFirst({
      where: { tableId, status: 'ACTIVE' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    })
    return row ? toGameInstance(row) : null
  }

  async listByTable(tableId: string): Promise<GameInstance[]> {
    const rows = await this.db.gameInstance.findMany({
      where: { tableId },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toGameInstance)
  }

  async finish(id: string, status: GameInstanceStatus, at: Date): Promise<GameInstance> {
    return this.mapMissing(
      async () =>
        toGameInstance(
          await this.db.gameInstance.update({
            where: { id },
            data: { status, finishedAt: at },
          }),
        ),
      'GameInstance',
      id,
    )
  }

  async revealSeed(id: string, at: Date): Promise<GameInstance> {
    return this.mapMissing(
      async () =>
        toGameInstance(
          await this.db.gameInstance.update({ where: { id }, data: { seedRevealedAt: at } }),
        ),
      'GameInstance',
      id,
    )
  }
}

/** How many times `append` retries a lost `(gameId, seq)` race before giving up. */
const SEQ_RETRIES = 5

export class PrismaGameEventRepository
  extends PrismaRepositoryBase
  implements IGameEventRepository
{
  /**
   * Appends at `lastSeq + 1` and bumps `GameInstance.seq` in the same
   * transaction, so a reader can never see an event the instance has not
   * counted.
   *
   * Two constraints do the real work here, and neither is advisory:
   *   - `(gameId, clientMoveId)` — a retried move returns the original event.
   *     Idempotency lives in the database rather than in a cache a restart
   *     would lose (03 §4.4).
   *   - `(gameId, seq)` — if two appends compute the same next `seq`, one loses
   *     and retries. Numbering by `MAX(seq) + 1` without that constraint would
   *     silently overwrite a move under concurrency.
   */
  async append(event: NewGameEvent): Promise<GameEvent> {
    const { payload, clientMoveId, ...rest } = event

    if (clientMoveId != null) {
      const existing = await this.findByClientMoveId(event.gameId, clientMoveId)
      if (existing) return existing
    }

    for (let attempt = 0; attempt < SEQ_RETRIES; attempt++) {
      const seq = (await this.lastSeq(event.gameId)) + 1
      try {
        return await this.atomically(async (db) => {
          const row = await db.gameEvent.create({
            data: {
              ...rest,
              seq,
              clientMoveId: clientMoveId ?? null,
              payloadJson: toJson(payload),
            },
          })
          await db.gameInstance.update({ where: { id: event.gameId }, data: { seq } })
          return toGameEvent(row)
        })
      } catch (error) {
        if (isUniqueViolation(error, 'clientMoveId') && clientMoveId != null) {
          const existing = await this.findByClientMoveId(event.gameId, clientMoveId)
          if (existing) return existing
        }
        if (!isUniqueViolation(error, 'seq')) throw error
        // Someone else took this seq. Recompute and try again.
      }
    }
    throw new Error(`could not allocate a seq for game ${event.gameId} after ${SEQ_RETRIES} tries`)
  }

  async findById(id: string): Promise<GameEvent | null> {
    const row = await this.db.gameEvent.findUnique({ where: { id } })
    return row ? toGameEvent(row) : null
  }

  async listByGame(gameId: string, fromSeq = 0, toSeq?: number): Promise<GameEvent[]> {
    const rows = await this.db.gameEvent.findMany({
      where: { gameId, seq: { gte: fromSeq, ...(toSeq === undefined ? {} : { lte: toSeq }) } },
      orderBy: { seq: 'asc' },
    })
    return rows.map(toGameEvent)
  }

  async findByClientMoveId(gameId: string, clientMoveId: string): Promise<GameEvent | null> {
    const row = await this.db.gameEvent.findFirst({ where: { gameId, clientMoveId } })
    return row ? toGameEvent(row) : null
  }

  async lastSeq(gameId: string): Promise<number> {
    const result = await this.db.gameEvent.aggregate({
      where: { gameId },
      _max: { seq: true },
    })
    return result._max.seq ?? 0
  }

  async countByGame(gameId: string): Promise<number> {
    return this.db.gameEvent.count({ where: { gameId } })
  }

  async reattributeActor(guestSessionId: string, userId: string): Promise<number> {
    const { count } = await this.db.gameEvent.updateMany({
      where: { actorGuestId: guestSessionId },
      data: { actorUserId: userId, actorGuestId: null },
    })
    return count
  }
}

export class PrismaGameSnapshotRepository
  extends PrismaRepositoryBase
  implements IGameSnapshotRepository
{
  async save(snapshot: NewGameSnapshot): Promise<GameSnapshot> {
    const { gameId, seq, state } = snapshot
    return toGameSnapshot(
      await this.db.gameSnapshot.upsert({
        where: { gameId_seq: { gameId, seq } },
        create: { gameId, seq, stateJson: toJson(state) },
        update: { stateJson: toJson(state) },
      }),
    )
  }

  async findById(id: string): Promise<GameSnapshot | null> {
    const row = await this.db.gameSnapshot.findUnique({ where: { id } })
    return row ? toGameSnapshot(row) : null
  }

  async findLatest(gameId: string, atOrBeforeSeq?: number): Promise<GameSnapshot | null> {
    const row = await this.db.gameSnapshot.findFirst({
      where: { gameId, ...(atOrBeforeSeq === undefined ? {} : { seq: { lte: atOrBeforeSeq } }) },
      orderBy: { seq: 'desc' },
    })
    return row ? toGameSnapshot(row) : null
  }

  async deleteOlderThan(gameId: string, seq: number): Promise<number> {
    const { count } = await this.db.gameSnapshot.deleteMany({ where: { gameId, seq: { lt: seq } } })
    return count
  }
}

const NUMERIC_STAT_KEYS = [
  'played',
  'won',
  'lost',
  'drawn',
  'forfeited',
  'currentStreak',
  'bestStreak',
  'totalMs',
] as const

export class PrismaStatsRepository extends PrismaRepositoryBase implements IStatsRepository {
  async findByUserAndGame(userId: string, gameSlug: string): Promise<PlayerStats | null> {
    const row = await this.db.playerStats.findUnique({
      where: { userId_gameSlug: { userId, gameSlug } },
    })
    return row ? toPlayerStats(row) : null
  }

  async listByUser(userId: string): Promise<PlayerStats[]> {
    const rows = await this.db.playerStats.findMany({
      where: { userId },
      orderBy: { gameSlug: 'asc' },
    })
    return rows.map(toPlayerStats)
  }

  async upsert(userId: string, gameSlug: string, patch: StatsPatch): Promise<PlayerStats> {
    const { extra, ...rest } = patch
    const data = { ...rest, ...(extra === undefined ? {} : { extraJson: toJsonOrNull(extra) }) }
    return toPlayerStats(
      await this.db.playerStats.upsert({
        where: { userId_gameSlug: { userId, gameSlug } },
        create: { userId, gameSlug, ...data },
        update: data,
      }),
    )
  }

  async increment(userId: string, gameSlug: string, deltas: StatsPatch): Promise<PlayerStats> {
    const { extra } = deltas
    const increments: Record<string, { increment: number }> = {}
    for (const key of NUMERIC_STAT_KEYS) {
      const delta = deltas[key]
      if (typeof delta === 'number') increments[key] = { increment: delta }
    }

    // `create` gets the raw values, `update` the increments — one round trip
    // either way, and no read-modify-write window for a concurrent settlement.
    const createValues: Record<string, number> = {}
    for (const key of NUMERIC_STAT_KEYS) {
      const delta = deltas[key]
      if (typeof delta === 'number') createValues[key] = delta
    }

    return toPlayerStats(
      await this.db.playerStats.upsert({
        where: { userId_gameSlug: { userId, gameSlug } },
        create: {
          userId,
          gameSlug,
          ...createValues,
          ...(extra === undefined ? {} : { extraJson: toJsonOrNull(extra) }),
        },
        update: {
          ...increments,
          ...(extra === undefined ? {} : { extraJson: toJsonOrNull(extra) }),
        },
      }),
    )
  }
}
