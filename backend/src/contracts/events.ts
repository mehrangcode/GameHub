import { z } from 'zod'
import { CHAT_BODY_MAX, EMOTE_ID_MAX, type ChatMessageView } from './dto/chat.js'
import type { PresenceState } from './dto/presence.js'
import type { MemberView, OccupantView, TableDetail } from './dto/tables.js'
import type { Identity } from './dto/auth.js'
import { BotDifficultySchema, type MemberRole, type TableStatus } from './enums.js'
import type { ErrorCode, SocketAck } from './errors.js'

/**
 * ★ The canonical socket contract — 04-realtime-protocol.md.
 *
 * Both sides import this same declaration through the generated mirror, so an
 * event added on the server without a matching client type is a **compile
 * error** rather than a runtime payload mismatch that both halves happily ship.
 *
 * Two rules govern everything below, and neither is negotiable:
 *
 * 1. **Nothing in any inbound payload can change identity** (04 §1.1). There is
 *    no `userId`, `playerId`, `guestSessionId` or `memberId` field on any
 *    client→server schema in this file, and every one of them is `.strict()`,
 *    so a payload that carries one is *rejected* rather than merely ignored.
 *    Identity is resolved once at handshake; `seat` is looked up server-side
 *    from `TableMember` by identity + table. This single rule eliminates the
 *    entire seat-impersonation class of attack, and it is enforced here, in the
 *    schemas, rather than by every handler remembering.
 *
 *    Note the one apparent exception: `table:takeSeat` and `table:kick` do carry
 *    a `seat`. That is a seat being *named as a target*, never a claim about who
 *    the caller is — the caller's own seat is still read from the database.
 *
 * 2. **Server→client game payloads are already projected for their recipient**
 *    (04 §4). There is deliberately no code path that emits the same game state
 *    to two seats. Phase F carries no game state at all, which is exactly why
 *    the room split lands now: the structure has to be right *before* there is
 *    anything to leak.
 *
 * Naming is `domain:action`. Client→server events take an ack callback;
 * server→client events are fire-and-forget and carry a `seq` once there is a
 * game to sequence (Phase G).
 */

/**
 * Bumped on a **breaking** protocol change: a payload field removed or
 * repurposed, an event renamed, an ack shape changed. Additive changes do not
 * bump it — a client that ignores a new optional field is not broken.
 *
 * The client declares its own version in the handshake `auth`; a mismatch is
 * reported over the `error` event so the page can say "please refresh" instead
 * of half-working after a deploy mid-game.
 */
export const PROTOCOL_VERSION = 1

/** Handshake `auth` key the client puts its {@link PROTOCOL_VERSION} under. */
export const PROTOCOL_VERSION_AUTH_KEY = 'protocolVersion'

// ═══════════════════════════════════════════════════════════════════════════
// Client → server payloads
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every table-scoped event names its table.
 *
 * Not derived from "the table this socket joined", even though the socket knows:
 * one tab may legitimately watch two tables, and an event whose target is
 * implicit is an event that acts on the wrong one after a race.
 */
const tableId = z.string().min(1).max(64)
const seat = z.number().int().min(0).max(9)

export const TableJoinPayloadSchema = z
  .object({
    tableId,
    /** Watch without taking a seat. Refused when the table forbids spectators. */
    asSpectator: z.boolean().optional(),
  })
  .strict()

export type TableJoinPayload = z.infer<typeof TableJoinPayloadSchema>

export const TableLeavePayloadSchema = z.object({ tableId }).strict()
export type TableLeavePayload = z.infer<typeof TableLeavePayloadSchema>

/** `seat` is the seat being *asked for*; who is asking comes from the socket. */
export const TakeSeatPayloadSchema = z.object({ tableId, seat }).strict()
export type TakeSeatPayload = z.infer<typeof TakeSeatPayloadSchema>

/**
 * No `seat`: you can only ever release your own, and the server already knows
 * which that is. A `seat` field here would be a kick wearing a release's name.
 */
export const ReleaseSeatPayloadSchema = z.object({ tableId }).strict()
export type ReleaseSeatPayload = z.infer<typeof ReleaseSeatPayloadSchema>

export const AddBotPayloadSchema = z
  .object({ tableId, seat, difficulty: BotDifficultySchema.default('medium') })
  .strict()

export type AddBotPayload = z.infer<typeof AddBotPayloadSchema>

export const RemoveBotPayloadSchema = z.object({ tableId, seat }).strict()
export type RemoveBotPayload = z.infer<typeof RemoveBotPayloadSchema>

/** Host only. Removing another human from a seat is a kick, and a kick is host authority. */
export const KickPayloadSchema = z.object({ tableId, seat }).strict()
export type KickPayload = z.infer<typeof KickPayloadSchema>

export const UpdateOptionsPayloadSchema = z
  .object({ tableId, options: z.record(z.unknown()) })
  .strict()

export type UpdateOptionsPayload = z.infer<typeof UpdateOptionsPayloadSchema>

export const ChatSendPayloadSchema = z
  .object({ tableId, body: z.string().trim().min(1).max(CHAT_BODY_MAX) })
  .strict()

export type ChatSendPayload = z.infer<typeof ChatSendPayloadSchema>

export const ChatEmotePayloadSchema = z
  .object({ tableId, emoteId: z.string().trim().min(1).max(EMOTE_ID_MAX) })
  .strict()

export type ChatEmotePayload = z.infer<typeof ChatEmotePayloadSchema>

export const HeartbeatPayloadSchema = z.object({ tableId }).strict()
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>

// ═══════════════════════════════════════════════════════════════════════════
// Server → client payloads
// ═══════════════════════════════════════════════════════════════════════════

