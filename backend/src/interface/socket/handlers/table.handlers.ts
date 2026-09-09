import { SYSTEM_MESSAGE_KEYS } from '../../../contracts/dto/chat.js'
import {
  AddBotPayloadSchema,
  KickPayloadSchema,
  ReleaseSeatPayloadSchema,
  RemoveBotPayloadSchema,
  TableJoinPayloadSchema,
  TableLeavePayloadSchema,
  TakeSeatPayloadSchema,
  UpdateOptionsPayloadSchema,
  type SeatChangeResult,
  type TableJoinResult,
} from '../../../contracts/events.js'
import { SEAT_CHANGE_RULE, TABLE_JOIN_RULE } from '../../../config/socketLimits.js'
import { seatRoom, tableRoom } from '../../../application/ports/realtime.js'
import { toSeatViews } from '../../../application/mappers/tables.js'
import type { Table, TableMember } from '../../../domain/entities/table.js'
import { ForbiddenError, NotFoundError, ValidationError } from '../../../domain/errors/errors.js'
import { botRef, type IdentityRef } from '../../../domain/value-objects/identity.js'
import { seatId } from '../../../domain/value-objects/seat.js'
import { handler, type AckContext } from '../ack.js'
import {
  actorFor,
  assertHost,
  atTable,
  holds,
  leaveTableRooms,
  snapshot,
  syncRooms,
  youView,
  type SocketContext,
} from '../context.js'
import { perSocket, spendSocketBudget } from '../rateLimit.js'

/**
 * Table membership and seats over the socket — S24, 04 §3.1.
 *
 * This is where the transport rule from 02 §3.1 becomes real: *if a friend at
 * the table would see it happen live, it goes over the socket.* Seat changes
 * are the first thing that qualifies, and the REST probe routes that stood in
 * for them since S20 are now a second way to do the same thing (they survive
 * only because Newman cannot speak Socket.IO — see the note in
 * `probe.routes.ts`).
 *
 * ### The rule every handler here obeys
 *
 * **`seat` is looked up server-side from `TableMember` by identity + table** —
 * never read from a payload, never inferred from a room the socket happens to
 * be in. `table:takeSeat` and `table:kick` carry a seat *number*, and that is a
 * target, not a claim about who is asking. The claim comes from
 * `socket.data.identity`, which was frozen at handshake.
 *
 * ### Why every mutation re-reads and re-broadcasts
 *
 * Each handler calls the same `TableService` method the REST route calls, then
 * re-reads the member row and broadcasts what actually happened rather than
 * what it asked for. The seat race (S20) is settled by a unique constraint, so
 * "I asked for seat 2" and "I am in seat 2" are genuinely different facts, and
 * broadcasting the request rather than the outcome is how two clients end up
 * rendering the same seat as two different people.
 */

export interface TableHandlerDeps {
  readonly context: SocketContext
  readonly ack: AckContext
}

