import { describe, expect, it } from 'vitest'
import type { SeatOutcome } from '../../../src/contracts/enums.js'
import type { RewardRule } from '../../../src/domain/entities/economy.js'
import {
  PREMIUM_EARN_MULTIPLIER,
  REWARD_REASON_KEYS,
  RewardService,
  type RewardInput,
} from '../../../src/application/services/RewardService.js'

/**
 * ★ S35 — the reward formula, checked against 10-economy-and-rewards.md itself.
 *
 * The names below are written to mirror §3.2–3.6 row for row, so the document
 * and this test list can be read side by side. Two properties are being pinned:
 *
 *   1. **Every number matches the spec.** Not "looks reasonable" — the exact
 *      cell of the exact table, including the ones that pay *less*, because a
 *      quietly generous multiplier is how an economy inflates unnoticed.
 *   2. **The function is pure.** There is no database in this file, no
 *      container, no clock and no `beforeEach`. That is not a convenience: it
 *      is the proof that reward policy lives outside the engines (10 §5.3), and
 *      therefore that invariant I1 still holds.
 */

// ── The seeded rate cards, verbatim from prisma/seed.ts ─────────────────────

const HEAD_TO_HEAD = { '2': { '1': 1.5, '2': 0.6 } }
const FOUR_SEAT = { '4': { '1': 1.5, '2': 1.0, '3': 0.7, '4': 0.5 } }
const SIX_SEAT = {
  '6': { '1': 1.5, '2': 1.1, '3': 0.9, '4': 0.7, '5': 0.5, '6': 0.5 },
}

const MINUTE = 60_000

