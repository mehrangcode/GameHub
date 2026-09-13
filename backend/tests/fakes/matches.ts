import type { MatchParticipant, MatchResult } from '../../src/domain/entities/game.js'
import type {
  IMatchParticipantRepository,
  IMatchResultRepository,
  NewMatchParticipant,
  NewMatchResult,
} from '../../src/domain/repositories/matches.js'
import type { HolderKey, IdentityRef } from '../../src/domain/value-objects/identity.js'
import { Collection, nextId } from './store.js'

/**
 * The in-memory `MatchResult` store.
 *
 * `create` throws on a duplicate `gameId` exactly as the unique constraint
 * does, because settlement *depends* on that throw: it is the match-level half
 * of idempotency, and a fake that quietly accepted a second result would let a
 * double-settlement bug pass every unit test and fail only against the
 * database.
 */
export class InMemoryMatchResultRepository implements IMatchResultRepository {
  readonly rows = new Collection<MatchResult>('MatchResult')
  participants?: InMemoryMatchParticipantRepository

  async create(data: NewMatchResult): Promise<MatchResult> {
    if (await this.findByGame(data.gameId)) {
      throw new Error(`Unique constraint failed on MatchResult.gameId (${data.gameId})`)
    }
    return this.rows.insert({
      id: nextId('mr'),
      finishedAt: new Date(),
      ...data,
    })
  }

  async findById(id: string): Promise<MatchResult | null> {
    return this.rows.get(id)
  }

  async findByGame(gameId: string): Promise<MatchResult | null> {
    return this.rows.find((row) => row.gameId === gameId)
  }

  async listRecentHolderSetsFor(
    holder: IdentityRef,
    since: Date,
  ): Promise<readonly (readonly HolderKey[])[]> {
    const all = this.participants?.rows.all() ?? []

    const mine = all.filter(
      (participant) =>
        !participant.isBot &&
        (holder.kind === 'user'
          ? participant.userId === holder.userId
          : participant.guestSessionId === holder.guestSessionId),
    )

    const matchIds = new Set(
      mine
        .map((participant) => this.rows.peek(participant.matchResultId))
        .filter((match) => match !== undefined && match.finishedAt >= since)
        .map((match) => match!.id),
    )

    return [...matchIds].map((matchId) =>
      all
        .filter((participant) => participant.matchResultId === matchId && !participant.isBot)
        .flatMap((participant): HolderKey[] => {
          if (participant.userId !== null) return [`user:${participant.userId}`]
          if (participant.guestSessionId !== null) return [`guest:${participant.guestSessionId}`]
          return []
        }),
    )
  }
}

export class InMemoryMatchParticipantRepository implements IMatchParticipantRepository {
  readonly rows = new Collection<MatchParticipant>('MatchParticipant')

  async create(data: NewMatchParticipant): Promise<MatchParticipant> {
    return this.rows.insert({
      id: nextId('mp'),
      isBot: false,
      team: null,
      outcome: 'COMPLETED',
      forfeited: false,
      coinsAwarded: 0,
      rewardForfeited: false,
      rewardTxId: null,
      playedFraction: 1,
      ...data,
    })
  }

  async listByMatch(matchResultId: string): Promise<MatchParticipant[]> {
    return this.rows
      .all()
      .filter((row) => row.matchResultId === matchResultId)
      .sort((a, b) => a.seat - b.seat)
  }

  async reattributeActor(guestSessionId: string, userId: string): Promise<number> {
    const mine = this.rows.all().filter((p) => p.guestSessionId === guestSessionId)
    for (const row of mine) {
      this.rows.patch(row.id, { userId, guestSessionId: null })
    }
    return mine.length
  }

  async countByGuest(guestSessionId: string): Promise<number> {
    return this.rows.all().filter((p) => p.guestSessionId === guestSessionId).length
  }

  async countByUser(userId: string): Promise<number> {
    return this.rows.all().filter((p) => p.userId === userId).length
  }
}
