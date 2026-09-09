import { z } from 'zod'
import {
  BotDifficultySchema,
  IdentityKindSchema,
  MemberRoleSchema,
  TableOriginSchema,
  TableStatusSchema,
} from '../enums.js'
import { PresenceStateSchema } from './presence.js'

/**
 * Table wire shapes — 02 §5 `/tables`, 03 §3.2.
 *
 * ★ **No game state appears anywhere in this file, and that is a transport
 * rule, not an oversight** (02 §3.1). REST carries the table's *lifecycle*
 * before play — who is sitting where, which game, which options. Cards, hands,
 * turn order, legal moves and the board travel over the socket, projected once
 * per viewer, because that is the only path with a `projectState` boundary on
 * it. An integration test asserts the detail response carries no state keys, so
 * the rule cannot erode one convenient field at a time.
 */

// ── Requests ─────────────────────────────────────────────────────────────────

export const CreateTableRequestSchema = z
  .object({
    gameSlug: z.string().min(2).max(32),
    /** Must be one of the game's own `playableCounts` — checked server-side. */
    seatCount: z.number().int().min(1).max(10),
    /** Parsed by the engine's `optionsSchema`; omitted means "the defaults". */
    options: z.record(z.unknown()).optional(),
    allowSpectators: z.boolean().optional(),
    /** Defence for a leaked link: the host approves each join. */
    requireApproval: z.boolean().optional(),
  })
  .strict()

export type CreateTableRequest = z.infer<typeof CreateTableRequestSchema>

/**
 * `PATCH /tables/:id` — host only, `WAITING` only.
 *
 * `gameSlug` is absent on purpose: changing the game of an existing table is
 * not an edit, it is a different table. `.refine` rejects an empty patch rather
 * than treating "change nothing" as success, which would hide a client bug that
 * sends the wrong field name.
 */
export const PatchTableRequestSchema = z
  .object({
    seatCount: z.number().int().min(1).max(10).optional(),
    options: z.record(z.unknown()).optional(),
    allowSpectators: z.boolean().optional(),
    requireApproval: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'errors.emptyPatch')

export type PatchTableRequest = z.infer<typeof PatchTableRequestSchema>

export const TableIdParamsSchema = z.object({ id: z.string().min(1).max(64) })
export type TableIdParams = z.infer<typeof TableIdParamsSchema>

/** Seat claim. The seat is in the path for `DELETE`, in the body for `POST`. */
export const ClaimSeatRequestSchema = z
  .object({
    seat: z.number().int().min(0).max(9),
    /** Only meaningful to a host filling an empty seat. */
    asBot: BotDifficultySchema.optional(),
  })
  .strict()

export type ClaimSeatRequest = z.infer<typeof ClaimSeatRequestSchema>

// ── Responses ────────────────────────────────────────────────────────────────

/**
 * Who holds a seat, as everyone at the table may see it.
 *
 * Carries a display name and nothing else identifying — no `userId`, no
 * `guestSessionId`, no email. A seat map is shown to spectators and to anyone
 * holding the invite link, so it is the wrong place to hand out account
 * identifiers; "which seat is mine?" is answered by `isSelf` instead.
 */
export const OccupantViewSchema = z.object({
  kind: z.union([IdentityKindSchema, z.literal('bot')]),
  /** Null only for a bot, which renders from `botDifficulty` and an i18n key. */
  displayName: z.string().nullable(),
  avatarRef: z.string().nullable(),
  botDifficulty: BotDifficultySchema.nullable(),
})

export type OccupantView = z.infer<typeof OccupantViewSchema>

export const SeatViewSchema = z.object({
  seat: z.number().int(),
  /** Null when the seat is empty — which is what the "sit here" button binds to. */
  memberId: z.string().nullable(),
  occupant: OccupantViewSchema.nullable(),
  /** Partnership games only: Shelem's `seat % 2`. */
  team: z.number().int().nullable(),
  role: MemberRoleSchema,
  /** True for the caller's own seat. Replaces handing out ids. */
  isSelf: z.boolean(),
  /** ISO 8601, null when empty. */
  joinedAt: z.string().nullable(),
  /** A bot is holding this seat for an ejected human who may still reclaim it. */
  botSubstituted: z.boolean(),
})

export type SeatView = z.infer<typeof SeatViewSchema>

/**
 * A member of the table, seated or not — S24, the `members[]` of
 * `table:snapshot` (04 §3.2).
 *
 * Distinct from {@link SeatViewSchema}, which is indexed by *seat* and always
 * has exactly `seatCount` entries so the "sit here" buttons have something to
 * bind to. This is indexed by *person*, so it can carry the spectators — who
 * have no seat and would otherwise be invisible to everything except a count.
 *
 * `presence` rides along because a seat map without it is the frozen-table bug:
 * a disconnected player and a thinking player render identically.
 */
export const MemberViewSchema = z.object({
  memberId: z.string(),
  /** Null for a spectator. */
  seat: z.number().int().nullable(),
  role: MemberRoleSchema,
  team: z.number().int().nullable(),
  occupant: OccupantViewSchema,
  isSelf: z.boolean(),
  joinedAt: z.string(),
  botSubstituted: z.boolean(),
  presence: PresenceStateSchema,
  /** ISO 8601; present only while `disconnected`. Absolute, never a duration. */
  graceEndsAt: z.string().nullable(),
})

export type MemberView = z.infer<typeof MemberViewSchema>

/** One row in the "resume" list. */
export const TableSummarySchema = z.object({
  id: z.string(),
  gameSlug: z.string(),
  status: TableStatusSchema,
  origin: TableOriginSchema,
  seatCount: z.number().int(),
  seatsTaken: z.number().int(),
  isHost: z.boolean(),
  /** The caller's seat, or null if they are a spectator or not seated. */
  mySeat: z.number().int().nullable(),
  rewardEligible: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
})

export type TableSummary = z.infer<typeof TableSummarySchema>

export const TableDetailSchema = TableSummarySchema.extend({
  hostDisplayName: z.string().nullable(),
  /** Stored, post-parse options — defaults filled in, so what you see is what plays. */
  options: z.record(z.unknown()),
  allowSpectators: z.boolean(),
  requireApproval: z.boolean(),
  /** Exactly `seatCount` entries, index-aligned to `seat`. */
  seats: z.array(SeatViewSchema),
  spectatorCount: z.number().int(),
})

export type TableDetail = z.infer<typeof TableDetailSchema>
