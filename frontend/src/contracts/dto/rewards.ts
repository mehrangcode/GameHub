// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'
import { AssetCodeSchema, SeatOutcomeSchema } from '../enums.js'

/**
 * ★ `GET /rewards/rules` — **public**, and deliberately so (10 §11).
 *
 * An opaque economy invites accusations of rigging. Publishing the formula
 * makes the caps and the decay curve defensible, makes forfeiture read as a
 * rule rather than a punishment, and makes a support question answerable by
 * pointing at a number instead of by taking somebody's word for it.
 *
 * ### What is published, and what is not
 *
 * Published: every factor a player's own reward is multiplied by — the base
 * rate, the placement table, the decay curve, the duration expectation, the
 * per-outcome integrity multipliers, the premium rate and the earn caps. All of
 * these appear in the document already, and a player can reproduce their own
 * payout from this payload alone.
 *
 * Not published: `guestVestCap`. It is not a *rate* — it is the bound on how
 * much a farming run is worth (10 §3.4), and the only thing telling a stranger
 * its exact value changes is how efficiently they can run up to it.
 *
 * No authentication, because the welcome page should be able to say "Shelem
 * pays the most" before anybody signs up.
 */

export const RewardRuleDtoSchema = z.object({
  /** `shelem`, `chess:rapid`, … — the rate card's own id. */
  id: z.string(),
  gameSlug: z.string().nullable(),
  asset: AssetCodeSchema,
  base: z.number().int().nonnegative(),
  /** `{ draw: 1, bySeatCount: { '4': { '1': 1.5, … } } }` — 10 §3.3. */
  placement: z.object({
    draw: z.number(),
    bySeatCount: z.record(z.string(), z.record(z.string(), z.number())),
  }),
  /** Below this, `durationFactor` scales the reward down proportionally (§3.6). */
  expectedMinMs: z.number().int().nonnegative(),
  /** §3.5's curve, index 1 first. The tail value repeats forever. */
  repeatDecay: z.array(z.number()),
})

export type RewardRuleDto = z.infer<typeof RewardRuleDtoSchema>

export const RewardCapsSchema = z.object({
  perHour: z.number().int().nonnegative(),
  perDay: z.number().int().nonnegative(),
  perDayGuest: z.number().int().nonnegative(),
  matchesPerDay: z.number().int().nonnegative(),
  /** §3.5's window in milliseconds — what "the same matchup again" means. */
  repeatWindowMs: z.number().int().nonnegative(),
})

export type RewardCapsDto = z.infer<typeof RewardCapsSchema>

export const RewardRulesResponseSchema = z.object({
  rules: z.array(RewardRuleDtoSchema),
  caps: RewardCapsSchema,
  /**
   * 10 §6.1. Published because E3 is a *promise*: premium multiplies earning by
   * exactly this and touches nothing else, and a number anybody can check is
   * worth more than a paragraph saying so.
   */
  premiumMultiplier: z.number(),
  /**
   * ★ 10 §5.1 — what each outcome is worth. This is the table that makes
   * "you were removed for inactivity, so you earned nothing" a published rule
   * the player could have read beforehand, rather than a surprise.
   */
  integrityFactors: z.record(SeatOutcomeSchema, z.number()),
})

export type RewardRulesResponse = z.infer<typeof RewardRulesResponseSchema>
