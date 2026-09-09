/**
 * 05-game-engine-spec.md §4.1 — the card value object.
 *
 * A card is the compact 2-char string `` `${Rank}${Suit}` `` ('AS', 'TD', '7H'),
 * not `{ rank, suit }`. That choice is load-bearing:
 *
 *   - **I5** (JSON-serialisable state) holds trivially — a card is a string.
 *   - **I4** (projection-complete) becomes testable by substring assertion on a
 *     serialised projection: `expect(json).not.toContain('AS')`.
 *   - Payloads are ~4× smaller on the wire and usable directly as object keys.
 */

/** Clubs, diamonds, hearts, spades. Order is the canonical sort order. */
export const SUITS = ['C', 'D', 'H', 'S'] as const
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const

export type Suit = (typeof SUITS)[number]
export type Rank = (typeof RANKS)[number]
export type Card = `${Rank}${Suit}`

const RANK_SET: ReadonlySet<string> = new Set(RANKS)
const SUIT_SET: ReadonlySet<string> = new Set(SUITS)

export function rankOf(card: Card): Rank {
  return card[0] as Rank
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit
}

/**
 * The **generic** ordinal value: 2…10 for pips, J=11, Q=12, K=13, A=14.
 *
 * Deliberately not game-specific. Blackjack's soft ace, Shelem's point cards
 * and Poker's low-ace straight are engine concerns and live in
 * `domain/games/<slug>/`, not here — a shared helper that tried to serve all
 * three would end up wrong for each.
 */
export function cardValue(card: Card): number {
  return RANKS.indexOf(rankOf(card)) + 2
}

/** Runtime guard for anything crossing a boundary as a plain string. */
export function isCard(value: unknown): value is Card {
  return (
    typeof value === 'string' &&
    value.length === 2 &&
    RANK_SET.has(value[0] as string) &&
    SUIT_SET.has(value[1] as string)
  )
}

export function makeCard(rank: Rank, suit: Suit): Card {
  return `${rank}${suit}`
}

/** A fresh, ordered 52-card deck. Shuffling is `shuffle(deck, rng)` — never here. */
export function buildDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(makeCard(rank, suit))
    }
  }
  return deck
}

/** Stable ordering for rendering and for byte-identical replay assertions. */
export function compareCards(a: Card, b: Card): number {
  const suitDelta = SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b))
  return suitDelta !== 0 ? suitDelta : cardValue(a) - cardValue(b)
}
