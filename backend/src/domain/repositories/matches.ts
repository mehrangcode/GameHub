/**
 * `MatchParticipant`, from the one angle S22 needs it.
 *
 * Match *results* are settled in S36 and this interface will grow the create,
 * read and reward-linking methods then. It exists already, deliberately narrow,
 * because step 7 of the guest→user claim (03 §6.1) has to re-attribute the
 * guest's participations along with their events and chat — a match played as a
 * guest counts toward the new account's history, or the signup silently costs
 * the player the evening they just spent.
 *
 * Writing the one method now rather than reaching into Prisma from the claim
 * service is what keeps `application/` free of `@prisma/client` (guard 1), and
 * what lets the claim transaction be tested against the in-memory fakes.
 */
export interface IMatchParticipantRepository {
  /**
   * Claim transaction (03 §6.1 step 7): `guestSessionId → userId` on every row
   * the guest appears in. Returns how many rows were rewritten.
   *
   * A guest who never finished a match has none, and `0` is an ordinary
   * outcome rather than an error — most claims happen mid-hand, before any
   * `MatchResult` exists at all.
   */
  reattributeActor(guestSessionId: string, userId: string): Promise<number>
  countByGuest(guestSessionId: string): Promise<number>
  countByUser(userId: string): Promise<number>
}
