import type { SeatOutcome } from '../../contracts/enums.js'
import type { RewardRule } from '../../domain/entities/economy.js'
import {
  durationFactor,
  placementMultiplier,
  repeatDecayMultiplier,
  rewardAmount,
  type RewardFactors,
} from '../../domain/economy/reward.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import { holderKey, type HolderKey, type IdentityRef } from '../../domain/value-objects/identity.js'
import { integrityFactorOf } from '../mappers/outcomes.js'

/**
 * ★ Reward policy — S35. 10-economy-and-rewards.md §3, invariants E3, E6, E7.
 *
 *     reward = round( base × placement × premium × integrity × repeatDecay × duration )
 *
 * The formula itself is six lines of arithmetic in `domain/economy/reward.ts`.
 * What lives here is the *policy* around it — which of those six numbers apply
 * to this seat, and why — plus the three that have to be looked up.
 *
 * ### {@link RewardService.compute} is static, and that is the point
 *
 * It takes a plain record and returns a plain record: no clock, no database, no
 * container, no instance state. That is what lets the whole of §3.2–3.6 be
 * checked against the document row for row
 * (`tests/unit/rewards/compute.test.ts`), and it is what keeps the reward rules
 * *outside* the engines — invariant I1 holds precisely because an engine has no
 * idea coins exist (10 §5.3). `GameEngine.result()` reports facts; this applies
 * policy to them.
 *
 * ### E3, structurally
 *
 * Premium enters as **one multiplier on earning**. It cannot reach gameplay
 * from here because the returned object contains nothing but numbers and an
 * i18n key — there is no field through which a subscription could buy a longer
 * timer, a better seat, or more information. `tests/unit/rewards/compute.test.ts`
 * asserts the key set, so widening it is a deliberate act in a diff rather than
 * a drift.
 *
 * ### Why a reward of zero always carries a reason
 *
 * An unexplained zero is indistinguishable from a bug, and a player who thinks
 * the economy is broken stops playing. Every path that pays nothing here —
 * an ineligible table, a missing rule, an ejection — sets `reasonKey`, which
 * travels to `game:rewardSettled`, into the `CAP_REJECTED` ledger row, and onto
 * the post-match screen (10 §5.2 rule 6, §11).
 */

/** 10 §6.1 — premium earns 1.5×. It buys rate, never advantage (E3). */
export const PREMIUM_EARN_MULTIPLIER = 1.5

/** §3.5's window: the same group meeting again inside half an hour decays. */
export const REPEAT_DECAY_WINDOW_MS = 30 * 60 * 1000

/**
 * i18n keys, never sentences — the client renders these in Persian without a
 * round-trip (02 §8.1). Closed set so a typo is a compile error.
 */
export const REWARD_REASON_KEYS = {
  tableIneligible: 'games.reward.tableIneligible',
  noRule: 'games.reward.noRule',
  forfeitedTimeout: 'games.reward.forfeitedTimeout',
  forfeitedAbandon: 'games.reward.forfeitedAbandon',
  bot: 'games.reward.bot',
  resigned: 'games.reward.resigned',
  returned: 'games.reward.returned',
} as const

export interface RewardInput {
  /** The rule row for this game, or `null` when none is configured. */
  readonly rule: RewardRule | null
  readonly seatCount: number
  readonly rank: number
  /** From `MatchResult.reason === 'DRAW'`, not from seats sharing a rank. */
  readonly isDraw: boolean
  readonly outcome: SeatOutcome
  /** 1.0 or {@link PREMIUM_EARN_MULTIPLIER}. Resolved by {@link premiumMultiplierFor}. */
  readonly premiumMultiplier: number
  /** 1-based, **including this match**. Resolved by {@link repeatIndexFor}. */
  readonly repeatIndex: number
  readonly durationMs: number
  /** §3.6's carve-out: a chess resignation, an all-fold poker hand. */
  readonly durationExempt: boolean
  /** `Table.rewardEligible` — false for an all-guest matchmade group (09 §7.2). */
  readonly rewardEligible: boolean
}

export interface RewardBreakdown {
  readonly amount: number
  readonly factors: RewardFactors
  /** Null when a full reward was earned; an i18n key whenever it was reduced. */
  readonly reasonKey: string | null
  /**
   * ★ The match paid, and **this seat alone** was zeroed — the rule that makes
   * `MatchParticipant.rewardForfeited` meaningful. False when nobody earned
   * anything (an ineligible table pays nobody, and that is not a forfeit).
   */
  readonly forfeited: boolean
}

export interface RewardServiceDeps {
  readonly repos: Repositories
  readonly now?: () => Date
}

export class RewardService {
  private readonly now: () => Date

