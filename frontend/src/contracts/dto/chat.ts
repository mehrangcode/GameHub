// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'
import { ChatMessageKindSchema, IdentityKindSchema } from '../enums.js'

/**
 * Chat wire shapes — S26, 03 §3.4, 04 §3.
 *
 * ★ **A `SYSTEM` message stores an i18n key and a params object, never English
 * prose.** "Sara took seat 2" is not a sentence the server is allowed to
 * compose: one row has to render in Persian for a Persian reader and in English
 * for an English one, from the same bytes, months later. So the row holds
 * `table.system.seatTaken` + `{ name: 'Sara', seat: 2 }` and the client owns the
 * wording.
 *
 * There is a test that enforces this by shape rather than by review: every
 * `SYSTEM` body must match {@link I18N_KEY_PATTERN}, which no English sentence
 * can (it forbids whitespace).
 */

/**
 * A dotted lowercase-rooted key: `table.system.seatTaken`, `chat.redacted`.
 *
 * Anchored, and with no `\s` allowed anywhere — that single property is what
 * makes "did somebody put a sentence in here?" a machine-checkable question.
 */
export const I18N_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/

export const I18nKeySchema = z.string().regex(I18N_KEY_PATTERN, 'errors.i18nKeyExpected')

/**
 * The upper bound on a chat body.
 *
 * Lives in contracts because the composer in S44 must refuse the 501st
 * character rather than let the socket do it — a message the server drops after
 * you typed it is a worse experience than a counter that stops you.
 */
export const CHAT_BODY_MAX = 500
export const EMOTE_ID_MAX = 40

/** How many past messages a joiner's `table:snapshot` carries (04 §3.2). */
export const CHAT_HISTORY_LIMIT = 50

// ── Author ───────────────────────────────────────────────────────────────────

/**
 * Who said it, as everyone at the table may see it.
 *
 * Same rule as `OccupantView`: a display name and a seat, never a `userId` or a
 * `guestSessionId`. A transcript is shown to spectators and to anyone holding
 * the invite link, so it is the wrong place to hand out account identifiers.
 */
export const ChatAuthorSchema = z.object({
  kind: z.union([IdentityKindSchema, z.literal('bot'), z.literal('system')]),
  /** Null for `system`, and for an author whose row has since been swept. */
  displayName: z.string().nullable(),
  /** Where they were sitting when they said it, or null for a spectator. */
  seat: z.number().int().nullable(),
  /** True for the reader's own messages — the client aligns them differently. */
  isSelf: z.boolean(),
})

export type ChatAuthor = z.infer<typeof ChatAuthorSchema>

// ── Messages ─────────────────────────────────────────────────────────────────

export const ChatMessageViewSchema = z.object({
  id: z.string(),
  tableId: z.string(),
  kind: ChatMessageKindSchema,
  author: ChatAuthorSchema,
  /**
   * `TEXT` → the (filtered) body. `EMOTE` → the emote id. `SYSTEM` → an i18n
   * key. **Null** when `redactedAt` is set: a moderated message leaves its row
   * and its place in the conversation behind, and nothing else.
   */
  body: z.string().nullable(),
  /** Interpolation values for a `SYSTEM` key. Null for everything else. */
  params: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  redactedAt: z.string().nullable(),
})

export type ChatMessageView = z.infer<typeof ChatMessageViewSchema>

/**
 * The i18n keys the server itself emits.
 *
 * Declared as a closed set rather than assembled from string fragments at the
 * call sites, so "which strings does the client have to translate?" is answered
 * by reading one array — and so a typo is a compile error rather than a message
 * that renders as its own key in production.
 */
export const SYSTEM_MESSAGE_KEYS = {
  memberJoined: 'table.system.memberJoined',
  memberLeft: 'table.system.memberLeft',
  seatTaken: 'table.system.seatTaken',
  seatReleased: 'table.system.seatReleased',
  botAdded: 'table.system.botAdded',
  botRemoved: 'table.system.botRemoved',
  playerKicked: 'table.system.playerKicked',
  optionsChanged: 'table.system.optionsChanged',
  playerDisconnected: 'table.system.playerDisconnected',
  playerReconnected: 'table.system.playerReconnected',
  gameStarted: 'table.system.gameStarted',
  gameFinished: 'table.system.gameFinished',
  /** Phase H. The transcript is where "why is a bot playing seat 1?" is answered. */
  playerEjected: 'table.system.playerEjected',
  playerReturned: 'table.system.playerReturned',
} as const

export type SystemMessageKey = (typeof SYSTEM_MESSAGE_KEYS)[keyof typeof SYSTEM_MESSAGE_KEYS]