export function registerTableHandlers({ context, ack }: TableHandlerDeps): void {
  const { socket, container } = context

  // ── table:join ────────────────────────────────────────────────────────────
  socket.on(
    'table:join',
    handler(ack, TableJoinPayloadSchema, async ({ tableId, asSpectator }) => {
      await spendSocketBudget(container, perSocket(socket.id, 'join'), TABLE_JOIN_RULE)

      // The guest binding is checked *before* the join is recorded, so a guest
      // probing another table never appears in its room even momentarily.
      if (context.identity.kind === 'guest') {
        container.guests.assertBoundTo(context.identity, tableId, {
          ip: socket.data.ip,
          userAgent: socket.data.userAgent,
        })
      }

      const table = await container.tables.require(tableId)

      if (asSpectator === true) {
        // Throws `SPECTATORS_NOT_ALLOWED`, and is idempotent for a second join.
        await container.tables.joinAsSpectator(tableId, context.ref, context.ref)
      }

      socket.data.tables.add(tableId)

      const member = await container.repos.tables.findMemberByIdentity(tableId, context.ref)
      const active = member !== null && member.leftAt === null ? member : null

      await syncRooms(context, table, active)

      let announce = false
      if (active !== null) {
        const { firstSocket } = await container.presence.attach(
          tableId,
          context.ref,
          active,
          socket.id,
        )
        // Only the first tab announces an arrival. A second window is the same
        // person walking into the same room, and telling everyone twice is how
        // a lobby fills with "Sara joined" from somebody who never left.
        announce = firstSocket
      }

      const payload = await snapshot(context, table)
      socket.emit('table:snapshot', payload)

      if (announce && active !== null) {
        const view = payload.members.find((candidate) => candidate.memberId === active.id)
        if (view !== undefined) {
          container.realtime.publishExcept(tableRoom(tableId), socket.id, 'table:memberJoined', {
            tableId,
            member: view,
          })
          await container.chat.system(tableId, SYSTEM_MESSAGE_KEYS.memberJoined, {
            name: context.identity.displayName,
          })
        }
      }

      container.metrics.increment('table_joins')
      return { tableId, you: payload.you } satisfies TableJoinResult
    }),
  )

  // ── table:leave ───────────────────────────────────────────────────────────
  socket.on(
    'table:leave',
    handler(ack, TableLeavePayloadSchema, async ({ tableId }) => {
      atTable(context, tableId)
      const table = await container.tables.require(tableId)
      const member = await container.repos.tables.findMemberByIdentity(tableId, context.ref)

      if (member !== null && member.leftAt === null) {
        if (member.seat !== null) {
          // `releaseSeat` is the one that knows the difference that matters:
          // WAITING frees the row, IN_PROGRESS keeps it and stamps
          // `disconnectedAt`, because the seat belongs to the *match* once play
          // has started (04 §5.2).
          await container.tables.releaseSeat(tableId, member.seat, await actorFor(context, table))
        } else {
          await container.repos.tables.updateMember(member.id, { leftAt: new Date() })
        }

        container.realtime.publish(tableRoom(tableId), 'table:memberLeft', {
          tableId,
          memberId: member.id,
          seat: member.seat,
        })
        if (member.seat !== null) await broadcastSeat(context, table, member.seat)
      }

      // `forget`, not `detach`: leaving on purpose is not a disconnect, so
      // there is nothing for the other players to wait out. Starting a grace
      // timer here would show "reconnecting…" for somebody who said goodbye.
      container.presence.forget(tableId, context.ref)
      socket.data.tables.delete(tableId)
      await leaveTableRooms(socket, table)

      return undefined
    }),
  )

  // ── table:takeSeat ────────────────────────────────────────────────────────
  socket.on(
    'table:takeSeat',
    handler(ack, TakeSeatPayloadSchema, async ({ tableId, seat }) => {
      atTable(context, tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'takeSeat'), SEAT_CHANGE_RULE)

      const table = await container.tables.require(tableId)
      const actor = await actorFor(context, table)

      // ★ The occupant is the authenticated caller. There is no field on the
      // payload with which to name anybody else, and no branch here that could
      // read one. Throws `SEAT_TAKEN` when the unique constraint fires — a
      // normal outcome of two friends clicking at once, not an exception.
      await container.tables.claimSeat(tableId, seat, context.ref, actor)

      return afterSeatChange(context, table, seat, SYSTEM_MESSAGE_KEYS.seatTaken, {
        name: context.identity.displayName,
        seat,
      })
    }),
  )

  // ── table:releaseSeat ─────────────────────────────────────────────────────
  socket.on(
    'table:releaseSeat',
    handler(ack, ReleaseSeatPayloadSchema, async ({ tableId }) => {
      atTable(context, tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'releaseSeat'), SEAT_CHANGE_RULE)

      const table = await container.tables.require(tableId)
      const seat = await ownSeat(context, tableId)

      await container.tables.releaseSeat(tableId, seat, await actorFor(context, table))

      return afterSeatChange(context, table, seat, SYSTEM_MESSAGE_KEYS.seatReleased, {
        name: context.identity.displayName,
        seat,
      })
    }),
  )

  // ── table:addBot ──────────────────────────────────────────────────────────
  socket.on(
    'table:addBot',
    handler(ack, AddBotPayloadSchema, async ({ tableId, seat, difficulty }) => {
      atTable(context, tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'addBot'), SEAT_CHANGE_RULE)

      const table = await container.tables.require(tableId)
      const actor = await actorFor(context, table)
      assertHost(actor)

      await container.tables.claimSeat(tableId, seat, botRef(difficulty), actor)

      return afterSeatChange(context, table, seat, SYSTEM_MESSAGE_KEYS.botAdded, {
        seat,
        difficulty,
      })
    }),
  )

  // ── table:removeBot ───────────────────────────────────────────────────────
  socket.on(
    'table:removeBot',
    handler(ack, RemoveBotPayloadSchema, async ({ tableId, seat }) => {
      atTable(context, tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'removeBot'), SEAT_CHANGE_RULE)

      const table = await container.tables.require(tableId)
      const actor = await actorFor(context, table)
      assertHost(actor)

      const occupant = await container.repos.tables.findMemberBySeat(tableId, seatId(seat))
      if (occupant === null || occupant.leftAt !== null) throw new NotFoundError('Seat occupant')
      // A human in that seat is a *kick*, which is a different event with a
      // different system message and a different feeling on the receiving end.
      // Quietly treating one as the other is how somebody gets removed from a
      // game and told a bot was.
      if (!occupant.isBot) {
        throw new ValidationError('That seat is not held by a bot', {
          seat: ['errors.seatNotBot'],
        })
      }

      await container.tables.releaseSeat(tableId, seat, actor)
      return afterSeatChange(context, table, seat, SYSTEM_MESSAGE_KEYS.botRemoved, { seat })
    }),
  )

  // ── table:kick ────────────────────────────────────────────────────────────
  socket.on(
    'table:kick',
    handler(ack, KickPayloadSchema, async ({ tableId, seat }) => {
      atTable(context, tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'kick'), SEAT_CHANGE_RULE)

      const table = await container.tables.require(tableId)
      const actor = await actorFor(context, table)
      assertHost(actor)

      const occupant = await container.repos.tables.findMemberBySeat(tableId, seatId(seat))
      if (occupant === null || occupant.leftAt !== null) throw new NotFoundError('Seat occupant')
      if (holds(occupant, actor.identity)) {
        throw new ValidationError('Use releaseSeat to leave your own seat', {
          seat: ['errors.cannotKickSelf'],
        })
      }

      const victim = identityOfMember(occupant)
      await container.tables.releaseSeat(tableId, seat, actor)

      /**
       * ★ Tell them, then evict them — in that order, and addressed by **room**
       * rather than by looking their sockets up.
       *
       * The seat room *is* the set of that seat's occupant's sockets (04 §2),
       * so `socketsLeave` removes exactly the right ones, across every instance
       * once the Redis adapter is in play, without this handler knowing who
       * they are. Emitting after the eviction would send the notice to an empty
       * room; not evicting at all would leave a player who has lost the seat
       * still receiving its private projection — which, from Phase G on, is
       * that seat's hand.
       */
      const evicted = seatRoom(tableId, seat)
      container.realtime.publish(evicted, 'error', {
        code: 'FORBIDDEN',
        i18nKey: 'errors.kickedFromTable',
        details: { tableId, seat },
      })
      await socket.nsp.in(evicted).socketsLeave(evicted)

      // No grace timer for a seat they no longer hold: "reconnecting…" on
      // somebody who was removed is a badge that never resolves.
      if (victim !== null) container.presence.forget(tableId, victim)

      container.realtime.publish(tableRoom(tableId), 'table:memberLeft', {
        tableId,
        memberId: occupant.id,
        seat,
      })

      return afterSeatChange(context, table, seat, SYSTEM_MESSAGE_KEYS.playerKicked, { seat })
    }),
  )

  // ── table:updateOptions ───────────────────────────────────────────────────
  socket.on(
    'table:updateOptions',
    handler(ack, UpdateOptionsPayloadSchema, async ({ tableId, options }) => {
      atTable(context, tableId)

      const table = await container.tables.require(tableId)
      assertHost(await actorFor(context, table))

      // `patch` refuses anything but `WAITING` with `ILLEGAL_PHASE_TRANSITION`:
      // options describe the deal, and changing them mid-match would rewrite
      // the rules of a game already in progress.
      const updated = await container.tables.patch(tableId, { options }, context.ref)

      container.realtime.publish(tableRoom(tableId), 'table:optionsChanged', {
        tableId,
        options: updated.options,
        seatCount: updated.seatCount,
        allowSpectators: updated.allowSpectators,
        requireApproval: updated.requireApproval,
      })
      await container.chat.system(tableId, SYSTEM_MESSAGE_KEYS.optionsChanged)

      return undefined
    }),
  )
}

