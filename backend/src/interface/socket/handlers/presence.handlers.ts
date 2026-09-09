import { HeartbeatPayloadSchema } from '../../../contracts/events.js'
import { handler, type AckContext } from '../ack.js'
import { atTable, type SocketContext } from '../context.js'

/**
 * The heartbeat — S25, 04 §3.1.
 *
 * One event, and its whole job is to distinguish *thinking* from *gone*.
 *
 * Socket.IO already has a ping/pong at the transport layer, so it is fair to
 * ask why this exists. The transport ping proves a **TCP connection** is alive;
 * it is answered by the browser's networking stack, and it keeps answering from
 * a tab that has been backgrounded on a phone with the screen off, from a
 * laptop lid that just closed, and from a page whose JavaScript has thrown and
 * stopped rendering. This heartbeat is sent by the *application*, so it proves
 * something different and more useful: the client is still running, still
 * rendering, and a human could still act.
 *
 * That is the `away` state — the soft middle ground the transport cannot see.
 * It starts no grace timer and forfeits nothing; it exists so the other three
 * players stop waiting on somebody whose screen is off.
 *
 * A guest's `lastSeenAt` is also touched here, which is what makes the guest
 * session's TTL sliding (07 §5.1): a game night runs longer than twelve hours
 * only if the twelve hours are counted from the last thing you did.
 */

export interface PresenceHandlerDeps {
  readonly context: SocketContext
  readonly ack: AckContext
}

export function registerPresenceHandlers({ context, ack }: PresenceHandlerDeps): void {
  const { socket, container } = context

  socket.on(
    'presence:heartbeat',
    handler(ack, HeartbeatPayloadSchema, async ({ tableId }) => {
      atTable(context, tableId)
      container.presence.touch(tableId, context.ref)

      if (context.ref.kind === 'guest') {
        // Fire-and-forget on purpose: a failed `lastSeenAt` write must never
        // turn a heartbeat into an error the client retries. The worst case is
        // a session that expires on schedule instead of late.
        void container.guests
          .touch(context.ref.guestSessionId)
          .catch((error: unknown) =>
            context.logger.debug({ err: error }, 'guest lastSeenAt touch failed'),
          )
      }

      return undefined
    }),
  )
}
