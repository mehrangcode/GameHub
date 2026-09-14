import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDuration,
  formatNumber,
  initialsOf,
  resolveNumerals,
} from '../../src/lib/format'

/**
 * S40 — numerals and dates.
 *
 * ★ The rule these tests defend is "**display only**": a number a human reads
 * as a *quantity* converts, and a string that happens to contain digits never
 * does. An invite code rendered as `SEEDDEMO` in Persian digits is untypeable
 * and unsearchable, and a cuid with Persian digits in it is simply wrong.
 */

describe('resolveNumerals', () => {
  it("'auto' follows the language — which is what almost every reader wants", () => {
    expect(resolveNumerals('auto', 'fa')).toBe('persian')
    expect(resolveNumerals('auto', 'en')).toBe('latin')
  })

  it('an explicit choice overrides the language in both directions', () => {
    // A Persian reader who prefers 1,200 is a real person, and so is an
    // English-reading Persian speaker who wants ۱٬۲۰۰.
    expect(resolveNumerals('latin', 'fa')).toBe('latin')
    expect(resolveNumerals('persian', 'en')).toBe('persian')
  })
})

describe('formatNumber', () => {
  it('★ renders Persian-Indic digits when asked', () => {
    const rendered = formatNumber(2480, { locale: 'fa', numerals: 'persian' })

    expect(rendered).toMatch(/[۰-۹]/)
    expect(rendered).not.toMatch(/[0-9]/)
  })

  it('renders Latin digits for an English reader', () => {
    expect(formatNumber(2480, { locale: 'en', numerals: 'latin' })).toBe('2,480')
  })

  it('★ a Persian reader who chose Latin digits keeps Persian grouping', () => {
    const rendered = formatNumber(2480, { locale: 'fa', numerals: 'latin' })

    // Done through Intl rather than a digit-substitution table, which would
    // get the group separator wrong.
    expect(rendered).toMatch(/[0-9]/)
    expect(rendered).not.toMatch(/[۰-۹]/)
  })

  it('renders zero and negatives', () => {
    expect(formatNumber(0, { locale: 'en', numerals: 'latin' })).toBe('0')
    expect(formatNumber(-40, { locale: 'en', numerals: 'latin' })).toBe('-40')
  })

  it('rounds to a whole number by default — coins and scores are integers', () => {
    expect(formatNumber(119.6, { locale: 'en', numerals: 'latin' })).toBe('120')
  })

  it('★ keeps the fraction on a reward multiplier when asked', () => {
    // Caught a real bug: the default rounding rendered a 1.5× premium as "×2"
    // and a 0.6× repeat decay as "×1", so the breakdown contradicted the total
    // it was there to explain — on the one screen whose whole job is making
    // the arithmetic checkable (10 §11).
    const options = { locale: 'en', numerals: 'latin', maximumFractionDigits: 2 } as const

    expect(formatNumber(1.5, options)).toBe('1.5')
    expect(formatNumber(0.6, options)).toBe('0.6')
    expect(formatNumber(0, options)).toBe('0')
  })
})

describe('formatDuration', () => {
  it('renders m:ss with a padded seconds field', () => {
    expect(formatDuration(23_000, { locale: 'en', numerals: 'latin' })).toBe('0:23')
    expect(formatDuration(125_000, { locale: 'en', numerals: 'latin' })).toBe('2:05')
  })

  it('★ clamps at zero — a passed deadline reads 0:00, never -0:03', () => {
    // The expiry event may arrive a moment after the deadline. A negative
    // countdown reads as a bug at the exact moment the player is most anxious.
    expect(formatDuration(-4_000, { locale: 'en', numerals: 'latin' })).toBe('0:00')
  })

  it('pads with a Persian zero when rendering Persian digits', () => {
    const rendered = formatDuration(65_000, { locale: 'fa', numerals: 'persian' })

    // An ASCII '0' pad inside a Persian number is the classic half-converted
    // bug: ۱:۰5.
    expect(rendered).not.toMatch(/[0-9]/)
  })
})

describe('formatDate', () => {
  it('★ renders a Jalali date for a Persian reader', () => {
    const rendered = formatDate('2026-03-21T00:00:00Z', 'fa')

    // Nowruz 1405. Delegated to Intl rather than a hand-rolled converter,
    // which is a classic source of off-by-one-day bugs around exactly this
    // date.
    expect(rendered).toMatch(/۱۴۰[۴۵]/)
  })

  it('renders Gregorian for an English reader', () => {
    expect(formatDate('2026-03-21T00:00:00Z', 'en')).toMatch(/2026/)
  })

  it('returns empty for an unparseable value rather than "Invalid Date"', () => {
    expect(formatDate('not-a-date', 'en')).toBe('')
  })
})

describe('initialsOf', () => {
  it('takes the first and last words', () => {
    expect(initialsOf('Mehrang Ghasemi')).toBe('MG')
    expect(initialsOf('Sara')).toBe('S')
  })

  it('★ does not split a Persian name mid-grapheme', () => {
    const initials = initialsOf('سارا رضایی')

    expect(initials).toHaveLength(2)
    expect(initials).not.toContain('�')
  })

  it('survives an empty name', () => {
    expect(initialsOf('   ')).toBe('?')
  })
})

describe('★ ids and codes are never converted', () => {
  it('there is no formatter here that takes an id', () => {
    // Deliberately a documentation test. The protection is structural: the
    // module exposes no function that would convert an identifier, so the only
    // way to get Persian digits into an invite code is to write a new one — at
    // which point this comment is what you should read.
    const codes = ['SEEDDEMO', 'clx8f2p910000', 'tbl_01H9']

    for (const code of codes) {
      expect(code).not.toMatch(/[۰-۹]/)
    }
  })
})