function rule(overrides: Partial<RewardRule> = {}): RewardRule {
  return {
    id: 'shelem',
    gameSlug: 'shelem',
    assetCode: 'COIN',
    baseAmount: 80,
    placement: { draw: 1, bySeatCount: { ...HEAD_TO_HEAD, ...FOUR_SEAT, ...SIX_SEAT } },
    expectedMinMs: 8 * MINUTE,
    repeatDecay: [1, 1, 0.6, 0.3, 0.1],
    capPerHour: 400,
    capPerDay: 2_000,
    capPerDayGuest: 500,
    capMatchesPerDay: 30,
    guestVestCap: 500,
    active: true,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

/** A clean 4-seat Shelem win at full duration — the baseline every case bends. */
function input(overrides: Partial<RewardInput> = {}): RewardInput {
  return {
    rule: rule(),
    seatCount: 4,
    rank: 1,
    isDraw: false,
    outcome: 'COMPLETED',
    premiumMultiplier: 1,
    repeatIndex: 1,
    durationMs: 45 * MINUTE,
    durationExempt: false,
    rewardEligible: true,
    ...overrides,
  }
}

const compute = RewardService.compute

// ───────────────────────────────────────────────────────────────────────────

describe('§3.2 base rates', () => {
  it.each([
    ['sudoku (solo)', 10, { '1': { '1': 1.0 } }, 1, 10],
    ['sudoku (race)', 20, FOUR_SEAT, 4, 30],
    ['blackjack', 25, FOUR_SEAT, 4, 38],
    ['chess (blitz)', 30, HEAD_TO_HEAD, 2, 45],
    ['chess (rapid)', 50, HEAD_TO_HEAD, 2, 75],
    ['poker', 60, FOUR_SEAT, 4, 90],
    ['shelem', 80, FOUR_SEAT, 4, 120],
  ])('%s base %i, rank 1 → %i', (_name, base, table, seatCount, expected) => {
    const result = compute(
      input({
        rule: rule({
          baseAmount: base,
          placement: { draw: 1, bySeatCount: table },
          expectedMinMs: 0,
        }),
        seatCount,
      }),
    )
    expect(result.amount).toBe(expected)
  })

  it('★ Shelem base 80, rank 1 of 4 → ×1.5 → 120 — the worked example in §3.2/§11', () => {
    expect(compute(input()).amount).toBe(120)
  })
})

describe('§3.3 placement multipliers — every cell of the table', () => {
  const cases: Array<[number, number, number]> = [
    // seatCount, rank, multiplier
    [2, 1, 1.5],
    [2, 2, 0.6],
    [4, 1, 1.5],
    [4, 2, 1.0],
    [4, 3, 0.7],
    [4, 4, 0.5],
    [6, 1, 1.5],
    [6, 2, 1.1],
    [6, 3, 0.9],
    [6, 4, 0.7],
    [6, 5, 0.5],
    [6, 6, 0.5],
  ]

  it.each(cases)('%i seats, rank %i → ×%f', (seatCount, rank, multiplier) => {
    const result = compute(input({ seatCount, rank, durationExempt: true }))
    expect(result.factors.placement).toBe(multiplier)
    expect(result.amount).toBe(Math.round(80 * multiplier))
  })

  it('a draw pays ×1.0 at every seat count (§3.3, bottom row)', () => {
    for (const seatCount of [2, 4, 6]) {
      const result = compute(input({ seatCount, rank: 1, isDraw: true, durationExempt: true }))
      expect(result.factors.placement).toBe(1)
      expect(result.amount).toBe(80)
    }
  })

  it('★ losing still pays — never zero, at any seat count', () => {
    for (const [seatCount, lastRank] of [
      [2, 2],
      [4, 4],
      [6, 6],
    ] as const) {
      const result = compute(input({ seatCount, rank: lastRank, durationExempt: true }))
      expect(result.amount).toBeGreaterThan(0)
      expect(result.factors.placement).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('"5th+" — a rank past the last declared row takes the last row', () => {
    const result = compute(input({ seatCount: 6, rank: 9, durationExempt: true }))
    expect(result.factors.placement).toBe(0.5)
  })

  it('an undeclared seat count falls back to the nearest declared one', () => {
    const result = compute(input({ seatCount: 5, rank: 1, durationExempt: true }))
    expect(result.factors.placement).toBe(1.5)
  })
})

describe('§5.1 integrity factor — reward eligibility is per SEAT', () => {
  const expectations: Array<[SeatOutcome, number]> = [
    ['COMPLETED', 1],
    ['EJECTED_TIMEOUT', 0],
    ['EJECTED_ABANDON', 0],
    ['RESIGNED', 0.25],
    ['REPLACED_RETURNED', 0.5],
    ['BOT', 0],
    // 12 A8: a platform-initiated removal forfeits nothing. See the docblock on
    // `integrityFactorOf` — this row deliberately departs from 10 §5.1's table.
    ['KICKED', 1],
  ]

  it.each(expectations)('%s → integrityFactor %f', (outcome, factor) => {
    const result = compute(input({ outcome, durationExempt: true }))
    expect(result.factors.integrity).toBe(factor)
    expect(result.amount).toBe(Math.round(120 * factor))
  })

  it('★★ EJECTED_TIMEOUT earns 0 at RANK 1 — the exit criterion, in one line', () => {
    const result = compute(input({ rank: 1, outcome: 'EJECTED_TIMEOUT', durationExempt: true }))

    expect(result.amount).toBe(0)
    expect(result.forfeited).toBe(true)
    expect(result.reasonKey).toBe(REWARD_REASON_KEYS.forfeitedTimeout)
  })

  it('★ …while the seat next to it, same rank, same match, earns in full', () => {
    const partner = compute(input({ rank: 1, outcome: 'COMPLETED', durationExempt: true }))

    expect(partner.amount).toBe(120)
    expect(partner.forfeited).toBe(false)
    expect(partner.reasonKey).toBeNull()
  })

  it('★ EJECTED_ABANDON is distinct from EJECTED_TIMEOUT in the reason it gives', () => {
    const timeout = compute(input({ outcome: 'EJECTED_TIMEOUT', durationExempt: true }))
    const abandon = compute(input({ outcome: 'EJECTED_ABANDON', durationExempt: true }))

    expect(timeout.amount).toBe(0)
    expect(abandon.amount).toBe(0)
    expect(timeout.reasonKey).not.toBe(abandon.reasonKey)
  })

  it('★ REPLACED_RETURNED pays half — coming back beats staying away', () => {
    const returned = compute(input({ outcome: 'REPLACED_RETURNED', durationExempt: true }))
    const ejected = compute(input({ outcome: 'EJECTED_TIMEOUT', durationExempt: true }))
    const clean = compute(input({ durationExempt: true }))

    expect(ejected.amount).toBeLessThan(returned.amount)
    expect(returned.amount).toBeLessThan(clean.amount)
    expect(returned.amount).toBe(60)
  })

  it('★ resigning pays a quarter; being ejected pays nothing (§5.2 rule 2)', () => {
    const resigned = compute(input({ outcome: 'RESIGNED', durationExempt: true }))
    expect(resigned.amount).toBe(30)
    expect(resigned.amount).toBeGreaterThan(0)
    expect(resigned.forfeited).toBe(false)
  })

  it('forfeited is false when there was no reward to lose', () => {
    const ejectedFromNothing = compute(
      input({ outcome: 'EJECTED_TIMEOUT', rewardEligible: false }),
    )
    expect(ejectedFromNothing.amount).toBe(0)
    expect(ejectedFromNothing.forfeited).toBe(false)
  })
})

describe('§3.5 repeat decay — the curve, exactly', () => {
  it.each([
    [1, 1],
    [2, 1],
    [3, 0.6],
    [4, 0.3],
    [5, 0.1],
    [6, 0.1],
    [50, 0.1],
  ])('meeting #%i → ×%f', (repeatIndex, multiplier) => {
    const result = compute(input({ repeatIndex, durationExempt: true }))
    expect(result.factors.repeatDecay).toBe(multiplier)
    expect(result.amount).toBe(Math.round(120 * multiplier))
  })

  it('an empty curve means no decay, never no reward', () => {
    const result = compute(
      input({ rule: rule({ repeatDecay: [] }), repeatIndex: 9, durationExempt: true }),
    )
    expect(result.factors.repeatDecay).toBe(1)
    expect(result.amount).toBe(120)
  })
})

describe('§3.6 duration factor', () => {
  it('a full-length match is ×1.0', () => {
    expect(compute(input({ durationMs: 45 * MINUTE })).factors.duration).toBe(1)
  })

  it('★ a 30-second "Shelem" scales down in direct proportion', () => {
    const result = compute(input({ durationMs: 30_000 }))
    // 30 s against an 8-minute expectation = 1/16.
    expect(result.factors.duration).toBeCloseTo(0.0625, 10)
    expect(result.amount).toBe(Math.round(120 * 0.0625))
  })

  it('exactly at expectedMinMs is already ×1.0 — no cliff to play just above', () => {
    expect(compute(input({ durationMs: 8 * MINUTE })).factors.duration).toBe(1)
  })

  it('a chess resignation in a lost position is exempt → ×1.0', () => {
    const result = compute(input({ durationMs: 5_000, durationExempt: true }))
    expect(result.factors.duration).toBe(1)
  })

  it('expectedMinMs 0 (the fixture engine) is ×1.0, never a division by zero', () => {
    const result = compute(input({ rule: rule({ expectedMinMs: 0 }), durationMs: 1 }))
    expect(result.factors.duration).toBe(1)
    expect(Number.isFinite(result.amount)).toBe(true)
  })
})

describe('§6.1 premium — earning, and nothing else (E3)', () => {
  it('multiplies the reward by 1.5', () => {
    const free = compute(input({ durationExempt: true }))
    const premium = compute(
      input({ premiumMultiplier: PREMIUM_EARN_MULTIPLIER, durationExempt: true }),
    )

    expect(free.amount).toBe(120)
    expect(premium.amount).toBe(180)
  })

  it('★ E3 — the breakdown exposes no gameplay field for premium to buy', () => {
    const result = compute(input({ premiumMultiplier: PREMIUM_EARN_MULTIPLIER }))

    expect(Object.keys(result).sort()).toEqual(['amount', 'factors', 'forfeited', 'reasonKey'])
    expect(Object.keys(result.factors).sort()).toEqual([
      'base',
      'duration',
      'integrity',
      'placement',
      'premium',
      'repeatDecay',
    ])
    // Nothing resembling a timer, a card, a seat or a queue position.
    expect(JSON.stringify(result)).not.toMatch(/turn|timer|card|hand|seat|queue|priority/i)
  })

  it('premium cannot rescue an ejected seat — 0 × 1.5 is still 0', () => {
    const result = compute(
      input({
        outcome: 'EJECTED_TIMEOUT',
        premiumMultiplier: PREMIUM_EARN_MULTIPLIER,
        durationExempt: true,
      }),
    )
    expect(result.amount).toBe(0)
  })
})

describe('the paths that pay nothing always say why', () => {
  it('rewardEligible: false → 0 with tableIneligible (09 §7.2)', () => {
    const result = compute(input({ rewardEligible: false }))
    expect(result.amount).toBe(0)
    expect(result.reasonKey).toBe(REWARD_REASON_KEYS.tableIneligible)
  })

  it('no rule row → 0 with noRule, never a silent default', () => {
    const result = compute(input({ rule: null }))
    expect(result.amount).toBe(0)
    expect(result.reasonKey).toBe(REWARD_REASON_KEYS.noRule)
  })

  it('a rule declaring no placement for any seat count → 0 with noRule', () => {
    const result = compute(input({ rule: rule({ placement: { draw: 1, bySeatCount: {} } }) }))
    expect(result.amount).toBe(0)
    expect(result.reasonKey).toBe(REWARD_REASON_KEYS.noRule)
  })

  it('every reason is an i18n key, never a rendered sentence', () => {
    const reasons = Object.values(REWARD_REASON_KEYS)
    for (const key of reasons) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9.]*$/)
      expect(key).not.toMatch(/\s/)
    }
  })
})

describe('properties', () => {
  const OUTCOMES: SeatOutcome[] = [
    'COMPLETED',
    'EJECTED_TIMEOUT',
    'EJECTED_ABANDON',
    'RESIGNED',
    'REPLACED_RETURNED',
    'BOT',
    'KICKED',
  ]

  it('★ never negative, never above base × 1.5 × 1.5 — over 2 000 combinations', () => {
    const ceiling = 80 * 1.5 * PREMIUM_EARN_MULTIPLIER

    for (let i = 0; i < 2_000; i += 1) {
      const result = compute(
        input({
          seatCount: [2, 4, 6][i % 3]!,
          rank: (i % 6) + 1,
          isDraw: i % 7 === 0,
          outcome: OUTCOMES[i % OUTCOMES.length]!,
          premiumMultiplier: i % 2 === 0 ? 1 : PREMIUM_EARN_MULTIPLIER,
          repeatIndex: (i % 6) + 1,
          durationMs: (i % 60) * MINUTE,
          durationExempt: i % 5 === 0,
        }),
      )

      expect(result.amount).toBeGreaterThanOrEqual(0)
      expect(result.amount).toBeLessThanOrEqual(Math.round(ceiling))
      expect(Number.isInteger(result.amount)).toBe(true)
    }
  })

  it('★ pure — 1 000 identical calls give byte-identical results, with no database present', () => {
    const fixed = input({ rank: 3, repeatIndex: 3, durationMs: 4 * MINUTE })
    const first = JSON.stringify(compute(fixed))

    for (let i = 0; i < 1_000; i += 1) {
      expect(JSON.stringify(compute(fixed))).toBe(first)
    }
  })

  it('a reward is always a whole number of coins', () => {
    for (let rank = 1; rank <= 6; rank += 1) {
      const result = compute(input({ seatCount: 6, rank, repeatIndex: 3 }))
      expect(Number.isInteger(result.amount)).toBe(true)
    }
  })
})
