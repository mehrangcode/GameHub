// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'

/**
 * Presence — S25, 04 §5.2.
 *
 * The point of this file is one badge: **"Sara reconnecting… 0:58"** instead of
 * a table that has silently frozen. A player whose phone drops out of signal
 * looks identical, from every other seat, to a player who is thinking — and the
 * difference decides whether the other three wait or give up on the evening.
 *
 * > **Two different timers, do not conflate them** (04 §5.2). *Disconnect
 * > grace* — this file — starts when the transport drops, and applies whether
 * > or not it is that seat's turn. The *turn timer* (S31) starts when it becomes
 * > a seat's turn and applies to a perfectly connected player who is simply not
 * > acting. Both can end in ejection; they carry different reward consequences
 * > (`EJECTED_ABANDON` vs `EJECTED_TIMEOUT`).
 */

export const PRESENCE_STATES = ['online', 'away', 'disconnected'] as const
export type PresenceState = (typeof PRESENCE_STATES)[number]
export const PresenceStateSchema = z.enum(PRESENCE_STATES)

/**
 * Client heartbeat cadence, in seconds (04 §3.1).
 *
 * In contracts because both ends need the same number: the client sends on this
 * interval and the server declares someone `away` after a small multiple of it.
 * Two independently-chosen constants would eventually disagree and produce a
 * table full of players who look absent while typing.
 */
export const PRESENCE_HEARTBEAT_SEC = 15

export const PresenceEntrySchema = z.object({
  memberId: z.string(),
  /** Null for a spectator, who still has presence but holds no seat. */
  seat: z.number().int().nullable(),
  state: PresenceStateSchema,
  /**
   * ISO 8601, present only while `disconnected`. **Absolute, not a duration**
   * (04 §5.4): the client renders the countdown from this minus the clock offset
   * it measured at handshake, so a device with a wrong system clock still shows
   * the true deadline — and that deadline can cost somebody their seat.
   */
  graceEndsAt: z.string().nullable(),
})

export type PresenceEntry = z.infer<typeof PresenceEntrySchema>