  constructor(deps: RewardServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * ★ The formula — pure, static, and the same input always gives the same
   * output. 10 §3.1.
   *
   * The order of the guards is the policy:
   *
   * | Checked | Result | Why first |
   * |---|---|---|
   * | `rewardEligible: false` | 0, `tableIneligible` | The table never earned; nobody is being singled out, so this is not a forfeit |
   * | No rule row | 0, `noRule` | A misconfigured game must pay nothing *visibly* rather than pay a silent default |
   * | No placement cell | 0, `noRule` | Same reasoning: a rule that cannot price this table shape is a missing rule |
   * | Everything else | the product of six factors | — |
   */
  static compute(input: RewardInput): RewardBreakdown {
    const integrity = integrityFactorOf(input.outcome)

    if (!input.rewardEligible) {
      return zero(REWARD_REASON_KEYS.tableIneligible, integrity)
    }
    if (input.rule === null || input.rule.baseAmount <= 0) {
      return zero(REWARD_REASON_KEYS.noRule, integrity)
    }

    const placement = placementMultiplier({
      placement: input.rule.placement,
      seatCount: input.seatCount,
      rank: input.rank,
      isDraw: input.isDraw,
    })
    if (placement === null) {
      return zero(REWARD_REASON_KEYS.noRule, integrity)
    }

    const factors: RewardFactors = {
      base: input.rule.baseAmount,
      placement,
      premium: input.premiumMultiplier,
      integrity,
      repeatDecay: repeatDecayMultiplier(input.rule.repeatDecay, input.repeatIndex),
      duration: durationFactor(input.durationMs, input.rule.expectedMinMs, input.durationExempt),
    }

    /**
     * ★ What the seat *would* have earned, had it played clean.
     *
     * Computed so that "nothing was paid" and "something was taken away" can be
     * told apart: a forfeit is only a forfeit when there was a reward to lose,
     * and a seat that would have earned 0 anyway (a 30-second match, an
     * ineligible table) has not been punished. `MatchParticipant.rewardForfeited`
     * means the second thing, and the post-match screen says so out loud.
     */
    const clean = rewardAmount({ ...factors, integrity: 1 })
    const amount = rewardAmount(factors)

    return {
      amount,
      factors,
      reasonKey: integrity === 1 ? null : outcomeReasonKey(input.outcome),
      forfeited: integrity === 0 && clean > 0,
    }
  }

  // ── The three lookups `compute` deliberately does not do ──────────────────

  /**
   * The rate card for this game — `${slug}:${variant}` then `${slug}` (10 §3.2).
   *
   * The fallback lives in the repository so it cannot be implemented twice and
   * differently; this is here only so settlement reads one method.
   */
  async ruleFor(repos: Repositories, gameSlug: string, variant?: string): Promise<RewardRule | null> {
    return repos.rewardRules.findForGame(gameSlug, variant)
  }

  /**
   * 1.5× for a live subscription, 1.0 for everybody else — 10 §6.1.
   *
   * A **guest never earns the multiplier**: a subscription belongs to an
   * account, and there is no way to hold one without having signed up. That is
   * a one-line consequence of the identity union rather than a rule anyone has
   * to remember.
   *
   * `findActive` includes `PAST_DUE` inside its grace window (§6.3), so a
   * failed renewal does not cost somebody their rate mid-evening.
   */
  async premiumMultiplierFor(repos: Repositories, holder: IdentityRef): Promise<number> {
    if (holder.kind !== 'user') return 1
    const active = await repos.subscriptions.findActive(holder.userId, this.now())
    return active === null ? 1 : PREMIUM_EARN_MULTIPLIER
  }

  /**
   * ★ §3.5 — how many times **this exact set of people** has met in the last
   * thirty minutes, counting the match being settled.
   *
   * The signature is the set of human holders and **nothing else** — not the
   * game, not the table, not the seating. Four friends who finish a Shelem and
   * sit down to Poker are on their second matchup, which is §3.5 read literally
   * ("matching the same set of identities repeatedly") and is also the only
   * reading that cannot be gamed: keying by game would hand a farmer a bypass
   * so cheap it is an accident waiting to happen — alternate two games and
   * every match pays 1.0× forever.
   *
   * Honest play never reaches the tail. A real Shelem match runs 30–45 minutes,
   * so a group would have to finish three of them inside half an hour to see
   * 0.6×, which is not something four people can do by playing.
   *
   * Bots are excluded before the comparison: a bot is not an identity, and
   * three friends plus a bot are the same matchup as three friends plus a
   * different bot.
   */
  async repeatIndexFor(repos: Repositories, holders: readonly IdentityRef[]): Promise<number> {
    const probe = holders[0]
    if (probe === undefined) return 1

    const wanted = signatureOf(holders)
    const since = new Date(this.now().getTime() - REPEAT_DECAY_WINDOW_MS)
    const recent = await repos.matchResults.listRecentHolderSetsFor(probe, since)

    const priorMeetings = recent.filter((keys) => sortedJoin(keys) === wanted).length
    return priorMeetings + 1
  }
}

/**
 * A reduced reward, explained. `KICKED` and `COMPLETED` never reach here.
 *
 * `RESIGNED` and `REPLACED_RETURNED` still pay (0.25× and 0.5×), so their keys
 * describe a *partial* reward — the post-match screen needs to say "you
 * resigned, so you earned a quarter", not "you earned nothing".
 */
function outcomeReasonKey(outcome: SeatOutcome): string {
  switch (outcome) {
    case 'EJECTED_TIMEOUT':
      return REWARD_REASON_KEYS.forfeitedTimeout
    case 'EJECTED_ABANDON':
      return REWARD_REASON_KEYS.forfeitedAbandon
    case 'BOT':
      return REWARD_REASON_KEYS.bot
    case 'RESIGNED':
      return REWARD_REASON_KEYS.resigned
    case 'REPLACED_RETURNED':
      return REWARD_REASON_KEYS.returned
    default:
      return REWARD_REASON_KEYS.noRule
  }
}

/** Zero, with the factors still reported so §11's breakdown can show the line. */
function zero(reasonKey: string, integrity: number): RewardBreakdown {
  return {
    amount: 0,
    factors: { base: 0, placement: 0, premium: 1, integrity, repeatDecay: 1, duration: 1 },
    reasonKey,
    forfeited: false,
  }
}

function signatureOf(holders: readonly IdentityRef[]): string {
  return sortedJoin(holders.map((holder) => holderKey(holder)))
}

/** Order-independent by construction: a matchup is a set, not a seating. */
function sortedJoin(keys: readonly HolderKey[] | readonly string[]): string {
  return [...new Set(keys)].sort().join('|')
}