// ── Shared tail ──────────────────────────────────────────────────────────────

/**
 * Everything that must happen after a seat's occupant changed, in one place.
 *
 * Re-reading rather than trusting the request is the load-bearing part: the
 * broadcast describes the row as it now stands, so a client that lost the race
 * renders the winner rather than itself.
 */
async function afterSeatChange(
  context: SocketContext,
  table: Table,
  seat: number,
  key: SystemKey,
  params: Record<string, unknown>,
): Promise<SeatChangeResult> {
  const { container } = context

  const mine = await container.repos.tables.findMemberByIdentity(table.id, context.ref)
  const active = mine !== null && mine.leftAt === null ? mine : null

  // The mover's own rooms follow their new standing immediately — before the
  // broadcast, so a private projection can never arrive at a socket that is
  // still in the seat room it just left.
  await syncRooms(context, table, active)

  // ★ `attach`, not `noteSeat`. The ordinary flow is *join the lobby, then sit
  // down*, and at join time there was no member row to track — so a socket that
  // took its seat afterwards was invisible to presence, and disconnecting from
  // it started no grace timer at all. `attach` is idempotent, so calling it on
  // every seat change is both the fix and the simplest statement of the rule:
  // presence begins when a seat does.
  if (active !== null) {
    await container.presence.attach(table.id, context.ref, active, context.socket.id)
  }

  await broadcastSeat(context, table, seat)
  await container.chat.system(table.id, key, params)

  return { tableId: table.id, seat: youView(active, table, context.ref).seat }
}

