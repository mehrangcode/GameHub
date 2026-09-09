import type { ChatAuthor, ChatMessageView } from '../../contracts/dto/chat.js'
import type { ChatMessage, TableMember } from '../../domain/entities/table.js'
import type { IdentityRef } from '../../domain/value-objects/identity.js'
import type { OccupantDirectory } from './tables.js'

/**
 * Chat entities → the wire (S26).
 *
 * Two things this mapper is responsible for, both of which are easy to get
 * wrong once and never notice:
 *
 * 1. **A redacted message keeps its row and loses its body.** Moderation
 *    (12 §6) is a tombstone, not a delete: the message's *place* in the
 *    conversation stays, so the replies around it still make sense, and the
 *    audit trail still knows who said something worth removing. What must never
 *    survive is the text — so `body` and `params` are nulled here, at the only
 *    point where a row becomes a payload, rather than being filtered by every
 *    caller.
 *
 * 2. **The author is a display name and a seat, never an id.** Same rule as the
 *    seat map: a transcript is shown to spectators and to anyone holding the
 *    invite link. "Is this mine?" is answered by `isSelf`.
 */

export interface ChatContext {
  readonly directory: OccupantDirectory
  /** Seat lookup, so an author's seat is the one they held — read server-side. */
  readonly membersByActor: ReadonlyMap<string, TableMember>
  readonly viewer: IdentityRef | null
}

/** `user:<id>` / `guest:<id>`, matching `holderKey` — the actor's index into the maps. */
function actorKey(message: ChatMessage): string | null {
  if (message.userId !== null) return `user:${message.userId}`
  if (message.guestSessionId !== null) return `guest:${message.guestSessionId}`
  return null
}

function toAuthor(message: ChatMessage, context: ChatContext): ChatAuthor {
  // A SYSTEM row has no actor by construction, and is checked *before* the
  // both-null case below — otherwise every system message would render as a bot.
  if (message.kind === 'SYSTEM') {
    return { kind: 'system', displayName: null, seat: null, isSelf: false }
  }

  const key = actorKey(message)
  if (key === null) {
    return { kind: 'bot', displayName: null, seat: null, isSelf: false }
  }

  const member = context.membersByActor.get(key) ?? null
  const profile =
    message.userId !== null
      ? context.directory.users.get(message.userId)
      : message.guestSessionId !== null
        ? context.directory.guests.get(message.guestSessionId)
        : undefined

  const viewer = context.viewer
  const isSelf =
    viewer === null
      ? false
      : viewer.kind === 'user'
        ? message.userId === viewer.userId
        : message.guestSessionId === viewer.guestSessionId

  return {
    kind: message.userId !== null ? 'user' : 'guest',
    // A missing profile means the account was deleted or the guest session was
    // swept. The transcript still has to render, so it renders unnamed rather
    // than throwing on a read path.
    displayName: profile?.displayName ?? null,
    seat: member?.seat ?? null,
    isSelf,
  }
}

export function toChatMessageView(message: ChatMessage, context: ChatContext): ChatMessageView {
  const redacted = message.redactedAt !== null

  return {
    id: message.id,
    tableId: message.tableId,
    kind: message.kind,
    author: toAuthor(message, context),
    body: redacted ? null : message.body,
    params: redacted ? null : message.params,
    createdAt: message.createdAt.toISOString(),
    redactedAt: message.redactedAt?.toISOString() ?? null,
  }
}

/**
 * The repository returns newest first (it pages backwards from the live tail);
 * a transcript reads oldest first. Reversing here, once, means no caller has to
 * remember which way round the list arrived.
 */
export function toChatHistory(
  messages: readonly ChatMessage[],
  context: ChatContext,
): ChatMessageView[] {
  return messages
    .slice()
    .reverse()
    .map((message) => toChatMessageView(message, context))
}
