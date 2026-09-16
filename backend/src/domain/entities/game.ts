import type {
  GameEventKind,
  GameInstanceStatus,
  MatchReason,
  SeatOutcome,
} from '../../contracts/enums.js'
import type { IdentityRef } from '../value-objects/identity.js'
import type { SeatId } from '../value-objects/seat.js'

/** Who sat where when the deal started, frozen so history survives seat changes. */
export interface SeatAssignment {
  readonly seat: SeatId
  readonly userId: string | null
  readonly guestSessionId: string | null
  readonly isBot: boolean
  readonly displayName: string
  readonly team: number | null
}

/**
 * Who gets paid for this seat, or `null` when nobody does.
 *
 * Lives here rather than in the service that first needed it because "which
 * wallet does seat 2 belong to" is a property of the seating, and two services
 * answering it separately is how they come to disagree. A bot seat has no
 * holder at all — there is nobody to pay and no wallet to pay into.
 */
export function holderOf(assignment: SeatAssignment): IdentityRef | null {
  if (assignment.isBot) return null
  if (assignment.userId !== null) return { kind: 'user', userId: assignment.userId }
  if (assignment.guestSessionId !== null) {
    return { kind: 'guest', guestSessionId: assignment.guestSessionId }
  }
  return null
}

export interface GameInstance {
  readonly id: string
  readonly tableId: string
  readonly gameSlug: string
  readonly status: GameInstanceStatus
  /** Deal seed. Revealed only after the hand ends (05 §3, 07 §4). */
  readonly rngSeed: string
  /** `sha256(seed + id)`, published *before* dealing. */
  readonly seedCommit: string
  readonly seedRevealedAt: Date | null
  /** Monotonic. Every appended event increments it; clients detect gaps with it. */
  readonly seq: number
  readonly seating: readonly SeatAssignment[]
  readonly options: Record<string, unknown>
  readonly startedAt: Date
  readonly finishedAt: Date | null
}

/**
 * P4 — the event log is the source of truth. Append-only: no update path, no
 * delete path. State is rebuilt from snapshot + delta on every move, which is
 * why an API restart loses zero games.
 */
export interface GameEvent {
  readonly id: string
  readonly gameId: string
  /** Position in the log. `(gameId, seq)` is unique — this *is* the ordering. */
  readonly seq: number
  readonly kind: GameEventKind
  readonly seat: SeatId | null
  readonly actorUserId: string | null
  readonly actorGuestId: string | null
  readonly payload: Record<string, unknown>
  /** Client idempotency key; a socket retry must not replay the move. */
  readonly clientMoveId: string | null
  readonly createdAt: Date
}

/** A cache of the state after `seq`. The log remains the truth. */
export interface GameSnapshot {
  readonly id: string
  readonly gameId: string
  readonly seq: number
  readonly state: Record<string, unknown>
  readonly createdAt: Date
}

export interface MatchResult {
  readonly id: string
  readonly gameId: string
  readonly gameSlug: string
  readonly reason: MatchReason
  readonly winningTeam: number | null
  readonly summary: Record<string, unknown>
  readonly durationMs: number
  readonly finishedAt: Date
}

/**
 * Reward eligibility is per **seat**, not per team (10 §5.1). An ejected player
 * on the winning team gets `coinsAwarded: 0` and `rewardForfeited: true` while
 * their partner is paid in full — which is only expressible because the outcome
 * lives on this row rather than on the team.
 */
export interface MatchParticipant {
  readonly id: string
  readonly matchResultId: string
  readonly userId: string | null
  readonly guestSessionId: string | null
  readonly isBot: boolean
  readonly seat: SeatId
  readonly team: number | null
  readonly rank: number
  readonly score: number
  readonly outcome: SeatOutcome
  readonly forfeited: boolean
  readonly coinsAwarded: number
  readonly rewardForfeited: boolean
  readonly rewardTxId: string | null
  /** A ratio, never money — the only Float in the schema. */
  readonly playedFraction: number
}
