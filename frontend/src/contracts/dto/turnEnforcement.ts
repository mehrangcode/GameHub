// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'

/**
 * ★ Turn enforcement, as a **table option** — S31–S34, 04 §6.3.
 *
 * ### Why this is not part of a game's `optionsSchema`
 *
 * These four values are platform policy, not game rules: "how long may you
 * think" is the engine's to declare (`GameMeta.turnTimeoutMs`), but "how many
 * lapses before you lose the seat" is the *table's* to decide, and it means the
 * same thing in Shelem as it does in Poker. Putting it in each engine's strict
 * `optionsSchema` would copy the same four fields six times and let them drift;
 * putting it *inside* `Table.optionsJson` would change the shape of what a game
 * validates and what `GET /tables/:id` has always returned. So it gets its own
 * column (`Table.turnEnforcementJson`) and its own schema, here.
 *
 * ### The one number Mehrang asked about
 *
 * `ejectAfterStrikes` defaults to **2**, not 1, and 04 §6.3 argues the case: a
 * single 30-second lapse — a doorbell, a tunnel — would otherwise eject someone
 * from a 45-minute Shelem match and forfeit their coins, which is harsh enough
 * to make people avoid the long games. Two strikes still removes a genuinely
 * absent player inside about a minute.
 *
 * The literal rule is one field away: `{ "ejectAfterStrikes": 1 }` on the table.
 * Both paths have tests.
 */
export const TurnEnforcementSchema = z
  .object({
    /**
     * Consecutive timeouts before the seat is ejected and bot-substituted.
     * `1` is the strict rule; `2` is the default and the spec's recommendation.
     */
    ejectAfterStrikes: z.number().int().min(1).max(5).default(2),
    /**
     * How long before the deadline the acting seat is warned. `0` disables the
     * warning — the strike then arrives with no notice, which is a legitimate
     * choice for a blitz table and a bad one for anything else.
     */
    warningSeconds: z.number().int().min(0).max(30).default(10),
    /**
     * ★ Any action clears the count, so strikes measure *current* absence
     * rather than a lifetime record. A player who lapses once and then plays
     * ten tricks cleanly should not be ejected by a second lapse twenty minutes
     * later.
     */
    strikesResetOnAction: z.boolean().default(true),
    /**
     * How long an ejected seat stays reclaimable (`game:reclaimSeat`). `0`
     * means the bot keeps the seat the moment it takes it.
     */
    reclaimWindowSec: z.number().int().min(0).max(600).default(120),
  })
  .strict()

export type TurnEnforcement = z.infer<typeof TurnEnforcementSchema>

/**
 * What a table gets when it says nothing — the values 04 §6.3 recommends.
 *
 * Written as a literal rather than as `TurnEnforcementSchema.parse({})`,
 * because `contracts/` is a *declaration* directory: no functions, no classes,
 * nothing executed at import time (S01, and
 * `tests/unit/contracts-purity.test.ts` enforces it). The literal and the
 * schema's own defaults are pinned to each other by a test, so they cannot
 * drift apart.
 */
export const DEFAULT_TURN_ENFORCEMENT: TurnEnforcement = {
  ejectAfterStrikes: 2,
  warningSeconds: 10,
  strikesResetOnAction: true,
  reclaimWindowSec: 120,
}
