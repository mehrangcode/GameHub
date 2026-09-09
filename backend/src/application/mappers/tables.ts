import type { PresenceState } from '../../contracts/dto/presence.js'
import type {
  MemberView,
  OccupantView,
  SeatView,
  TableDetail,
  TableSummary,
} from '../../contracts/dto/tables.js'
import type { Table, TableMember } from '../../domain/entities/table.js'
import type { IdentityRef } from '../../domain/value-objects/identity.js'
import { seatRange, type SeatId } from '../../domain/value-objects/seat.js'

/**
 * Table entities → the wire (S18).
 *
 * The seat map is built from `seatRange(table.seatCount)` rather than from the
 * member rows, so the response always has exactly `seatCount` entries and an
 * empty seat is a first-class `{ occupant: null }` rather than a gap the client
 * has to infer. That is what the "sit here" button binds to.
 *
 * Display names arrive through {@link OccupantDirectory} — resolved once, in a
 * batch, by the caller. Passing a directory rather than a repository keeps
 * these functions pure and makes the N+1 impossible to write.
 */

export interface OccupantProfile {
  readonly displayName: string
  readonly avatarRef: string | null
}

export interface OccupantDirectory {
  readonly users: ReadonlyMap<string, OccupantProfile>
  readonly guests: ReadonlyMap<string, OccupantProfile>
}

export const EMPTY_DIRECTORY: OccupantDirectory = { users: new Map(), guests: new Map() }

/** Every id a seat map needs to render, deduplicated, ready for one batch read. */
export function occupantIdsOf(members: readonly TableMember[]): {
  userIds: string[]
  guestSessionIds: string[]
} {
  const userIds = new Set<string>()
  const guestSessionIds = new Set<string>()

  for (const member of members) {
    if (member.userId !== null) userIds.add(member.userId)
    if (member.guestSessionId !== null) guestSessionIds.add(member.guestSessionId)
  }

  return { userIds: [...userIds], guestSessionIds: [...guestSessionIds] }
}

/** Members still at the table. A row with `leftAt` set is history, not a seat. */
export function activeMembers(members: readonly TableMember[]): TableMember[] {
  return members.filter((member) => member.leftAt === null)
}

export function isSameOccupant(member: TableMember, viewer: IdentityRef | null): boolean {
  if (viewer === null) return false
  return viewer.kind === 'user'
    ? member.userId === viewer.userId
    : member.guestSessionId === viewer.guestSessionId
}

function toOccupantView(member: TableMember, directory: OccupantDirectory): OccupantView {
  if (member.isBot) {
    return {
      kind: 'bot',
      displayName: null,
      avatarRef: null,
      botDifficulty: member.botDifficulty,
    }
  }

  const profile =
    member.userId !== null
      ? directory.users.get(member.userId)
      : member.guestSessionId !== null
        ? directory.guests.get(member.guestSessionId)
        : undefined

  return {
    kind: member.userId !== null ? 'user' : 'guest',
    // A missing profile means the account was deleted or the guest session was
    // swept while the row lingered. The seat still has to render, so it renders
    // as an unnamed occupant rather than throwing on a read path.
    displayName: profile?.displayName ?? null,
    avatarRef: profile?.avatarRef ?? null,
    botDifficulty: null,
  }
}

const EMPTY_SEAT = (seat: SeatId): SeatView => ({
  seat,
  memberId: null,
  occupant: null,
  team: null,
  role: 'PLAYER',
  isSelf: false,
  joinedAt: null,
  botSubstituted: false,
})

export function toSeatViews(
  table: Table,
  members: readonly TableMember[],
  directory: OccupantDirectory,
  viewer: IdentityRef | null,
): SeatView[] {
  const bySeat = new Map<number, TableMember>()
  for (const member of activeMembers(members)) {
    if (member.seat !== null) bySeat.set(member.seat, member)
  }

  return seatRange(table.seatCount).map((seat) => {
    const member = bySeat.get(seat)
    if (!member) return EMPTY_SEAT(seat)

    return {
      seat,
      memberId: member.id,
      occupant: toOccupantView(member, directory),
      team: member.team,
      role: member.role,
      isSelf: isSameOccupant(member, viewer),
      joinedAt: member.joinedAt.toISOString(),
      botSubstituted: member.botSubstituted,
    }
  })
}

