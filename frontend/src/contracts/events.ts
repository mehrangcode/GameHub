// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'
import { CHAT_BODY_MAX, EMOTE_ID_MAX, type ChatMessageView } from './dto/chat.js'
import type { PresenceState } from './dto/presence.js'
import type { MemberView, OccupantView, TableDetail } from './dto/tables.js'
import type { Identity } from './dto/auth.js'
import {
  BotDifficultySchema,
  type GameEventKind,
  type MatchReason,
  type MemberRole,
  type SeatOutcome,
  type TableStatus,
} from './enums.js'
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

// ── Phase G: the game itself ─────────────────────────────────────────────────

const gameId = z.string().min(1).max(64)

/**
 * A client-chosen idempotency key — 03 §4.4.
 *
 * It is written to `GameEvent.clientMoveId`, where `(gameId, clientMoveId)` is
 * unique, so a socket retry after a dropped ack returns the original ack
 * instead of playing a second card. Bounded because it lands in a database
 * column and an unbounded string from an untrusted client is a free write
 * amplification.
 *
 * ★ It is an *idempotency* key and nothing more. Nothing on the server is
 * derived from it — in particular not the deal randomness (see `gameRng` in
 * `domain/games/shared/rng.ts`), because a client that could pick the seed of
 * its own draw could retry until the deck obliged.
 */
const clientMoveId = z.string().trim().min(1).max(64)

/** Host only. Validates the seat count against `meta.playableCounts`. */
export const GameStartPayloadSchema = z.object({ tableId }).strict()
export type GameStartPayload = z.infer<typeof GameStartPayloadSchema>

/**
 * ★ The core event — 04 §3.1, 05 §6.
 *
 * Note what is **not** here: no `seat`. The acting seat is looked up
 * server-side from `TableMember` by the socket's frozen identity, so a payload
 * claiming seat 2 is not merely ignored — there is no field to claim it in, and
 * `.strict()` rejects the attempt outright.
 *
 * `move` is an opaque record: its shape belongs to the engine, which parses it
 * and throws `ILLEGAL_MOVE` for anything it does not recognise. Validating it
 * here would mean the transport knowing six games' move grammars, and would put
 * the enforcement point somewhere other than `applyMove` (I3).
 */
export const GameMovePayloadSchema = z
  .object({ gameId, move: z.record(z.unknown()), clientMoveId })
  .strict()

export type GameMovePayload = z.infer<typeof GameMovePayloadSchema>

/**
 * Explicit resync — 04 §5.3.
 *
 * `lastSeq` is optional on purpose: a client that has no idea where it stands
 * omits it and gets a `full`, which is *always* correct. Never guess at
 * reconciliation.
 */
export const GameRequestSyncPayloadSchema = z
  .object({ gameId, lastSeq: z.number().int().min(0).optional() })
  .strict()

export type GameRequestSyncPayload = z.infer<typeof GameRequestSyncPayloadSchema>

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

// ── Phase G: the game itself ─────────────────────────────────────────────────

/**
 * Who sat where when the deal started.
 *
 * Ids are deliberately absent, exactly as in `OccupantView`: this goes to
 * everyone at the table, spectators included, and a seat map is the wrong place
 * to hand out account identifiers.
 */
export interface SeatingView {
  readonly seat: number
  readonly displayName: string
  readonly isBot: boolean
  readonly team: number | null
}

/**
 * ★ Published **before** any card exists — 03 §5, 04 §7, 07 §4.2.
 *
 * `seedCommit` is `sha256(rngSeed + gameId)`. Clients store it now and verify it
 * against the `seedRevealed` in `game:finished` later, which is what makes "the
 * server cannot have chosen the deal after seeing anyone's cards" a checkable
 * claim rather than a promise.
 *
 * There is no `rngSeed` field on this payload, and a test asserts the seed
 * appears in no payload at all before `finishedAt`.
 */
export interface GameStartedPayload {
  readonly tableId: string
  readonly gameId: string
  readonly gameSlug: string
  readonly seedCommit: string
  readonly seating: readonly SeatingView[]
  readonly startedAt: string
  readonly seq: number
}

