import type {
  IRealtimePublisher,
  PayloadOf,
  Room,
  ServerEvent,
} from '../../src/application/ports/realtime.js'

export interface Published {
  readonly room: string
  readonly event: string
  readonly payload: unknown
  readonly except?: string
}

/**
 * A publisher that records instead of transmitting.
 *
 * This is why `IRealtimePublisher` exists as a port. "Did the other three
 * players learn that seat 2 disconnected?" becomes an array assertion — no
 * server, no ports, no `await new Promise(setTimeout)`, and no chance of a
 * flake. The integration tests still run real clients over a real socket,
 * because the room *wiring* has to be proven too; this is for the far more
 * numerous cases where the question is about a service's behaviour.
 */
export class RecordingPublisher implements IRealtimePublisher {
  readonly sent: Published[] = []
  /** Room → socket ids, for `socketsIn`. Set by hand when a test needs it. */
  readonly rooms = new Map<string, string[]>()

  publish<E extends ServerEvent>(room: Room, event: E, payload: PayloadOf<E>): void {
    this.sent.push({ room, event, payload })
  }

  publishExcept<E extends ServerEvent>(
    room: Room,
    exceptSocketId: string,
    event: E,
    payload: PayloadOf<E>,
  ): void {
    this.sent.push({ room, event, payload, except: exceptSocketId })
  }

  publishToSocket<E extends ServerEvent>(socketId: string, event: E, payload: PayloadOf<E>): void {
    this.sent.push({ room: `socket:${socketId}`, event, payload })
  }

  async socketsIn(room: Room): Promise<readonly string[]> {
    return this.rooms.get(room) ?? []
  }

  // ── Assertions helpers ────────────────────────────────────────────────────

  of(event: string): Published[] {
    return this.sent.filter((entry) => entry.event === event)
  }

  toRoom(room: string): Published[] {
    return this.sent.filter((entry) => entry.room === room)
  }

  last(event: string): Published | undefined {
    return this.of(event).at(-1)
  }

  clear(): void {
    this.sent.length = 0
  }
}
