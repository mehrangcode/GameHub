import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 03 §1 rule 4. Every money-ish column is `Int`, and the only `Float` in the
 * whole schema is `MatchParticipant.playedFraction` — a ratio, never money.
 */
const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')

const codeLines = schema
  .split('\n')
  .map((line) => line.replace(/\/{2,3}.*$/, '').trimEnd())
  .filter((line) => line.trim().length > 0)

const MONEY_FIELDS = [
  'amount',
  'balance',
  'balanceAfter',
  'priceAmount',
  'pricePaid',
  'coinsAwarded',
  'score',
  'baseAmount',
  'rewardAmount',
  'lifetimeEarned',
  'lifetimeSpent',
  'capPerHour',
  'capPerDay',
  'capPerDayGuest',
  'capMatchesPerDay',
  'guestVestCap',
]

describe('money types', () => {
  it.each(MONEY_FIELDS)('%s is declared Int', (field) => {
    const declarations = codeLines.filter((l) => new RegExp(`^\\s*${field}\\s+\\w+`).test(l))
    expect(declarations.length, `${field} is not declared anywhere`).toBeGreaterThan(0)
    for (const line of declarations) {
      expect(line, `${field} must be Int`).toMatch(new RegExp(`^\\s*${field}\\s+Int\\b`))
    }
  })

  it('has exactly one Float in the entire schema: playedFraction', () => {
    const floats = codeLines
      .filter((l) => /^\s*\w+\s+Float\b/.test(l))
      .map((l) => l.trim().split(/\s+/)[0])
    expect(floats).toEqual(['playedFraction'])
  })
})
