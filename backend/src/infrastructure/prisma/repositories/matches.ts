import type { MatchParticipant, MatchResult } from '../../../domain/entities/game.js'
import type {
  IMatchParticipantRepository,
  IMatchResultRepository,
  NewMatchParticipant,
  NewMatchResult,
} from '../../../domain/repositories/matches.js'
import type { HolderKey, IdentityRef } from '../../../domain/value-objects/identity.js'
import { toJson, toMatchParticipant, toMatchResult } from '../mappers.js'
import { PrismaRepositoryBase } from './base.js'

/** The settled record of a finished game — 03 §3.5, written by S36. */
export class PrismaMatchResultRepository
  extends PrismaRepositoryBase
  implements IMatchResultRepository
{
  async create(data: NewMatchResult): Promise<MatchResult> {
    const { summary, ...rest } = data
    const row = await this.db.matchResult.create({
      data: { ...rest, summaryJson: toJson(summary) },
    })
    return toMatchResult(row)
  }

  async findById(id: string): Promise<MatchResult | null> {
    const row = await this.db.matchResult.findUnique({ where: { id } })
    return row === null ? null : toMatchResult(row)
  }

  async findByGame(gameId: string): Promise<MatchResult | null> {
    const row = await this.db.matchResult.findUnique({ where: { gameId } })
    return row === null ? null : toMatchResult(row)
  }

  /**
   * ★ 10 §3.5 — the repeat-decay lookup, scoped to *one player's* recent play.
   *
   * The `where` names this holder, so the result set is a handful of rows even
   * on a busy platform: a person can finish only so many matches in thirty
   * minutes. Asking the question from the other end — "every match on the
   * platform since `since`" — would have needed a signature column and an
   * index, and would have grown with the whole user base to answer a question
   * about four people.
   *
   * Bots are filtered on both sides: out of the `where` because a bot has no
   * identity to be "this holder", and out of the `include` because a matchup is
   * a set of *people*.
   */
  async listRecentHolderSetsFor(
    holder: IdentityRef,
    since: Date,
  ): Promise<readonly (readonly HolderKey[])[]> {
    const mine =
      holder.kind === 'user' ? { userId: holder.userId } : { guestSessionId: holder.guestSessionId }

    const rows = await this.db.matchParticipant.findMany({
      where: { ...mine, isBot: false, matchResult: { finishedAt: { gte: since } } },
      select: {
        matchResult: {
          select: {
            participants: {
              where: { isBot: false },
              select: { userId: true, guestSessionId: true },
            },
          },
        },
      },
    })

    return rows.map((row) =>
      row.matchResult.participants.flatMap((participant): HolderKey[] => {
        if (participant.userId !== null) return [`user:${participant.userId}`]
        if (participant.guestSessionId !== null) return [`guest:${participant.guestSessionId}`]
        return []
      }),
    )
  }
}

/**
 * `MatchParticipant` — one row per seat, created by settlement and
 * re-attributed by the guest→user claim (03 §6.1 step 7).
 */
export class PrismaMatchParticipantRepository
  extends PrismaRepositoryBase
  implements IMatchParticipantRepository
{
  async create(data: NewMatchParticipant): Promise<MatchParticipant> {
    const row = await this.db.matchParticipant.create({ data })
    return toMatchParticipant(row)
  }

  async listByMatch(matchResultId: string): Promise<MatchParticipant[]> {
    const rows = await this.db.matchParticipant.findMany({
      where: { matchResultId },
      orderBy: { seat: 'asc' },
    })
    return rows.map(toMatchParticipant)
  }

  async reattributeActor(guestSessionId: string, userId: string): Promise<number> {
    const { count } = await this.db.matchParticipant.updateMany({
      where: { guestSessionId },
      data: { userId, guestSessionId: null },
    })
    return count
  }

  async countByGuest(guestSessionId: string): Promise<number> {
    return this.db.matchParticipant.count({ where: { guestSessionId } })
  }

  async countByUser(userId: string): Promise<number> {
    return this.db.matchParticipant.count({ where: { userId } })
  }
}