/**
 * ★ The personalized projection — 04 §4, the anti-cheat boundary made a wire
 * format.
 *
 * This payload is produced **once per viewer** by `projectState(state, viewer)`
 * and sent to that viewer's room alone. There is deliberately no code path that
 * sends one `game:state` to two different seats; `tests/unit/socket/projection-boundary.test.ts`
 * fails the build if one appears.
 *
 * `legalMoves` is present only for the seat that is to act, and it is a
 * *convenience for the UI* — `applyMove` is the enforcement point, and it throws
 * for anything outside that list whether or not the client ever saw it.
 */
export interface GameStatePayload {
  readonly gameId: string
  readonly tableId: string
  /** Monotonic; the client drops anything `<= lastSeq` and resyncs on a gap. */
  readonly seq: number
  readonly phase: string | null
  /** Already projected. The client renders this verbatim and derives nothing. */
  readonly view: unknown
  readonly toAct: number | null
  readonly legalMoves: readonly unknown[] | null
  readonly isTerminal: boolean
  readonly serverTime: number
}

/**
 * Public narration — "Sara played ♠A" — as an i18n key plus params, never prose.
 *
 * Named `GameNarrationPayload` rather than `GameEventPayload` because the
 * domain already owns that name for what an *engine* emits
 * (`domain/games/GameEngine.ts`). They are different things: one is the record
 * written to the log, this is what the table is told about it.
 */
export interface GameNarrationPayload {
  readonly gameId: string
  readonly tableId: string
  readonly seq: number
  readonly kind: GameEventKind
  readonly seat: number | null
  /** i18n key + params, or `null` for an event with nothing to say out loud. */
  readonly descriptor: { readonly key: string; readonly params: Record<string, unknown> } | null
}

/** To the offender's socket only. The same refusal also lands in the ack. */
export interface GameMoveRejectedPayload {
  readonly gameId: string
  readonly clientMoveId: string
  readonly code: ErrorCode
  readonly i18nKey: string
  readonly details?: Record<string, unknown>
}

/** The seed is revealed **here** and nowhere earlier (04 §7). */
export interface GameFinishedPayload {
  readonly gameId: string
  readonly tableId: string
  readonly seq: number
  readonly reason: MatchReason
  readonly winningTeam: number | null
  readonly standings: readonly {
    readonly seat: number
    readonly rank: number
    readonly score: number
    readonly outcome: SeatOutcome
  }[]
  readonly summary: Record<string, unknown>
  readonly seedRevealed: string
  readonly seedCommit: string
}

/** The server noticed this client is behind. It must answer `game:requestSync`. */
export interface GameSyncRequiredPayload {
  readonly gameId: string
  readonly reason: 'GAP' | 'AHEAD_OF_SERVER' | 'UNKNOWN_POSITION'
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

export interface GameStartResult {
  readonly gameId: string
  readonly gameSlug: string
  readonly seedCommit: string
  readonly seq: number
}

/**
 * `replayed: true` means the `clientMoveId` had already been used and the
 * server answered from the log instead of playing the move again (03 §4.4).
 *
 * It is reported rather than hidden because the two cases are genuinely
 * different to a client that is retrying: `false` means "your move landed
 * now", `true` means "it had already landed, stop retrying".
 */
export interface GameMoveResult {
  readonly gameId: string
  readonly seq: number
  readonly replayed: boolean
}

export interface GameSyncResult {
  readonly gameId: string
  readonly mode: 'delta' | 'full'
  /** The first event replayed, or `null` for a `full` (there is nothing to replay). */
  readonly fromSeq: number | null
  readonly toSeq: number
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

  /**
   * ★ `game:state` goes to `seat:{id}:{n}` and to `spectators:{id}` — never to
   * `table:{id}`, which holds both. Everything else here is public by
   * construction.
   */
  'game:started': (payload: GameStartedPayload) => void
  'game:state': (payload: GameStatePayload) => void
  'game:event': (payload: GameNarrationPayload) => void
  'game:moveRejected': (payload: GameMoveRejectedPayload) => void
  'game:finished': (payload: GameFinishedPayload) => void
  'game:syncRequired': (payload: GameSyncRequiredPayload) => void

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

  'game:start': (payload: GameStartPayload, ack: AckFn<GameStartResult>) => void
  'game:move': (payload: GameMovePayload, ack: AckFn<GameMoveResult>) => void
  'game:requestSync': (payload: GameRequestSyncPayload, ack: AckFn<GameSyncResult>) => void
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