type SystemKey = (typeof SYSTEM_MESSAGE_KEYS)[keyof typeof SYSTEM_MESSAGE_KEYS]

/** One seat's current occupant, to everyone at the table. */
async function broadcastSeat(context: SocketContext, table: Table, seat: number): Promise<void> {
  const { container } = context
  const members = await container.repos.tables.listMembers(table.id)
  const directory = await container.tables.directory(table, members)
  const view = toSeatViews(table, members, directory, null).find((row) => row.seat === seat)

  container.realtime.publish(tableRoom(table.id), 'table:seatChanged', {
    tableId: table.id,
    seat,
    occupant: view?.occupant ?? null,
    memberId: view?.memberId ?? null,
    team: view?.team ?? null,
    botSubstituted: view?.botSubstituted ?? false,
  })
}

/**
 * The caller's own seat, read from the database.
 *
 * The whole reason `table:releaseSeat` carries no `seat` field: there is
 * exactly one answer, the server already knows it, and a payload that could
 * supply a different one would be a kick with a friendlier name.
 */
async function ownSeat(context: SocketContext, tableId: string): Promise<number> {
  const member = await context.container.repos.tables.findMemberByIdentity(tableId, context.ref)
  if (member === null || member.leftAt !== null || member.seat === null) {
    throw new ForbiddenError('You are not seated at this table', { reason: 'NOT_SEATED' })
  }
  return member.seat
}

function identityOfMember(member: TableMember): IdentityRef | null {
  if (member.userId !== null) return { kind: 'user', userId: member.userId }
  if (member.guestSessionId !== null) {
    return { kind: 'guest', guestSessionId: member.guestSessionId }
  }
  return null
}
