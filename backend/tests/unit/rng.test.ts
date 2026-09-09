import { describe, expect, it } from 'vitest'
import {
  commitSeed,
  createSecureRng,
  createSeededRng,
  shuffle,
} from '../../src/domain/games/shared/rng.js'
import { buildDeck } from '../../src/domain/value-objects/card.js'

const draw = (seed: string, n: number, max = 1000): number[] => {
  const rng = createSeededRng(seed)
  return Array.from({ length: n }, () => rng.int(max))
}

describe('createSeededRng — the basis of every replay test', () => {
  it('produces an identical sequence for the same seed', () => {
    expect(draw('x', 500)).toEqual(draw('x', 500))
  })

  it('produces a different sequence for a different seed', () => {
    expect(draw('x', 500)).not.toEqual(draw('y', 500))
  })

  it('decorrelates seeds that differ by one character', () => {
    // Without hashing the seed, 'game-1' and 'game-2' would seed adjacent
    // states and deal suspiciously similar hands.
    const a = draw('game-1', 200)
    const b = draw('game-2', 200)
    const sharedPrefix = a.findIndex((v, i) => v !== b[i])
    expect(sharedPrefix).toBeLessThanOrEqual(1)
  })

  it('deals a byte-identical hand twice from the same seed', () => {
    const deal = (): string => JSON.stringify(createSeededRng('deal-seed').shuffle(buildDeck()))
    expect(deal()).toBe(deal())
  })

  it('rejects a non-positive or non-integer bound rather than coercing it', () => {
    const rng = createSeededRng('x')
    expect(() => rng.int(0)).toThrow(RangeError)
    expect(() => rng.int(-1)).toThrow(RangeError)
    expect(() => rng.int(2.5)).toThrow(RangeError)
  })

  it('stays within bounds', () => {
    const rng = createSeededRng('bounds')
    for (let i = 0; i < 10_000; i++) {
      const v = rng.int(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
  })
})

describe('createSecureRng', () => {
  it('produces a different sequence on each construction', () => {
    const a = Array.from({ length: 200 }, () => createSecureRng().int(1_000_000))
    const b = Array.from({ length: 200 }, () => createSecureRng().int(1_000_000))
    expect(a).not.toEqual(b)
  })

  it('stays within bounds and rejects a bad one', () => {
    const rng = createSecureRng()
    for (let i = 0; i < 1000; i++) expect(rng.int(4)).toBeLessThan(4)
    expect(() => rng.int(0)).toThrow(RangeError)
  })
})

describe('uniformity', () => {
  // χ² over 6 buckets, 5 degrees of freedom. The 99.9th percentile is 20.515;
  // a fair generator clears it essentially always, a biased one does not.
  const CHI_SQUARE_999 = 20.515
  const DRAWS = 60_000

  const chiSquare = (counts: number[]): number => {
    const expected = DRAWS / counts.length
    return counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0)
  }

  it('createSeededRng.int(6) is uniform', () => {
    const rng = createSeededRng('uniformity')
    const counts = new Array<number>(6).fill(0)
    for (let i = 0; i < DRAWS; i++) counts[rng.int(6)]!++
    expect(chiSquare(counts)).toBeLessThan(CHI_SQUARE_999)
  })

  it('createSecureRng.int(6) is uniform', () => {
    const rng = createSecureRng()
    const counts = new Array<number>(6).fill(0)
    for (let i = 0; i < DRAWS; i++) counts[rng.int(6)]!++
    expect(chiSquare(counts)).toBeLessThan(CHI_SQUARE_999)
  })
})

describe('shuffle — Fisher–Yates over rng.int(i + 1)', () => {
  it('returns a new array and never mutates its input', () => {
    const input = buildDeck()
    const snapshot = [...input]
    const out = shuffle(input, createSeededRng('s'))

    expect(out).not.toBe(input)
    expect(input).toEqual(snapshot)
  })

  it('is a permutation — same multiset, nothing lost or duplicated', () => {
    const deck = buildDeck()
    const out = shuffle(deck, createSeededRng('perm'))

    expect(out).toHaveLength(deck.length)
    expect([...out].sort()).toEqual([...deck].sort())
  })

  it('actually reorders a 52-card deck', () => {
    expect(shuffle(buildDeck(), createSeededRng('reorder'))).not.toEqual(buildDeck())
  })

  it('handles empty and single-element arrays', () => {
    const rng = createSeededRng('edge')
    expect(shuffle([], rng)).toEqual([])
    expect(shuffle(['AS'], rng)).toEqual(['AS'])
  })

  it('reaches every permutation of three items with roughly equal frequency', () => {
    const rng = createSeededRng('perm-uniformity')
    const seen = new Map<string, number>()
    for (let i = 0; i < 60_000; i++) {
      const key = shuffle(['a', 'b', 'c'], rng).join('')
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    expect(seen.size).toBe(6)
    for (const count of seen.values()) {
      // A biased "shuffle" (the classic `int(n)` instead of `int(i+1)`) skews
      // these badly; a correct one lands within a few percent of 10 000.
      expect(count).toBeGreaterThan(9_000)
      expect(count).toBeLessThan(11_000)
    }
  })
})

describe('pick', () => {
  it('always returns an element of the array', () => {
    const rng = createSeededRng('pick')
    const items = ['a', 'b', 'c', 'd'] as const
    for (let i = 0; i < 500; i++) expect(items).toContain(rng.pick(items))
  })

  it('throws on an empty array rather than returning undefined', () => {
    expect(() => createSeededRng('pick').pick([])).toThrow(RangeError)
  })
})

describe('commitSeed — the provable-shuffle commitment (05 §3)', () => {
  it('is deterministic for a seed/game pair', () => {
    expect(commitSeed('seed', 'game-1')).toBe(commitSeed('seed', 'game-1'))
  })

  it('binds the seed to the game, so a commitment cannot be replayed elsewhere', () => {
    expect(commitSeed('seed', 'game-1')).not.toBe(commitSeed('seed', 'game-2'))
  })

  it('reveals nothing about the seed — 64 hex chars', () => {
    const commit = commitSeed('the-secret-seed', 'game-1')
    expect(commit).toMatch(/^[0-9a-f]{64}$/)
    expect(commit).not.toContain('the-secret-seed')
  })
})