export interface ConnectedPayload {
  /**
   * Server epoch millis at handshake. The client stores `serverTime - Date.now()`
   * as its clock offset and renders every countdown against it (04 §9.7) — a
   * device with a skewed clock must still see the deadline that can eject it.
   */
  readonly serverTime: number
  readonly protocolVersion: number
  /** Echo of what the client declared, so a mismatch is visible in one payload. */
  readonly clientProtocolVersion: number | null
}

/** Where the reader themselves is sitting. Answers "which seat is mine?" once. */
export interface YouView {
  readonly memberId: string | null
  readonly seat: number | null
  readonly role: MemberRole
  readonly isHost: boolean
  readonly isSpectator: boolean
}

/** The full lobby state on join, and again on every reconnect inside grace. */
export interface TableSnapshotPayload {
  readonly table: TableDetail
  /** Everyone present, spectators included — `table.seats` covers only the seated. */
  readonly members: readonly MemberView[]
  readonly you: YouView
  /** Oldest first, so the client appends rather than reverses. */
  readonly chat: readonly ChatMessageView[]
  readonly serverTime: number
}

export interface MemberJoinedPayload {
  readonly tableId: string
  readonly member: MemberView
}

export interface MemberLeftPayload {
  readonly tableId: string
  readonly memberId: string
  readonly seat: number | null
}

export interface SeatChangedPayload {
  readonly tableId: string
  readonly seat: number
  /** Null when the seat was vacated. */
  readonly occupant: OccupantView | null
  readonly memberId: string | null
  readonly team: number | null
  readonly botSubstituted: boolean
}

export interface OptionsChangedPayload {
  readonly tableId: string
  readonly options: Record<string, unknown>
  readonly seatCount: number
  readonly allowSpectators: boolean
  readonly requireApproval: boolean
}

export interface StatusChangedPayload {
  readonly tableId: string
  readonly status: TableStatus
}

export interface PresencePayload {
  readonly tableId: string
  readonly memberId: string
  readonly seat: number | null
  readonly state: PresenceState
  /** ISO 8601 while `disconnected`, null otherwise. Absolute, never a duration. */
  readonly graceEndsAt: string | null
}

export interface ChatMessagePayload {
  readonly tableId: string
  readonly message: ChatMessageView
}

/**
 * Out-of-band errors — the ones with no ack to answer.
 *
 * Same contract as REST (02 §5.6): a stable machine `code` plus an `i18nKey`,
 * never a rendered English sentence.
 */
export interface SocketErrorPayload {
  readonly code: ErrorCode
  readonly i18nKey: string
  readonly details?: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════════
// Ack results
// ═══════════════════════════════════════════════════════════════════════════

export interface TableJoinResult {
  readonly tableId: string
  readonly you: YouView
}

export interface SeatChangeResult {
  readonly tableId: string
  readonly seat: number | null
}

export interface ChatSendResult {
  readonly messageId: string
}

/** Every client→server event answers with one of these. */
export type AckFn<T> = (ack: SocketAck<T>) => void

// ═══════════════════════════════════════════════════════════════════════════
// The typed maps
// ═══════════════════════════════════════════════════════════════════════════

export interface ServerToClientEvents {
  connected: (payload: ConnectedPayload) => void

  'table:snapshot': (payload: TableSnapshotPayload) => void
  'table:memberJoined': (payload: MemberJoinedPayload) => void
  'table:memberLeft': (payload: MemberLeftPayload) => void
  'table:seatChanged': (payload: SeatChangedPayload) => void
  'table:optionsChanged': (payload: OptionsChangedPayload) => void
  'table:statusChanged': (payload: StatusChangedPayload) => void
  'table:presence': (payload: PresencePayload) => void

  'chat:message': (payload: ChatMessagePayload) => void

  error: (payload: SocketErrorPayload) => void
}

export interface ClientToServerEvents {
  'table:join': (payload: TableJoinPayload, ack: AckFn<TableJoinResult>) => void
  'table:leave': (payload: TableLeavePayload, ack: AckFn<undefined>) => void
  'table:takeSeat': (payload: TakeSeatPayload, ack: AckFn<SeatChangeResult>) => void
  'table:releaseSeat': (payload: ReleaseSeatPayload, ack: AckFn<SeatChangeResult>) => void
  'table:addBot': (payload: AddBotPayload, ack: AckFn<SeatChangeResult>) => void
  'table:removeBot': (payload: RemoveBotPayload, ack: AckFn<SeatChangeResult>) => void
  'table:kick': (payload: KickPayload, ack: AckFn<SeatChangeResult>) => void
  'table:updateOptions': (payload: UpdateOptionsPayload, ack: AckFn<undefined>) => void

  'chat:send': (payload: ChatSendPayload, ack: AckFn<ChatSendResult>) => void
  'chat:emote': (payload: ChatEmotePayload, ack: AckFn<ChatSendResult>) => void

  'presence:heartbeat': (payload: HeartbeatPayload, ack: AckFn<undefined>) => void
}

/** Nothing travels between server instances directly — the Redis adapter does it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface InterServerEvents {}

/**
 * Per-socket server state.
 *
 * ★ `identity` is written **once**, by the handshake middleware, and then made
 * non-writable and frozen (04 §1.1). Re-reading it per event would let a token
 * swap mid-connection; letting a handler reassign it would reintroduce by
 * accident exactly what the payload schemas refuse on purpose.
 */
export interface SocketData {
  readonly identity: Identity
  /** Tables this socket has joined. A tab may legitimately watch more than one. */
  tables: Set<string>
  readonly connectedAt: number
  readonly clientProtocolVersion: number | null
  readonly ip: string | null
  readonly userAgent: string | null
}
