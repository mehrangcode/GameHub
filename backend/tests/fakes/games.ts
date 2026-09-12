import type { GameInstanceStatus } from '../../src/contracts/enums.js'
import type { GameEvent, GameInstance, GameSnapshot } from '../../src/domain/entities/game.js'
import type { PlayerStats } from '../../src/domain/entities/user.js'
import type {
  IGameEventRepository,
  IGameInstanceRepository,
  IGameSnapshotRepository,
  IStatsRepository,
  NewGameEvent,
  NewGameInstance,
  NewGameSnapshot,
  StatsPatch,
} from '../../src/domain/repositories/games.js'
import { Collection, clone, cloneAll, nextId } from './store.js'

export class InMemoryGameInstanceRepository implements IGameInstanceRepository {
  readonly rows = new Collection<GameInstance>('GameInstance')

  async create(data: NewGameInstance): Promise<GameInstance> {
    // `...data` last would overwrite the generated id with an explicit
    // `undefined` whenever the caller omitted one — Prisma treats that as "use
    // the default", and a fake that did not would disagree with the database on
    // the commonest call of all.
    const { id, ...rest } = data
    return this.rows.insert({
      id: id ?? nextId('gam'),
      status: 'ACTIVE',
      seedRevealedAt: null,
      seq: 0,
      finishedAt: null,
      startedAt: new Date(),
      ...rest,
    })
  }

  async findById(id: string): Promise<GameInstance | null> {
    return this.rows.get(id)
  }

  async update(id: string, data: Partial<GameInstance>): Promise<GameInstance> {
    return this.rows.patch(id, data)
  }

  async delete(id: string): Promise<void> {
    this.rows.remove(id)
  }

  async findActiveByTable(tableId: string): Promise<GameInstance | null> {
    return this.rows.find((g) => g.tableId === tableId && g.status === 'ACTIVE')
  }

  async listByTable(tableId: string): Promise<GameInstance[]> {
    return cloneAll(
      this.rows
        .all()
        .filter((g) => g.tableId === tableId)
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
    )
  }

  async finish(id: string, status: GameInstanceStatus, at: Date): Promise<GameInstance> {
    return this.rows.patch(id, { status, finishedAt: at })
  }

  async revealSeed(id: string, at: Date): Promise<GameInstance> {
    return this.rows.patch(id, { seedRevealedAt: at })
  }
}

export class InMemoryGameEventRepository implements IGameEventRepository {
  readonly rows = new Collection<GameEvent>('GameEvent')

  /** Wired by the harness so `append` can bump `GameInstance.seq` like the real one. */
  games?: InMemoryGameInstanceRepository

  async append(event: NewGameEvent): Promise<GameEvent> {
    // Move idempotency, before anything is written: a socket retry after a
    // dropped ack returns the original event rather than playing a second card.
    if (event.clientMoveId != null) {
      const existing = await this.findByClientMoveId(event.gameId, event.clientMoveId)
      if (existing) return existing
    }

    const seq = (await this.lastSeq(event.gameId)) + 1
    const row = this.rows.insert({
      id: nextId('evt'),
      seat: null,
      actorUserId: null,
      actorGuestId: null,
      clientMoveId: null,
      ...event,
      seq,
      createdAt: new Date(),
    })
    if (this.games?.rows.peek(event.gameId)) {
      this.games.rows.patch(event.gameId, { seq })
    }
    return row
  }

  async findById(id: string): Promise<GameEvent | null> {
    return this.rows.get(id)
  }

  async listByGame(
    gameId: string,
    fromSeq = 0,
    toSeq = Number.MAX_SAFE_INTEGER,
  ): Promise<GameEvent[]> {
    return cloneAll(
      this.rows
        .all()
        .filter((e) => e.gameId === gameId && e.seq >= fromSeq && e.seq <= toSeq)
        .sort((a, b) => a.seq - b.seq),
    )
  }

