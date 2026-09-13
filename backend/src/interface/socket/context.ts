import type { Logger } from 'pino'
import type { Socket } from 'socket.io'
import { toMemberViews } from '../../application/mappers/tables.js'
import { holderRoom, seatRoom, spectatorRoom, tableRoom } from '../../application/ports/realtime.js'
import type { Container } from '../../container.js'
import type { Identity } from '../../contracts/dto/auth.js'
import type { MemberView } from '../../contracts/dto/tables.js'
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
  TableSnapshotPayload,
  YouView,
} from '../../contracts/events.js'
import type { Table, TableMember } from '../../domain/entities/table.js'
import { ForbiddenError } from '../../domain/errors/errors.js'
import type { IdentityRef } from '../../domain/value-objects/identity.js'
import { seatRange } from '../../domain/value-objects/seat.js'
import { identityRefOf } from '../http/middleware/authorize.js'

export type GatewaySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

/**
 * The per-socket, per-event plumbing every handler needs — S24.
 *
 * Everything in here answers one of three questions, and all three have
 * exactly one right answer that no handler is allowed to re-derive:
 *
 *   - **Who is asking?** `identity`, resolved once at handshake and frozen.
 *   - **Are they allowed near this table?** `atTable`, which is the socket's
 *     equivalent of the `enforceGuestBinding` middleware plus a join check.
 *   - **What can they see?** `snapshot`, which is the one place a lobby view is
 *     assembled, so every path that shows a table shows the same table.
 */
export interface SocketContext {
  readonly container: Container
  readonly socket: GatewaySocket
  readonly identity: Identity
  readonly ref: IdentityRef
  readonly logger: Logger
}

export function socketContext(container: Container, socket: GatewaySocket): SocketContext {
  const identity = socket.data.identity

  return {
    container,
    socket,
    identity,
    ref: identityRefOf(identity),
    logger: container.logger.child({ socketId: socket.id }),
  }
}

/** Who is asking, and what they may do beyond their own seat. */
export interface SeatActor {
  readonly identity: IdentityRef
  readonly isHost: boolean
}

export async function actorFor(context: SocketContext, table: Table): Promise<SeatActor> {
  return {
    identity: context.ref,
    // Derived from the table row, never from the request — the same derivation
    // `requireHost` makes for the REST routes. A matchmade table has
    // `hostUserId: null`, so nobody is its host and every host-only event on it
    // is refused, which is correct (09 §2).
    isHost: context.ref.kind === 'user' && table.hostUserId === context.ref.userId,
  }
}

export function assertHost(actor: SeatActor): void {
  if (actor.isHost) return
  throw new ForbiddenError('Only the host may do this', { reason: 'HOST_REQUIRED' })
}

/**
 * ★ The two checks that gate every table-scoped event.
 *
 * **The guest binding** is the socket's copy of `enforceGuestBinding` (07 §3):
 * a guest touching any table but the one its token names is a 403 *and* an
 * `ALERT` audit row, because that is not a mistake to tolerate — it is the
 * shape of a privilege-escalation attempt. The check lives here, in one
 * function every handler calls, for the same reason the middleware exists: a
 * rule that must be remembered per handler is a rule that will be forgotten on
 * one.
 *
 * **The join check** is subtler and worth stating. A socket may only act on a
 * table it has joined. Not because joining is authorisation — it is not, and
 * anyone holding the table id may join — but because acting on a room you are
 * not in produces broadcasts you never see, and the resulting "it worked but
 * nothing happened" is indistinguishable from a bug.
 */
export function atTable(context: SocketContext, tableId: string): void {
  if (context.identity.kind === 'guest') {
    context.container.guests.assertBoundTo(context.identity, tableId, {
      ip: context.socket.data.ip,
      userAgent: context.socket.data.userAgent,
    })
  }

  if (!context.socket.data.tables.has(tableId)) {
    throw new ForbiddenError('Join the table before acting on it', { reason: 'NOT_AT_TABLE' })
  }
}

// ── Rooms ────────────────────────────────────────────────────────────────────

