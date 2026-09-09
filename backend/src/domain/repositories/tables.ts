import type {
  ChatMessage,
  Invite,
  Table,
  TableMember,
  TableWithMembers,
} from '../entities/table.js'
import type { IdentityRef, OccupantRef } from '../value-objects/identity.js'
import type { SeatId } from '../value-objects/seat.js'
import type { Draft, IRepository, PageQuery } from './IRepository.js'

export type NewTable = Draft<
  Table,
  | 'hostUserId'
  | 'status'
  | 'origin'
  | 'presetId'
  | 'rewardEligible'
  | 'allowSpectators'
  | 'requireApproval'
  | 'startedAt'
  | 'closedAt'
>

export interface ITableRepository extends IRepository<Table> {
  create(data: NewTable): Promise<Table>
  /** Resolves a live invite to its table. Revoked and expired codes miss. */
  findByInviteCode(code: string, now?: Date): Promise<Table | null>
  findWithMembers(id: string): Promise<TableWithMembers | null>
  findOpenTablesForUser(userId: string): Promise<Table[]>

  /**
   * ★ The seat race, settled by the database.
   *
   * Inserts a `TableMember` and lets the `(tableId, seat)` unique constraint
   * arbitrate. Returns **null** when the seat was already taken — a normal
   * outcome of two friends clicking at once, not an exception. There is no
   * `SELECT` first: a check-then-insert is wrong under concurrency (03 §6.3),
   * and the contract suite proves this implementation is not.
   *
   * `team` is written in the *same* insert rather than by a follow-up update:
   * for a partnership game the team is part of who you are at that table, and a
   * second write could fail and leave a seated player on no team.
   */
  claimSeat(
    tableId: string,
    seat: SeatId,
    occupant: OccupantRef,
    team?: number | null,
  ): Promise<TableMember | null>
  releaseSeat(tableId: string, seat: SeatId): Promise<void>

  /** Spectators carry `seat: null`, so any number of them coexist. */
  addSpectator(tableId: string, occupant: OccupantRef): Promise<TableMember>

  listMembers(tableId: string): Promise<TableMember[]>
  findMemberBySeat(tableId: string, seat: SeatId): Promise<TableMember | null>
  findMemberByIdentity(tableId: string, identity: IdentityRef): Promise<TableMember | null>
  updateMember(memberId: string, data: Partial<TableMember>): Promise<TableMember>
  /** Members who have not left. Drives auto-start and the close-empty-table sweep. */
  countActiveMembers(tableId: string): Promise<number>

  /** Claim transaction (03 §7): the guest's seat becomes the new user's seat. */
  transferSeat(guestSessionId: string, userId: string): Promise<TableMember | null>
}

export type NewInvite = Draft<Invite, 'maxUses' | 'useCount' | 'revokedAt'>

export interface IInviteRepository extends IRepository<Invite> {
  create(data: NewInvite): Promise<Invite>
  /** The raw row, whatever its state — for "why doesn't my link work?". */
  findByCode(code: string): Promise<Invite | null>
  /** Only a usable invite: not revoked, not expired, uses remaining. */
  findValidByCode(code: string, now?: Date): Promise<Invite | null>
  listByTable(tableId: string): Promise<Invite[]>
  revoke(id: string, at: Date): Promise<Invite>
  /**
   * Consumes one use. Returns null when `maxUses` is already exhausted, so the
   * caller cannot oversubscribe a link by racing it.
   */
  consumeUse(id: string): Promise<Invite | null>
}

export type NewChatMessage = Draft<
  ChatMessage,
  'userId' | 'guestSessionId' | 'kind' | 'params' | 'redactedAt'
>

/** Append-and-redact. A message is never hard-deleted — `redactedAt` is the tombstone. */
export interface IChatRepository {
  append(message: NewChatMessage): Promise<ChatMessage>
  findById(id: string): Promise<ChatMessage | null>
  /** Newest first, so a client can page backwards from the live tail. */
  listByTable(tableId: string, page?: PageQuery): Promise<ChatMessage[]>
  redact(id: string, at: Date): Promise<ChatMessage>
  /**
   * Claim transaction (03 §6.1 step 7): the guest's messages become the new
   * user's messages. Returns the number of rows rewritten.
   *
   * Without this, the transcript of the hand a player just joined would keep
   * addressing a guest session that no longer exists — and moderation (12 §6)
   * would have no way to attribute what was said to the account that said it.
   */
  reattributeActor(guestSessionId: string, userId: string): Promise<number>
}
