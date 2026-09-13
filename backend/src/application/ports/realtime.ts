import type { ServerToClientEvents } from '../../contracts/events.js'
import { holderKey, type IdentityRef } from '../../domain/value-objects/identity.js'

/**
 * The broadcasting port — 04 §2, S24.
 *
 * `application/` may not import `infrastructure/` (guard 1), and by the same
 * reasoning it has no business importing `socket.io` either: `PresenceService`
 * and `ChatService` need to *tell people things*, not to know what a
 * `Socket.IO` `BroadcastOperator` is. The adapter lives in
 * `interface/socket/publisher.ts`, which is the layer that already owns the
 * transport.
 *
 * The seam pays for itself immediately in tests: a recording publisher turns
 * "did the other three players learn that seat 2 disconnected?" into an array
 * assertion, with no server, no ports and no timing.
 *
 * ### Rooms are values, not strings
 *
 * Every room name in the platform is built by one of the five functions below.
 * That is what makes 04 §2's guarantee — *public state to the table room,
 * private state to the seat room* — auditable: `rg 'seatRoom\('` finds every
 * place a private projection can possibly go. A hand-assembled
 * `` `seat:${id}:${n}` `` somewhere else would be invisible to that search, and
 * invisible is how a hand leaks.
 */

/** A room name, branded so a bare string cannot be broadcast to by accident. */
declare const roomBrand: unique symbol
export type Room = string & { readonly [roomBrand]: 'Room' }

/** Everyone at the table — players, spectators, host. Public state only. */
export function tableRoom(tableId: string): Room {
  return `table:${tableId}` as Room
}

/**
 * ★ Only the socket(s) of that seat's occupant. **This is the hand-privacy
 * boundary** (04 §2): from Phase G, `game:state` for a seat goes here and
 * nowhere else, which is what makes the guarantee structural rather than
 * conditional on a handler remembering to filter.
 *
 * Multi-tab is deliberate and correct: a second tab for the same person joins
 * the same seat room and gets the same private projection.
 */
export function seatRoom(tableId: string, seat: number): Room {
  return `seat:${tableId}:${seat}` as Room
}

export function spectatorRoom(tableId: string): Room {
  return `spectators:${tableId}` as Room
}

/** All sockets of one signed-in user, across devices and across tables. */
export function userRoom(userId: string): Room {
  return `user:${userId}` as Room
}

/**
 * ★ The same, for **either** kind of identity — S37's `wallet:updated`.
 *
 * The room name *is* the holder key (03 §2), which is deliberate: a wallet
 * belongs to a holder, and "tell this holder their balance moved" should not
 * need a branch at every call site depending on whether they have signed up.
 * A guest accrues coins (10 §3.4) and is entitled to watch them arrive exactly
 * as a user is — persona P2 says a guest is a first-class actor, not a degraded
 * user, and a notification path that worked for only one of the two is how the
 * guest experience quietly rots.
 *
 * Carries cross-table notifications only, never a projection: a holder room
 * spans every table this person is at, so a hand sent here would reach their
 * other tab at another table.
 */
export function holderRoom(holder: IdentityRef): Room {
  return holderKey(holder) as Room
}

export type ServerEvent = keyof ServerToClientEvents
export type PayloadOf<E extends ServerEvent> = Parameters<ServerToClientEvents[E]>[0]

export interface IRealtimePublisher {
  /** Fire-and-forget to every socket in `room`. */
  publish<E extends ServerEvent>(room: Room, event: E, payload: PayloadOf<E>): void

  /**
   * The same, minus one socket — "tell everybody *else*". Used for join
   * announcements, where the joiner has already had a full snapshot and would
   * otherwise see themselves arrive.
   */
  publishExcept<E extends ServerEvent>(
    room: Room,
    exceptSocketId: string,
    event: E,
    payload: PayloadOf<E>,
  ): void

  /** One socket, by id. For snapshots and for errors with no ack to answer. */
  publishToSocket<E extends ServerEvent>(socketId: string, event: E, payload: PayloadOf<E>): void

  /** Socket ids currently in `room`. Presence recomputes from this after a restart. */
  socketsIn(room: Room): Promise<readonly string[]>
}

/**
 * A publisher whose delegate is attached after construction.
 *
 * There is a genuine cycle here: the services need a publisher, the publisher
 * needs the Socket.IO server, and the server's handlers need the services. One
 * of the three has to be late-bound, and this is the cheapest place — a
 * publisher with nothing attached silently drops, which is exactly the right
 * behaviour for the window before the gateway is listening and for the many
 * tests that exercise a service with no transport at all.
 */
export class MutableRealtimePublisher implements IRealtimePublisher {
  private delegate: IRealtimePublisher | null = null

  attach(delegate: IRealtimePublisher): void {
    this.delegate = delegate
  }

  detach(): void {
    this.delegate = null
  }

  publish<E extends ServerEvent>(room: Room, event: E, payload: PayloadOf<E>): void {
    this.delegate?.publish(room, event, payload)
  }

  publishExcept<E extends ServerEvent>(
    room: Room,
    exceptSocketId: string,
    event: E,
    payload: PayloadOf<E>,
  ): void {
    this.delegate?.publishExcept(room, exceptSocketId, event, payload)
  }

  publishToSocket<E extends ServerEvent>(socketId: string, event: E, payload: PayloadOf<E>): void {
    this.delegate?.publishToSocket(socketId, event, payload)
  }

  async socketsIn(room: Room): Promise<readonly string[]> {
    return (await this.delegate?.socketsIn(room)) ?? []
  }
}
