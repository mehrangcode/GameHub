import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  HOUR_MS,
  SPEC_CAP_LIMITS,
  applyCaps,
  capLimitsFrom,
  capReason,
  isEarnKind,
  vestableAmount,
  type CapLimits,
  type CapUsage,
} from '../../../src/domain/economy/caps.js'
import type { RewardRule } from '../../../src/domain/entities/economy.js'

/**
 * The cap policy, tested as what it is: a pure function.
 *
 * No database, no service, no clock. That is the whole reason `applyCaps` lives
 * in `domain/economy/` rather than inside `WalletService` — the interesting
 * cases here are boundaries (exactly at the cap, one over, several caps binding
 * at once) and every one of them would otherwise need rows written at
 * controlled times.
 */

const usage = (patch: Partial<CapUsage> = {}): CapUsage => ({
  earnedLastHour: 0,
  earnedLastDay: 0,
  matchRewardsLastDay: 0,
  ...patch,
})

const reward = (patch: Partial<Parameters<typeof applyCaps>[0]> = {}) =>
  applyCaps({
    requested: 100,
    usage: usage(),
    limits: SPEC_CAP_LIMITS,
    isGuest: false,
    countsTowardMatchCap: true,
    ...patch,
  })

describe('applyCaps — 10 §3.7, E7', () => {
  it('the spec table is the default', () => {
    expect(SPEC_CAP_LIMITS).toEqual({
      perHour: 400,
      perDay: 2_000,
      perDayGuest: 500,
      matchesPerDay: 30,
      guestVestCap: 500,
    })
  })

  it('an unused holder earns the full amount, with no cap code', () => {
    const decision = reward()
    expect(decision.amount).toBe(100)
    expect(decision.code).toBeNull()
  })

  it('★ partial capping credits what fits, and says which cap bound', () => {
    // 370 earned this hour, 400 allowed, 100 requested → 30 lands.
    const decision = reward({ usage: usage({ earnedLastHour: 370, earnedLastDay: 370 }) })

    expect(decision.amount).toBe(30)
    expect(decision.code).toBe('CAP_PER_HOUR')
    expect(decision.requested).toBe(100)
  })

  it('★ a full cap returns zero — the CAP_REJECTED case', () => {
    const decision = reward({ usage: usage({ earnedLastHour: 400, earnedLastDay: 400 }) })
    expect(decision.amount).toBe(0)
    expect(decision.code).toBe('CAP_PER_HOUR')
  })

  it('exactly at the cap is allowed; one coin past it is not', () => {
    expect(reward({ requested: 30, usage: usage({ earnedLastHour: 370 }) }).amount).toBe(30)
    expect(reward({ requested: 31, usage: usage({ earnedLastHour: 370 }) }).code).toBe(
      'CAP_PER_HOUR',
    )
  })

  it('the daily cap binds even when the hour is quiet', () => {
    const decision = reward({
      requested: 200,
      usage: usage({ earnedLastHour: 0, earnedLastDay: 1_950 }),
    })
    expect(decision.amount).toBe(50)
    expect(decision.code).toBe('CAP_PER_DAY')
  })

  it('★ the tightest constraint wins when several bind', () => {
    const decision = reward({
      requested: 300,
      usage: usage({ earnedLastHour: 300, earnedLastDay: 1_900 }),
    })
    // hourly headroom 100, daily headroom 100 → 100 either way; the reported
    // code is deterministic (declared order), which is what makes the reason
    // on the row stable across runs.
    expect(decision.amount).toBe(100)
    expect(decision.code).toBe('CAP_PER_HOUR')
  })

  it('★ the 31st match of the day earns nothing at all, not a fraction', () => {
    const decision = reward({ usage: usage({ matchRewardsLastDay: 30 }) })
    expect(decision.amount).toBe(0)
    expect(decision.code).toBe('CAP_MATCHES_PER_DAY')
  })

  it('the match count cap ignores non-match credits', () => {
    const decision = reward({
      countsTowardMatchCap: false,
      usage: usage({ matchRewardsLastDay: 99 }),
    })
    // A daily bonus is still payable after 30 matches: rewards stop, play (and
    // the rest of the economy) continues.
    expect(decision.amount).toBe(100)
    expect(decision.code).toBeNull()
  })

  it('★ a guest is held to the tighter guest daily cap', () => {
    const asUser = reward({ requested: 200, usage: usage({ earnedLastDay: 450 }) })
    const asGuest = reward({ requested: 200, usage: usage({ earnedLastDay: 450 }), isGuest: true })

    expect(asUser.amount).toBe(200)
    expect(asGuest.amount).toBe(50)
    expect(asGuest.code).toBe('CAP_PER_DAY_GUEST')
  })

  it('premium raises the ceilings and never removes them', () => {
    const doubled = reward({ requested: 500, usage: usage({ earnedLastHour: 300 }), multiplier: 2 })
    expect(doubled.amount).toBe(500) // 800 hourly ceiling, 300 spent

    const stillCapped = reward({
      requested: 500,
      usage: usage({ earnedLastHour: 800 }),
      multiplier: 2,
    })
    // E3: a subscription buys rate, never immunity.
    expect(stillCapped.amount).toBe(0)
    expect(stillCapped.code).toBe('CAP_PER_HOUR')
  })

  it('a guest cap is not scaled by a multiplier — guests hold no subscription', () => {
    const decision = reward({
      requested: 500,
      usage: usage({ earnedLastDay: 500 }),
      isGuest: true,
      multiplier: 4,
    })
    expect(decision.amount).toBe(0)
    expect(decision.code).toBe('CAP_PER_DAY_GUEST')
  })

  it('over-spent windows never produce a negative credit', () => {
    // A cap lowered by an operator while a holder is above it: headroom is
    // negative, and the answer is 0, not −100.
    const decision = reward({ usage: usage({ earnedLastHour: 900, earnedLastDay: 900 }) })
    expect(decision.amount).toBe(0)
    expect(decision.headroom).toBe(0)
  })

  it('truncates a fractional request rather than crediting a fraction of a coin', () => {
    expect(reward({ requested: 12.7 }).amount).toBe(12)
  })

  it('the windows are the documented lengths', () => {
    expect(HOUR_MS).toBe(3_600_000)
    expect(DAY_MS).toBe(86_400_000)
  })
})

