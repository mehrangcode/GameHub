import { z } from 'zod'
import { InviteCodeSchema } from './auth.js'

/**
 * Invite wire shapes — 02 §5, 07 §5.2.
 *
 * Two audiences, two shapes, and the split is the security property:
 *
 *   - {@link InviteResponseSchema} answers the **host**, who minted the link
 *     and may see its usage and expiry.
 *   - {@link PublicInviteResponseSchema} answers **anyone holding the code**,
 *     with no authentication at all — that is what makes an invite link work in
 *     a private window (journey J1→J2). It therefore carries no email, no user
 *     id, no table id and no game state: only what a pre-join screen must
 *     render to ask "join as a guest?".
 */

export const CreateInviteRequestSchema = z
  .object({
    /** Defaults to `INVITE_TTL_HOURS`. Capped at 30 days. */
    expiresInHours: z.number().int().min(1).max(720).optional(),
    /** Null or omitted = unlimited within the table's seat capacity. */
    maxUses: z.number().int().min(1).max(100).nullable().optional(),
  })
  .strict()

export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>

/**
 * What the route validates. `"mint me a link, all defaults"` is the common
 * case, and `curl -X POST …/invites` with no body at all must work — under
 * Express 5 that leaves `req.body` undefined, which a bare `ZodObject` rejects.
 * The `.default({})` is what makes an absent body mean "defaults" instead of
 * "malformed request".
 */
export const CreateInviteBodySchema = CreateInviteRequestSchema.default({})

export const InviteCodeParamsSchema = z.object({ code: InviteCodeSchema })
export type InviteCodeParams = z.infer<typeof InviteCodeParamsSchema>

export const TableInviteCodeParamsSchema = z.object({
  id: z.string().min(1).max(64),
  code: InviteCodeSchema,
})

export type TableInviteCodeParams = z.infer<typeof TableInviteCodeParamsSchema>

/** The host's view of a link they minted. */
export const InviteResponseSchema = z.object({
  code: z.string(),
  /** The path to send a friend — the server owns the link shape, not the client. */
  joinPath: z.string(),
  expiresAt: z.string(),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
})

export type InviteResponse = z.infer<typeof InviteResponseSchema>

/**
 * ★ The unauthenticated pre-join payload (S43's screen).
 *
 * Everything here is something a person who already has the link can see by
 * opening it. Note what is *not* here: no `tableId` (a leaked code should not
 * also leak the table's identifier), no host user id, no member list, no
 * options — a stranger deciding whether to join needs the game, the host's
 * name, and whether there is room.
 */
export const PublicInviteResponseSchema = z.object({
  gameSlug: z.string(),
  /** i18n key, per 02 §8.1 — the pre-join screen is the first thing a guest reads. */
  gameNameKey: z.string(),
  hostDisplayName: z.string().nullable(),
  seatCount: z.number().int(),
  seatsFree: z.number().int(),
  /** The match has already started; joining means spectating, if that is allowed. */
  inProgress: z.boolean(),
  allowSpectators: z.boolean(),
  requireApproval: z.boolean(),
})

export type PublicInviteResponse = z.infer<typeof PublicInviteResponseSchema>

/**
 * ★ The **authenticated** counterpart to {@link PublicInviteResponseSchema} —
 * S43.
 *
 * A guest who opens an invite link gets their table from `POST /auth/guest`,
 * which returns a `redirectTo`. A signed-in user had no equivalent: the public
 * payload deliberately withholds `tableId` (a leaked code must not also leak
 * the table's identifier), so the only way for them to reach the table was to
 * become a guest — which would be absurd for somebody who already has an
 * account, and would strand their coins in a provisional wallet.
 *
 * `redirectTo` is the server's, for the same reason it is on the guest and
 * claim responses: the destination is decided by the request that resolved the
 * invite, never reconstructed by a client that could drift to a stale table.
 */
export const RedeemInviteResponseSchema = z.object({
  tableId: z.string(),
  redirectTo: z.string(),
  /**
   * True when the caller is already at this table, so the client can say
   * "rejoin" rather than "join". Informational only — nothing is gated on it,
   * and this route consumes no invite use either way.
   */
  alreadyMember: z.boolean(),
})

export type RedeemInviteResponse = z.infer<typeof RedeemInviteResponseSchema>
