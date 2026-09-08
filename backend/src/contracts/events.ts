/**
 * The canonical socket contract (04-realtime-protocol.md).
 *
 * The maps are deliberately empty in S03 — the gateway is S23. What matters
 * now is that both sides import the *same* declaration, so an event added on
 * the server without a matching client type is a compile error rather than a
 * runtime payload mismatch.
 *
 * Naming: `domain:action`. Client→server events take an ack callback;
 * server→client events are fire-and-forget and carry a `seq`.
 */

/** Bumped on a breaking protocol change; a mismatch tells the client to refresh. */
export const PROTOCOL_VERSION = 1

export interface ConnectedPayload {
  serverTime: number
  protocolVersion: number
}

/** Server → client. Fire-and-forget. */
export interface ServerToClientEvents {
  connected: (payload: ConnectedPayload) => void
}

/** Client → server. Every one of these takes an ack callback. */
export interface ClientToServerEvents {
  // Populated from S24 onward.
  [event: string]: never
}

/** Never used for identity — `socket.data.identity` is resolved at handshake. */
export interface SocketData {
  socketId: string
}