  async findByClientMoveId(gameId: string, clientMoveId: string): Promise<GameEvent | null> {
    return this.rows.find((e) => e.gameId === gameId && e.clientMoveId === clientMoveId)
  }

  async lastSeq(gameId: string): Promise<number> {
    return this.rows
      .all()
      .filter((e) => e.gameId === gameId)
      .reduce((max, e) => Math.max(max, e.seq), 0)
  }

  async countByGame(gameId: string): Promise<number> {
    return this.rows.all().filter((e) => e.gameId === gameId).length
  }

  async reattributeActor(guestSessionId: string, userId: string): Promise<number> {
    const mine = this.rows.all().filter((e) => e.actorGuestId === guestSessionId)
    for (const event of mine) {
      this.rows.patch(event.id, { actorUserId: userId, actorGuestId: null })
    }
    return mine.length
  }
}

export class InMemoryGameSnapshotRepository implements IGameSnapshotRepository {
  readonly rows = new Collection<GameSnapshot>('GameSnapshot')

  async save(snapshot: NewGameSnapshot): Promise<GameSnapshot> {
    const existing = this.rows
      .all()
      .find((s) => s.gameId === snapshot.gameId && s.seq === snapshot.seq)
    if (existing) return this.rows.patch(existing.id, { state: snapshot.state })

    return this.rows.insert({ id: nextId('snp'), ...snapshot, createdAt: new Date() })
  }

  async findById(id: string): Promise<GameSnapshot | null> {
    return this.rows.get(id)
  }

  async findLatest(
    gameId: string,
    atOrBeforeSeq = Number.MAX_SAFE_INTEGER,
  ): Promise<GameSnapshot | null> {
    const candidates = this.rows
      .all()
      .filter((s) => s.gameId === gameId && s.seq <= atOrBeforeSeq)
      .sort((a, b) => b.seq - a.seq)
    return candidates[0] ? clone(candidates[0]) : null
  }

  async deleteOlderThan(gameId: string, seq: number): Promise<number> {
    const stale = this.rows.all().filter((s) => s.gameId === gameId && s.seq < seq)
    for (const row of stale) this.rows.remove(row.id)
    return stale.length
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

export class InMemoryStatsRepository implements IStatsRepository {
  readonly rows = new Collection<PlayerStats>('PlayerStats')

  async findByUserAndGame(userId: string, gameSlug: string): Promise<PlayerStats | null> {
    return this.rows.find((s) => s.userId === userId && s.gameSlug === gameSlug)
  }

  async listByUser(userId: string): Promise<PlayerStats[]> {
    return this.rows.filter((s) => s.userId === userId)
  }

  async upsert(userId: string, gameSlug: string, patch: StatsPatch): Promise<PlayerStats> {
    const existing = this.rows.all().find((s) => s.userId === userId && s.gameSlug === gameSlug)
    if (existing) return this.rows.patch(existing.id, { ...patch, updatedAt: new Date() })

    return this.rows.insert({
      id: nextId('sta'),
      userId,
      gameSlug,
      played: 0,
      won: 0,
      lost: 0,
      drawn: 0,
      forfeited: 0,
      currentStreak: 0,
      bestStreak: 0,
      totalMs: 0,
      extra: null,
      ...patch,
      updatedAt: new Date(),
    })
  }

  async increment(userId: string, gameSlug: string, deltas: StatsPatch): Promise<PlayerStats> {
    const current =
      (await this.findByUserAndGame(userId, gameSlug)) ?? (await this.upsert(userId, gameSlug, {}))
    const patch: Record<string, unknown> = {}
    for (const key of NUMERIC_STAT_KEYS) {
      const delta = deltas[key]
      if (typeof delta === 'number') patch[key] = current[key] + delta
    }
    if (deltas.extra !== undefined) patch.extra = deltas.extra
    return this.upsert(userId, gameSlug, patch)
  }
}
