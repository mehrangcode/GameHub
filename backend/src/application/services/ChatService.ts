import type { Logger } from 'pino'
import {
  CHAT_HISTORY_LIMIT,
  SYSTEM_MESSAGE_KEYS,
  type ChatMessageView,
  type SystemMessageKey,
} from '../../contracts/dto/chat.js'
import { CHAT_EMOTE_RULE, CHAT_SEND_RULE } from '../../config/socketLimits.js'
import type { ChatMessage } from '../../domain/entities/table.js'
import { RateLimitError } from '../../domain/errors/errors.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import { holderKey, type IdentityRef } from '../../domain/value-objects/identity.js'
import { toChatHistory, toChatMessageView, type ChatContext } from '../mappers/chat.js'
import { membersByActor, type OccupantDirectory } from '../mappers/tables.js'
import { assertEmoteIdAllowed, prepareChatBody } from '../policies/chat.js'
import type { IRateLimiter } from '../ports/rateLimiter.js'
import { tableRoom, type IRealtimePublisher } from '../ports/realtime.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { TableService } from './TableService.js'

/**
 * Chat, emotes and system narration — S26.
 *
 * This is one of M0's exit criteria in full ("chat works both ways"), and the
 * two interesting decisions in it are both about *what a row contains*:
 *
 * 1. **A `SYSTEM` row stores an i18n key and a params object.** "Sara took seat
 *    2" is not a sentence the server composes. The row holds
 *    `table.system.seatTaken` + `{ name, seat }`, so it renders in Persian for
 *    a Persian reader — from the same bytes, months later, in a transcript
 *    nobody thought to re-translate. There is a test that enforces this by
 *    shape: every system body must match a dotted-key pattern, which no English
 *    sentence can, because the pattern forbids whitespace.
 *
 * 2. **A message is persisted before it is broadcast.** The order matters on
 *    reconnect: a late joiner's snapshot reads from the table, so anything
 *    broadcast-but-unsaved would be visible to the people who were there and
 *    invisible to the person who arrives one second later — a discrepancy that
 *    is very hard to explain and very easy to avoid.
 *
 * Text and emotes have **independent** buckets (04 §8). An emote is a reaction,
 * and reacting to four things in a fast hand must not cost you the ability to
 * say "nice one".
 */

export interface ChatActor {
  readonly identity: IdentityRef
  readonly tableId: string
}

/**
 * The author of a `SYSTEM` row.
 *
 * A distinct value rather than `null`, so the append path branches on something
 * the type checker understands instead of on a nullable identity that would
 * have to be guarded at three call sites and forgotten at the fourth.
 */
const SYSTEM = Symbol('system-author')

export interface ChatServiceDeps {
  readonly repos: Repositories
  readonly tables: TableService
  readonly realtime: IRealtimePublisher
  readonly rateLimiter: IRateLimiter
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  /**
   * @throws {RateLimitError} with `retryAfterMs`, **before** anything is
   * written. A throttled message must leave no row: a transcript that contains
   * messages nobody ever saw is worse than a dropped one.
   */
  async send(actor: ChatActor, body: string): Promise<ChatMessageView> {
    await this.spend(`chat:text:${holderKey(actor.identity)}`, CHAT_SEND_RULE)

    const message = await this.append(
      actor.tableId,
      actor.identity,
      'TEXT',
      prepareChatBody(body),
      null,
    )
    this.deps.metrics.increment('chat_messages')
    return message
  }

  async emote(actor: ChatActor, emoteId: string): Promise<ChatMessageView> {
    await this.spend(`chat:emote:${holderKey(actor.identity)}`, CHAT_EMOTE_RULE)
    assertEmoteIdAllowed(emoteId)

    const message = await this.append(actor.tableId, actor.identity, 'EMOTE', emoteId, null)
    this.deps.metrics.increment('chat_emotes')
    return message
  }