/**
 * Puts the socket in exactly the rooms its current standing entitles it to.
 *
 * Called on join and again after every seat change, and it is deliberately
 * *declarative* — it computes the correct set and moves the socket to it,
 * rather than adding a room here and removing one there. Incremental room
 * juggling is how a player who moved from seat 1 to seat 2 ends up still
 * receiving seat 1's private projection, and that bug would be invisible until
 * Phase G puts cards in those payloads.
 */
export async function syncRooms(
  context: SocketContext,
  table: Table,
  member: TableMember | null,
): Promise<void> {
  const { socket } = context
  const wanted = new Set<string>([tableRoom(table.id)])

  if (member !== null && member.leftAt === null && member.seat !== null) {
    wanted.add(seatRoom(table.id, member.seat))
  } else if (table.allowSpectators) {
    // Watchers only reach the spectator projection when the table allows
    // spectators at all. A table with them switched off still lets a
    // link-holder see the lobby — that is what `GET /tables/:id` already does —
    // but it never routes them a game view.
    wanted.add(spectatorRoom(table.id))
  }

  // ★ Both kinds, since S37: a guest's provisional balance is the signup pitch
  // and has to be able to arrive live. `holderRoom` is the holder key, so this
  // is the same room `wallet:updated` is addressed to (10 §3.4, §10).
  wanted.add(holderRoom(context.ref))

  // Leave only rooms belonging to *this* table, named exactly. A tab watching
  // two tables must not be evicted from the other one, and `user:{id}` is not
  // table-scoped at all. Matching by substring would work today (ids are
  // fixed-length cuids) and would be a latent bug the day they are not.
  for (const room of roomsOfTable(table)) {
    if (!wanted.has(room) && socket.rooms.has(room)) await socket.leave(room)
  }

  for (const room of wanted) {
    if (!socket.rooms.has(room)) await socket.join(room)
  }
}

/** Every room name one table can produce. The exact set `syncRooms` reasons over. */
export function roomsOfTable(table: Table): string[] {
  return [
    tableRoom(table.id),
    spectatorRoom(table.id),
    ...seatRange(table.seatCount).map((seat) => seatRoom(table.id, seat)),
  ]
}

/** Removes the socket from every room belonging to one table. */
export async function leaveTableRooms(socket: GatewaySocket, table: Table): Promise<void> {
  for (const room of roomsOfTable(table)) {
    if (socket.rooms.has(room)) await socket.leave(room)
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

export async function membersOf(
  context: SocketContext,
  table: Table,
): Promise<{ members: TableMember[]; views: MemberView[] }> {
  const { container } = context
  const members = await container.repos.tables.listMembers(table.id)
  const directory = await container.tables.directory(table, members)

  return {
    members,
    views: toMemberViews(members, directory, context.ref, (member) =>
      container.presence.stateOf(table.id, member),
    ),
  }
}

export function youView(member: TableMember | null, table: Table, ref: IdentityRef): YouView {
  return {
    memberId: member?.id ?? null,
    seat: member?.seat ?? null,
    role: member?.role ?? 'SPECTATOR',
    isHost: ref.kind === 'user' && table.hostUserId === ref.userId,
    isSpectator: member === null || member.seat === null,
  }
}

/**
 * The full lobby state — `table:snapshot`, 04 §3.2.
 *
 * Sent on join, on every reconnect inside grace, and (from S29) whenever the
 * client falls too far behind to reconcile. **`full` is always correct** and is
 * the fallback whenever anything is ambiguous; never guess at reconciliation.
 */
export async function snapshot(
  context: SocketContext,
  table: Table,
): Promise<TableSnapshotPayload> {
  const { container } = context
  const { members, views } = await membersOf(context, table)
  const mine = members.find((member) => holds(member, context.ref) && member.leftAt === null)

  const [detail, chat] = await Promise.all([
    container.tables.detail(table.id, context.ref),
    container.chat.history(table.id, context.ref),
  ])

  return {
    table: detail,
    members: views,
    you: youView(mine ?? null, table, context.ref),
    chat,
    // The client stores `serverTime - Date.now()` and renders every countdown
    // against the offset (04 §9.7). Repeated here as well as in `connected`
    // because a reconnect is exactly when a device's clock may have moved.
    serverTime: Date.now(),
  }
}

export function holds(member: TableMember, ref: IdentityRef): boolean {
  return ref.kind === 'user'
    ? member.userId === ref.userId
    : member.guestSessionId === ref.guestSessionId
}
