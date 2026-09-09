import type { TransactionKind } from '../../contracts/enums.js'
import type { RewardRule } from '../entities/economy.js'

/**
 * ★ The earn caps — 10-economy-and-rewards.md §3.7, invariant E7.
 *
 * "Earning is capped and decaying, not linear." A grinder and a farmer are
 * distinguished by **rate**, not intent, and rate is the only one of the two a
 * server can measure. So this module answers one question with no I/O in it:
 *
 *     given what a holder has already earned, how much of this credit may land?
 *
 * It is a pure function on purpose. `WalletService` does the reading and the
 * writing; the policy — which constraint binds, and by how much — is decided
 * here, where a test can enumerate the boundary cases without a database and
 * where the numbers can be reasoned about against the spec table directly.
 *
 * The windows are **rolling**, not calendar. A cap that resets at a wall-clock
 * instant can be straddled: 2 000 coins at 23:50 and 2 000 more at 00:10 is
 * 4 000 coins in twenty minutes, which is precisely the rate the cap exists to
 * refuse. Same reasoning as the sliding-window rate limiter (S12), and the same
 * cost: "when do I earn again?" has a per-credit answer rather than a clock
 * time. The one calendar-keyed thing in the economy stays calendar-keyed — the
 * daily bonus, whose `daily:{holder}:{YYYY-MM-DD}` key *is* its once-a-day
 * guarantee.
 */

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

/**
 * The `RewardRule.id` the caps live on. A row with `gameSlug: null` (03 §3.9),
 * so it is not a game's rates but the platform's ceiling.
 */
export const GLOBAL_REWARD_RULE_ID = '_global'

/**
 * Which cap refused the coins. Stored verbatim in `WalletTransaction.reason`
 * (see {@link capReason}), so "why didn't I get coins?" is answerable from the
 * ledger row itself, in any language — these are machine codes, never prose.
 */
export const CAP_CODES = [
  'CAP_MATCHES_PER_DAY',
  'CAP_PER_HOUR',
  'CAP_PER_DAY',
  'CAP_PER_DAY_GUEST',
] as const
export type CapCode = (typeof CAP_CODES)[number]

/**
 * The kinds that count as *earning*.
 *
 * Everything else is exempt, and each exemption is a decision:
 *
 *   - `GUEST_VEST` **moves** coins between two wallets rather than minting
 *     them, and has its own bound (`guestVestCap`). Counting it against the
 *     daily cap would mean a guest who earned right up to the cap could not
 *     then keep their own coins.
 *   - `ADMIN_ADJUST` is an operator correcting a mistake. A cap that silently
 *     swallowed the correction would make the ledger less true, not more.
 *   - `REFUND` returns coins the holder already had.
 *   - `PURCHASE`/`GUEST_FORFEIT` are debits; a negative amount is not an earn.
 */
export const EARN_KINDS: readonly TransactionKind[] = [
  'MATCH_REWARD',
  'DAILY_BONUS',
  'ACHIEVEMENT',
  'PREMIUM_GRANT',
]

/** The subset that counts against `capMatchesPerDay` — matches, not bonuses. */
export const MATCH_KINDS: readonly TransactionKind[] = ['MATCH_REWARD']

export function isEarnKind(kind: TransactionKind): boolean {
  return EARN_KINDS.includes(kind)
}

/** The numbers, as they live in the `_global` `RewardRule` row (03 §3.9). */
export interface CapLimits {
  readonly perHour: number
  readonly perDay: number
  readonly perDayGuest: number
  readonly matchesPerDay: number
  readonly guestVestCap: number
}

/**
 * 10 §3.7's table, as code.
 *
 * These are the fallback for a database with no `_global` row — a fresh
 * developer database that has not been seeded, essentially. Falling back rather
 * than throwing is deliberate: an unseeded row must not make the *first* credit
 * of a new environment fail, and an uncapped economy is a worse failure than a
 * conservatively capped one. `RewardRule` is data (10 §3), so the seeded row
 * always wins.
 */
export const SPEC_CAP_LIMITS: CapLimits = {
  perHour: 400,
  perDay: 2_000,
  perDayGuest: 500,
  matchesPerDay: 30,
  guestVestCap: 500,
}

export function capLimitsFrom(rule: RewardRule | null): CapLimits {
  if (!rule) return SPEC_CAP_LIMITS
  return {
    perHour: rule.capPerHour,
    perDay: rule.capPerDay,
    perDayGuest: rule.capPerDayGuest,
    matchesPerDay: rule.capMatchesPerDay,
    guestVestCap: rule.guestVestCap,
  }
}