/**
 * The per-person view (S24), as distinct from the per-seat one above.
 *
 * `table:snapshot` carries both, and they answer different questions.
 * `seats[]` is what the "sit here" buttons bind to, so it is always exactly
 * `seatCount` long and an empty seat is a first-class entry. `members[]` is who
 * is actually present — which is the only one of the two that can carry the
 * **spectators**, who hold no seat and would otherwise appear nowhere but a
 * count.
 *
 * `presence` is looked up rather than stored on the row on purpose: it is
 * derived from live sockets, it is cheap to lose, and it is recomputed on
 * restart (02 §3.2). The one piece that *is* persisted is `disconnectedAt`,
 * because the grace deadline has to survive an API restart without gifting
 * anyone extra time (04 §5.4).
 */
export interface PresenceLookup {
  (member: TableMember): { state: PresenceState; graceEndsAt: string | null }
}

/** Everyone is online until something says otherwise — the safe default. */
export const ASSUME_ONLINE: PresenceLookup = () => ({ state: 'online', graceEndsAt: null })

export function toMemberViews(
  members: readonly TableMember[],
  directory: OccupantDirectory,
  viewer: IdentityRef | null,
  presence: PresenceLookup = ASSUME_ONLINE,
): MemberView[] {
  return activeMembers(members).map((member) => {
    const { state, graceEndsAt } = presence(member)

    return {
      memberId: member.id,
      seat: member.seat,
      role: member.role,
      team: member.team,
      occupant: toOccupantView(member, directory),
      isSelf: isSameOccupant(member, viewer),
      joinedAt: member.joinedAt.toISOString(),
      botSubstituted: member.botSubstituted,
      // A bot is never "reconnecting": it has no transport to lose, and showing
      // one as away would make the substitution look broken.
      presence: member.isBot ? 'online' : state,
      graceEndsAt: member.isBot ? null : graceEndsAt,
    }
  })
}

/**
 * `user:<id>` / `guest:<id>` → member, for the chat mapper's seat lookup.
 * Bots are excluded: they have no actor key and never author a message.
 */
export function membersByActor(members: readonly TableMember[]): Map<string, TableMember> {
  const index = new Map<string, TableMember>()

  for (const member of members) {
    if (member.userId !== null) index.set(`user:${member.userId}`, member)
    else if (member.guestSessionId !== null) index.set(`guest:${member.guestSessionId}`, member)
  }

  return index
}

export function toTableSummary(
  table: Table,
  members: readonly TableMember[],
  viewer: IdentityRef | null,
): TableSummary {
  const active = activeMembers(members)
  const mine = active.find((member) => isSameOccupant(member, viewer))

  return {
    id: table.id,
    gameSlug: table.gameSlug,
    status: table.status,
    origin: table.origin,
    seatCount: table.seatCount,
    seatsTaken: active.filter((member) => member.seat !== null).length,
    isHost: viewer?.kind === 'user' && table.hostUserId === viewer.userId,
    mySeat: mine?.seat ?? null,
    rewardEligible: table.rewardEligible,
    createdAt: table.createdAt.toISOString(),
    updatedAt: table.updatedAt.toISOString(),
    startedAt: table.startedAt?.toISOString() ?? null,
  }
}

export function toTableDetail(
  table: Table,
  members: readonly TableMember[],
  directory: OccupantDirectory,
  viewer: IdentityRef | null,
): TableDetail {
  const active = activeMembers(members)

  return {
    ...toTableSummary(table, members, viewer),
    hostDisplayName:
      table.hostUserId === null
        ? null
        : (directory.users.get(table.hostUserId)?.displayName ?? null),
    options: table.options,
    allowSpectators: table.allowSpectators,
    requireApproval: table.requireApproval,
    seats: toSeatViews(table, members, directory, viewer),
    spectatorCount: active.filter((member) => member.seat === null).length,
  }
}
