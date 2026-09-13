import type { RewardRulesResponse, RewardRuleDto } from '../../contracts/dto/rewards.js'
import { SEAT_OUTCOMES, type SeatOutcome } from '../../contracts/enums.js'
import { GLOBAL_REWARD_RULE_ID, capLimitsFrom } from '../../domain/economy/caps.js'
import type { RewardRule } from '../../domain/entities/economy.js'
import { integrityFactorOf } from './outcomes.js'
import { PREMIUM_EARN_MULTIPLIER, REPEAT_DECAY_WINDOW_MS } from '../services/RewardService.js'

/**
 * Rate cards → the public payload — 10 §11.
 *
 * Fields are listed by hand, as everywhere else in `mappers/`, and here the
 * habit earns its keep twice over: a `RewardRule` row carries `guestVestCap`
 * and per-row cap columns that have no business in a public response, and a
 * spread would publish them the day somebody adds another.
 *
 * The `_global` row is filtered out of `rules` rather than rendered as a game
 * with a base of 0 — it is the caps, and they are reported under `caps` where
 * they mean something.
 */

export function toRewardRuleDto(rule: RewardRule): RewardRuleDto {
  return {
    id: rule.id,
    gameSlug: rule.gameSlug,
    asset: rule.assetCode,
    base: rule.baseAmount,
    placement: { draw: rule.placement.draw, bySeatCount: rule.placement.bySeatCount },
    expectedMinMs: rule.expectedMinMs,
    repeatDecay: [...rule.repeatDecay],
  }
}

export function toRewardRulesResponse(rules: readonly RewardRule[]): RewardRulesResponse {
  const limits = capLimitsFrom(rules.find((rule) => rule.id === GLOBAL_REWARD_RULE_ID) ?? null)

  return {
    rules: rules.filter((rule) => rule.id !== GLOBAL_REWARD_RULE_ID).map(toRewardRuleDto),
    caps: {
      perHour: limits.perHour,
      perDay: limits.perDay,
      perDayGuest: limits.perDayGuest,
      matchesPerDay: limits.matchesPerDay,
      repeatWindowMs: REPEAT_DECAY_WINDOW_MS,
    },
    premiumMultiplier: PREMIUM_EARN_MULTIPLIER,
    integrityFactors: Object.fromEntries(
      SEAT_OUTCOMES.map((outcome: SeatOutcome) => [outcome, integrityFactorOf(outcome)]),
    ) as Record<SeatOutcome, number>,
  }
}
