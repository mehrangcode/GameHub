import {
  ChatEmotePayloadSchema,
  ChatSendPayloadSchema,
  type ChatSendResult,
} from '../../../contracts/events.js'
import { IllegalPhaseTransitionError } from '../../../domain/errors/errors.js'
import { handler, type AckContext } from '../ack.js'
import { atTable, type SocketContext } from '../context.js'

/**
 * Chat and emotes over the socket — S26.
 *
 * The handlers are deliberately three lines each: the rate limits, the
 * profanity mask, the persistence and the broadcast all live in `ChatService`,
 * because none of them are transport concerns and all of them will be needed
 * again by the admin console's moderation view (12 §6).
 *
 * What *is* a transport concern, and lives here: **you may only speak at a
 * table you have joined**, and a guest may only ever have joined its bound one.
 * Both come from `atTable`.
 */

export interface ChatHandlerDeps {
  readonly context: SocketContext
  readonly ack: AckContext
}

export function registerChatHandlers({ context, ack }: ChatHandlerDeps): void {
  const { socket, container } = context

  socket.on(
    'chat:send',
    handler(ack, ChatSendPayloadSchema, async ({ tableId, body }) => {
      atTable(context, tableId)
      await assertOpen(context, tableId)

      const message = await container.chat.send({ identity: context.ref, tableId }, body)
      return { messageId: message.id } satisfies ChatSendResult
    }),
  )

  socket.on(
    'chat:emote',
    handler(ack, ChatEmotePayloadSchema, async ({ tableId, emoteId }) => {
      atTable(context, tableId)
      await assertOpen(context, tableId)

      const message = await container.chat.emote({ identity: context.ref, tableId }, emoteId)
      return { messageId: message.id } satisfies ChatSendResult
    }),
  )
}

/**
 * A closed table keeps its transcript and stops taking new lines.
 *
 * Rejecting rather than ignoring, because the alternative is a message box that
 * accepts input and drops it — and the player has no way to tell that from a
 * network problem. `FINISHED` deliberately still accepts chat: "good game" is
 * the most-used message in the product and it always arrives after the result.
 */
async function assertOpen(context: SocketContext, tableId: string): Promise<void> {
  const table = await context.container.tables.require(tableId)
  if (table.status !== 'CLOSED' && table.closedAt === null) return

  throw new IllegalPhaseTransitionError(table.status, 'WAITING', { tableId })
}
