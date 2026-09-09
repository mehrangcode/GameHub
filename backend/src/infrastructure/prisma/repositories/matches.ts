import type { IMatchParticipantRepository } from '../../../domain/repositories/matches.js'
import { PrismaRepositoryBase } from './base.js'

/**
 * `MatchParticipant` — the sliver S22 needs (03 §6.1 step 7). S36 grows it into
 * the settlement repository.
 */
export class PrismaMatchParticipantRepository
  extends PrismaRepositoryBase
  implements IMatchParticipantRepository
{
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
