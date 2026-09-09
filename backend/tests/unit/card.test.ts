import { describe, expect, it } from 'vitest'
import {
  RANKS,
  SUITS,
  buildDeck,
  cardValue,
  compareCards,
  isCard,
  makeCard,
  rankOf,
  suitOf,
  type Card,
} from '../../src/domain/value-objects/card.js'

describe('card value object (05 §4.1)', () => {
  it('reads the rank off a two-char card', () => {
    expect(rankOf('TD')).toBe('T')
    expect(rankOf('AS')).toBe('A')
    expect(rankOf('2C')).toBe('2')
  })

  it('reads the suit off a two-char card', () => {
    expect(suitOf('AS')).toBe('S')
    expect(suitOf('7H')).toBe('H')
    expect(suitOf('TD')).toBe('D')
  })

  it('scores ranks with ace high and no game-specific special cases', () => {
    expect(cardValue('2C')).toBe(2)
    expect(cardValue('9C')).toBe(9)
    expect(cardValue('TC')).toBe(10)
    expect(cardValue('JC')).toBe(11)
    expect(cardValue('QC')).toBe(12)
    expect(cardValue('KC')).toBe(13)
    expect(cardValue('AC')).toBe(14)
  })

  it('rejects anything that is not a real card', () => {
    for (const bad of ['', 'A', 'ASD', 'XS', 'AX', '1S', 'as', 10, null, undefined, {}]) {
      expect(isCard(bad), `${String(bad)} should not be a card`).toBe(false)
    }
    expect(isCard('AS')).toBe(true)
  })

  describe('a full deck', () => {
    const deck = buildDeck()

    it('has 52 cards', () => {
      expect(deck).toHaveLength(52)
    })

    it('has no duplicates', () => {
      expect(new Set(deck).size).toBe(52)
    })

    it('contains every rank × suit exactly once', () => {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          expect(deck.filter((c) => c === makeCard(rank, suit))).toHaveLength(1)
        }
      }
    })

    it('is entirely made of valid cards', () => {
      expect(deck.every(isCard)).toBe(true)
    })

    it('survives a JSON round trip unchanged — invariant I5', () => {
      expect(JSON.parse(JSON.stringify(deck)) as Card[]).toEqual(deck)
    })
  })

  it('sorts by suit then by rank, deterministically', () => {
    const shuffled: Card[] = ['AS', '2C', 'KD', 'TC', '3H']
    expect([...shuffled].sort(compareCards)).toEqual(['2C', 'TC', 'KD', '3H', 'AS'])
  })
})
