import type {
  BotDifficulty,
  ChatMessageKind,
  EjectionReason,
  MemberRole,
  TableOrigin,
  TableStatus,
} from '../../contracts/enums.js'
import type { SeatId } from '../value-objects/seat.js'

export interface Table {
  readonly id: string
  /** Null for matchmade tables — nobody hosts them. */
  readonly hostUserId: string | null
  readonly gameSlug: string
  readonly status: TableStatus
  readonly origin: TableOrigin
  readonly presetId: string | null
  /** Set at formation by the farming guard. False ⇒ matches here earn nothing. */
  readonly rewardEligible: boolean
  /** Validated against `GameEngine.meta.optionsSchema` before it gets here. */
  readonly options: Record<string, unknown>
  readonly seatCount: number
  readonly allowSpectators: boolean
  readonly requireApproval: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly startedAt: Date | null
  readonly closedAt: Date | null
}

/**
 * One row per occupant. Exactly one of `userId` / `guestSessionId` is set for a
 * human; both are null when `isBot`. Spectators have `seat: null`, which is
 * also what lets several of them coexist under the `(tableId, seat)` unique
 * constraint — NULLs stay distinct on both SQLite and Postgres.
 */
export interface TableMember {
  readonly id: string
  readonly tableId: string
  readonly userId: string | null
  readonly guestSessionId: string | null
  readonly isBot: boolean
  readonly botDifficulty: BotDifficulty | null
  readonly seat: SeatId | null
  readonly role: MemberRole
  /** Partnership games: Shelem is `seat % 2`. */
  readonly team: number | null
  readonly joinedAt: Date
  readonly leftAt: Date | null
  /** The DISCONNECT grace timer (04 §5) is measured from here. */
  readonly disconnectedAt: Date | null

  // ── Turn enforcement and ejection (04 §6) ──
  readonly timeoutStrikes: number
  readonly ejectedAt: Date | null
  readonly ejectionReason: EjectionReason | null
  /** Until when `game:reclaimSeat` is accepted. Null ⇒ not reclaimable. */
  readonly reclaimableUntil: Date | null
  readonly botSubstituted: boolean
}

export interface TableWithMembers extends Table {
  readonly members: readonly TableMember[]
}

export interface Invite {
  readonly id: string
  readonly tableId: string
  /** Short, URL-safe, ~8 chars. The only thing standing between a link and a seat. */
  readonly code: string
  readonly createdByUserId: string
  /** Null = unlimited within seat capacity. */
  readonly maxUses: number | null
  readonly useCount: number
  readonly expiresAt: Date
  readonly revokedAt: Date | null
  readonly createdAt: Date
}

export interface ChatMessage {
  readonly id: string
  readonly tableId: string
  readonly userId: string | null
  readonly guestSessionId: string | null
  readonly kind: ChatMessageKind
  /** Text, emote id, or — for SYSTEM — an i18n key. Never English prose. */
  readonly body: string
  readonly params: Record<string, unknown> | null
  readonly createdAt: Date
  readonly redactedAt: Date | null
}
