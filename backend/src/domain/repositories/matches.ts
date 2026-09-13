import type { MatchParticipant, MatchResult } from '../entities/game.js'
import type { HolderKey, IdentityRef } from '../value-objects/identity.js'
import type { Draft } from './IRepository.js'

export type NewMatchResult = Draft<MatchResult, 'finishedAt'>

/**
 * Everything about a seat's reward is decided *before* the row is written, so
 * there is no update path: `coinsAwarded` and `rewardTxId` are known by the
 * time the participant is created, because the ledger row is appended first and
 * its key is `match:{matchResultId}:{seat}` — derived from the result, never
 * from the participant. One insert per seat, no create-then-patch window in
 * which a participant exists with an unsettled reward.
 */
export type NewMatchParticipant = Draft<
  MatchParticipant,
  | 'isBot'
  | 'team'
  | 'outcome'
  | 'forfeited'
  | 'coinsAwarded'
  | 'rewardForfeited'
  | 'rewardTxId'
  | 'playedFraction'
>

/**
 * The settled record of a finished game — 03 §3.5, written by S36.
 *
 * Deliberately **not** an `IRepository`: a match result has no update path and
 * no delete path, for the same reason the event log has none. It is what the
 * ledger rows point at and what the player's history is read from; a result
 * that could be rewritten after it paid somebody is not a record of anything.
 */
export interface IMatchResultRepository {
  /**
   * ★ `gameId` is unique, and a duplicate insert **throws** rather than
   * returning the existing row.
   *
   * That is the match-level half of E2: the per-seat idempotency key stops a
   * replayed settlement from paying twice, and this stops it from writing a
   * second set of participants and stats alongside the first. The caller
   * (`SettlementService`) checks {@link findByGame} first and treats the throw
   * as the lost half of a race, not as an error worth surfacing.
   */
  create(data: NewMatchResult): Promise<MatchResult>
  findById(id: string): Promise<MatchResult | null>
  findByGame(gameId: string): Promise<MatchResult | null>

  /**
   * ★ §3.5's repeat decay, as a question the database can answer.
   *
   * Returns, for every match this holder finished since `since`, the set of
   * **human** holder keys that played in it. The caller compares those sets
   * against the group being settled and counts the identical ones.
   *
   * Bounded by one player's own play in a 30-minute window — a handful of rows
   * — rather than by every match on the platform, which is why the lookup needs
   * no signature column and no new index. Bots are excluded because a bot is
   * not an identity: three friends plus a bot meeting three friends plus a
   * *different* bot is the same matchup, and §3.5 is about people.
   */
  listRecentHolderSetsFor(
    holder: IdentityRef,
    since: Date,
  ): Promise<readonly (readonly HolderKey[])[]>
}

/**
 * `MatchParticipant` — one row per seat of a finished match.
 *
 * Created by settlement (S36); re-attributed by the guest→user claim (03 §6.1
 * step 7), which is why this interface existed, deliberately narrow, from S22:
 * a match played as a guest counts toward the new account's history, or signing
 * up silently costs the player the evening they just spent.
 */
export interface IMatchParticipantRepository {
  create(data: NewMatchParticipant): Promise<MatchParticipant>
  listByMatch(matchResultId: string): Promise<MatchParticipant[]>

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