/** What the holder has already earned inside the two rolling windows. */
export interface CapUsage {
  readonly earnedLastHour: number
  readonly earnedLastDay: number
  readonly matchRewardsLastDay: number
}

export const NO_USAGE: CapUsage = { earnedLastHour: 0, earnedLastDay: 0, matchRewardsLastDay: 0 }

export interface CapInput {
  readonly requested: number
  readonly usage: CapUsage
  readonly limits: CapLimits
  /** A guest is additionally held to `perDayGuest` (10 §3.4). */
  readonly isGuest: boolean
  /** `MATCH_REWARD` only — a daily bonus is not a match. */
  readonly countsTowardMatchCap: boolean
  /**
   * Premium **raises** the hourly and daily ceilings; it never removes them
   * (E3, 10 §6.3). Applied here rather than to the reward itself so that the
   * multiplier is visible at exactly one place in the economy.
   */
  readonly multiplier?: number
}

export interface CapDecision {
  readonly requested: number
  /** What may actually be credited. `0` means a `CAP_REJECTED` audit row. */
  readonly amount: number
  /** The binding constraint, or `null` when nothing bound. */
  readonly code: CapCode | null
  /** Room left under the tightest constraint, before this credit. */
  readonly headroom: number
}

/**
 * Decides how much of `requested` may land.
 *
 * Partial capping is a real outcome and is *not* a rejection: 100 requested
 * against 30 of headroom credits 30 and records the cap code on the row. The
 * spec's zero case — nothing left at all — is what becomes a zero-amount
 * `CAP_REJECTED` row, because a reward silently not granted is
 * indistinguishable from a bug (10 §2.4).
 */
export function applyCaps(input: CapInput): CapDecision {
  const requested = Math.max(0, Math.trunc(input.requested))
  const multiplier = Math.max(0, input.multiplier ?? 1)
  const scale = (limit: number) => Math.floor(Math.max(0, limit) * multiplier)

  // Evaluated in order; the *tightest* headroom wins, first-wins on a tie. The
  // count cap comes first so that "you have played 30 matches today" is the
  // reason reported when it and a coin cap bind together — it is the one a
  // player can act on (they are done earning today, not in ten minutes).
  const constraints: Array<{ code: CapCode; headroom: number }> = []

  if (input.countsTowardMatchCap) {
    const left = input.limits.matchesPerDay - input.usage.matchRewardsLastDay
    constraints.push({
      code: 'CAP_MATCHES_PER_DAY',
      // A count cap is all-or-nothing: the 31st match earns nothing, it does
      // not earn a fraction.
      headroom: left > 0 ? Number.POSITIVE_INFINITY : 0,
    })
  }
  constraints.push({
    code: 'CAP_PER_HOUR',
    headroom: scale(input.limits.perHour) - input.usage.earnedLastHour,
  })
  constraints.push({
    code: 'CAP_PER_DAY',
    headroom: scale(input.limits.perDay) - input.usage.earnedLastDay,
  })
  if (input.isGuest) {
    constraints.push({
      code: 'CAP_PER_DAY_GUEST',
      // Not scaled: a guest cannot hold a subscription, so there is no
      // multiplier to apply and no route by which one could arrive.
      headroom: input.limits.perDayGuest - input.usage.earnedLastDay,
    })
  }

  let binding = constraints[0] as { code: CapCode; headroom: number }
  for (const candidate of constraints) {
    if (candidate.headroom < binding.headroom) binding = candidate
  }

  const headroom = Math.max(0, binding.headroom)
  if (headroom >= requested) {
    return { requested, amount: requested, code: null, headroom }
  }
  return { requested, amount: headroom, code: binding.code, headroom }
}

/**
 * The string written to `WalletTransaction.reason` — `CAP_PER_HOUR:120`.
 *
 * Two facts, both needed to explain the row and neither recoverable from it
 * otherwise: *which* cap bound, and what was originally earned. The credited
 * amount is the row's own `amount`, so a statement line can render
 * "earned 120, capped to 30, hourly limit" from the row alone.
 */
export function capReason(code: CapCode, requested: number): string {
  return `${code}:${Math.max(0, Math.trunc(requested))}`
}

/** The vesting bound is a cap too, and it lives on the same row (10 §3.4). */
export function vestableAmount(provisional: number, limits: CapLimits): number {
  return Math.max(0, Math.min(Math.trunc(provisional), limits.guestVestCap))
}