  /**
   * Server narration — a seat taken, a bot added, a player kicked.
   *
   * Never rate-limited and never authored by an identity: the table itself is
   * speaking. `key` is constrained to {@link SYSTEM_MESSAGE_KEYS} rather than
   * being a free string, so a typo is a compile error instead of a message that
   * renders in production as its own key.
   */
  async system(
    tableId: string,
    key: SystemMessageKey,
    params: Record<string, unknown> = {},
  ): Promise<ChatMessageView> {
    return this.append(tableId, SYSTEM, 'SYSTEM', key, params)
  }

  /** Oldest first, for a joiner's `table:snapshot`. */
  async history(
    tableId: string,
    viewer: IdentityRef | null,
    limit = CHAT_HISTORY_LIMIT,
  ): Promise<ChatMessageView[]> {
    const messages = await this.deps.repos.chat.listByTable(tableId, { limit })
    return toChatHistory(messages, await this.contextFor(tableId, viewer, messages))
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async spend(key: string, rule: { limit: number; windowMs: number }): Promise<void> {
    const decision = await this.deps.rateLimiter.consume(key, rule)
    if (decision.allowed) return

    this.deps.metrics.increment('chat_rate_limited')
    throw new RateLimitError(decision.retryAfterMs, {
      bucket: key.split(':').slice(0, 2).join(':'),
    })
  }

  /**
   * Persist, then project once per author-context, then broadcast.
   *
   * One subtlety: the payload is built **per recipient group** rather than
   * once, because `author.isSelf` differs between the sender and everyone else.
   * Two payloads — the sender's and the table's — is the cheapest correct
   * answer; the alternative, letting the client compare ids, would mean putting
   * a `userId` in the transcript, which is exactly what `ChatAuthor` refuses to
   * carry.
   */
  private async append(
    tableId: string,
    author: IdentityRef | typeof SYSTEM,
    kind: 'TEXT' | 'EMOTE' | 'SYSTEM',
    body: string,
    params: Record<string, unknown> | null,
  ): Promise<ChatMessageView> {
    // A table that never existed is a 404 before anything is written. (A
    // *closed* one still renders its transcript — it simply stops accepting new
    // lines, which the handlers enforce.)
    await this.deps.tables.require(tableId)

    const row = await this.deps.repos.chat.append({
      tableId,
      kind,
      body,
      params,
      // ★ Both columns are null for a SYSTEM row. That is not a missing author,
      // it is the definition of one: the table itself is speaking.
      ...(author === SYSTEM
        ? {}
        : author.kind === 'user'
          ? { userId: author.userId }
          : { guestSessionId: author.guestSessionId }),
    })

    const context = await this.contextFor(tableId, null, [row])

    this.deps.realtime.publish(tableRoom(tableId), 'chat:message', {
      tableId,
      message: toChatMessageView(row, context),
    })

    // The author's own copy, with `isSelf` true. Returned rather than emitted:
    // it travels back in the ack, so the composer can settle its pending state
    // without special-casing the broadcast it is also about to receive.
    return toChatMessageView(row, {
      ...context,
      viewer: author === SYSTEM ? null : author,
    })
  }

  /**
   * The names and seats a batch of messages needs, in two reads.
   *
   * The authors are passed in rather than derived from the member list, because
   * they are not the same set: somebody who spoke in the lobby and then left,
   * or who is watching without a seat, has a message in the transcript and no
   * member row. Resolving only members rendered those lines as unnamed.
   */
  private async contextFor(
    tableId: string,
    viewer: IdentityRef | null,
    messages: readonly ChatMessage[],
  ): Promise<ChatContext> {
    const members = await this.deps.repos.tables.listMembers(tableId)

    const directory: OccupantDirectory = await this.deps.tables.directory(null, members, {
      userIds: messages.flatMap((message) => (message.userId === null ? [] : [message.userId])),
      guestSessionIds: messages.flatMap((message) =>
        message.guestSessionId === null ? [] : [message.guestSessionId],
      ),
    })

    return { directory, membersByActor: membersByActor(members), viewer }
  }
}

export { SYSTEM_MESSAGE_KEYS }