describe('capReason — what lands in WalletTransaction.reason', () => {
  it('carries the code and the amount that was earned', () => {
    // Machine-readable, no English: the statement renders it in the reader's
    // language (02 §8.1), and the credited amount is the row's own `amount`.
    expect(capReason('CAP_PER_HOUR', 120)).toBe('CAP_PER_HOUR:120')
  })
})

describe('capLimitsFrom — the caps are data, not code (10 §3)', () => {
  const rule = (patch: Partial<RewardRule>): RewardRule => ({
    id: '_global',
    gameSlug: null,
    assetCode: 'COIN',
    baseAmount: 0,
    placement: { draw: 1, bySeatCount: {} },
    expectedMinMs: 0,
    repeatDecay: [1],
    capPerHour: 400,
    capPerDay: 2_000,
    capPerDayGuest: 500,
    capMatchesPerDay: 30,
    guestVestCap: 500,
    active: true,
    updatedAt: new Date(),
    ...patch,
  })

  it('reads every cap off the row, so rebalancing is an UPDATE', () => {
    const limits: CapLimits = capLimitsFrom(rule({ capPerHour: 999, guestVestCap: 42 }))
    expect(limits.perHour).toBe(999)
    expect(limits.guestVestCap).toBe(42)
  })

  it('★ falls back to the spec table when the _global row is missing', () => {
    // An unseeded developer database must not make the first credit fail — and
    // an uncapped economy is the worse of the two failures.
    expect(capLimitsFrom(null)).toEqual(SPEC_CAP_LIMITS)
  })
})

describe('vestableAmount — 10 §3.4', () => {
  it('vests everything below the cap', () => {
    expect(vestableAmount(120, SPEC_CAP_LIMITS)).toBe(120)
  })

  it('★ caps a farming run at 500', () => {
    expect(vestableAmount(900, SPEC_CAP_LIMITS)).toBe(500)
  })

  it('is exactly the cap at the boundary, and never negative', () => {
    expect(vestableAmount(500, SPEC_CAP_LIMITS)).toBe(500)
    expect(vestableAmount(0, SPEC_CAP_LIMITS)).toBe(0)
    expect(vestableAmount(-10, SPEC_CAP_LIMITS)).toBe(0)
  })
})

describe('isEarnKind — which kinds the caps apply to', () => {
  it('counts the four ways coins are minted', () => {
    for (const kind of ['MATCH_REWARD', 'DAILY_BONUS', 'ACHIEVEMENT', 'PREMIUM_GRANT'] as const) {
      expect(isEarnKind(kind)).toBe(true)
    }
  })

  it('★ exempts the kinds a cap would make the ledger less true', () => {
    // GUEST_VEST moves coins between wallets; ADMIN_ADJUST is an operator
    // fixing a mistake; REFUND returns coins the holder already had.
    for (const kind of ['GUEST_VEST', 'ADMIN_ADJUST', 'REFUND', 'CAP_REJECTED'] as const) {
      expect(isEarnKind(kind)).toBe(false)
    }
  })
})
