import type { Server } from 'socket.io'
import type {
  IRealtimePublisher,
  PayloadOf,
  Room,
  ServerEvent,
} from '../../application/ports/realtime.js'
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../../contracts/events.js'

export type GatewayServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

/**
 * `IRealtimePublisher` over a Socket.IO server — S24.
 *
 * The whole adapter is four one-line methods, which is the point: everything
 * interesting about broadcasting (which room, which payload, who is excluded)
 * is decided in `application/`, where it can be asserted against a recording
 * publisher with no server, no ports and no timing. This file is the only place
 * in the codebase that knows Socket.IO has a `to()`.
 *
 * ★ Note what is *absent*: there is no `broadcastToEveryone`, no `emitAll`, and
 * no method that takes a raw string. A room is a branded value produced by one
 * of four builders (04 §2), so `rg 'seatRoom\('` finds every place a private
 * projection can possibly be sent — which is what makes the hand-privacy
 * guarantee auditable rather than merely intended.
 */
export class SocketRealtimePublisher implements IRealtimePublisher {
  constructor(private readonly io: GatewayServer) {}

  publish<E extends ServerEvent>(room: Room, event: E, payload: PayloadOf<E>): void {
    loosen(this.io.to(room)).emit(event, payload)
  }

  publishExcept<E extends ServerEvent>(
    room: Room,
    exceptSocketId: string,
    event: E,
    payload: PayloadOf<E>,
  ): void {
    // `except` takes a room name, and every socket is implicitly in a room
    // named after its own id — which is how Socket.IO addresses one socket.
    loosen(this.io.to(room).except(exceptSocketId)).emit(event, payload)
  }

  publishToSocket<E extends ServerEvent>(socketId: string, event: E, payload: PayloadOf<E>): void {
    loosen(this.io.to(socketId)).emit(event, payload)
  }

  async socketsIn(room: Room): Promise<readonly string[]> {
    // `fetchSockets` is adapter-aware: with the Redis adapter (S27) it returns
    // sockets on *other* instances too, which is what makes presence recompute
    // correctly in a multi-process deployment rather than reporting only the
    // instance that happened to answer.
    return (await this.io.in(room).fetchSockets()).map((socket) => socket.id)
  }
}

/**
 * Socket.IO's `emit` is typed per *literal* event name, so it cannot accept a
 * generic `E extends keyof ServerToClientEvents` — the parameter tuple collapses
 * to `never` and every call fails to compile.
 *
 * The cast is confined to this one function, and it costs nothing: the payload
 * was already proven to match its event by {@link PayloadOf} at the call site
 * above, which is the check that actually matters. The alternative — ten
 * hand-written overloads, one per event, kept in step with the contract by hand
 * — would be more code and *less* safe.
 */
function loosen(target: unknown): { emit(event: string, payload: unknown): unknown } {
  return target as { emit(event: string, payload: unknown): unknown }
}
