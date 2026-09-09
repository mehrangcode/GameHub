import type { IMatchParticipantRepository } from '../../src/domain/repositories/matches.js'
import { Collection } from './store.js'

/**
 * The in-memory `MatchParticipant` store.
 *
 * There is no `create` on the interface yet (S36 owns settlement), so rows are
 * seeded by a test writing to `rows` directly. That asymmetry is honest: the
 * only production code that touches participants at M0-S22 is the claim's
 * re-attribution, and inventing a create method the interface does not need
 * would be inventing S36's design four sessions early.
 */
export interface FakeParticipant {
  readonly id: string
  readonly matchResultId: string
  userId: string | null
  guestSessionId: string | null
  readonly seat: number
}

export class InMemoryMatchParticipantRepository implements IMatchParticipantRepository {
  readonly rows = new Collection<FakeParticipant>('MatchParticipant')

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
