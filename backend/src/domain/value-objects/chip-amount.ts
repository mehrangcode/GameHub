/**
 * Table chips — the ephemeral per-match tokens a Poker or Blackjack seat plays
 * with.
 *
 * ★ Chips are **not** wallet coins (10-economy-and-rewards.md E5). A chip stack
 * is created when the match starts and ceases to exist when it ends; it never
 * touches a `Wallet`, never appears in the ledger, and cannot be cashed out.
 * Crossing that line turns a card game into gambling, which is why the ESLint
 * guard bars `domain/games/**` from importing anything named `wallet` — and why
 * this type lives beside `Card` rather than anywhere near the economy.
 *
 * Always an integer: fractional chips would reintroduce the rounding drift that
 * the Int-only money rule (03 §1 rule 4) exists to prevent.
 */
declare const chipBrand: unique symbol

export type ChipAmount = number & { readonly [chipBrand]: 'ChipAmount' }

export function isChipAmount(value: unknown): value is ChipAmount {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function chipAmount(value: number): ChipAmount {
  if (!isChipAmount(value)) {
    throw new RangeError(`chip amount must be a non-negative integer, got ${String(value)}`)
  }
  return value
}

export const ZERO_CHIPS = 0 as ChipAmount

export function addChips(a: ChipAmount, b: ChipAmount): ChipAmount {
  return chipAmount(a + b)
}

/** Throws on overdraw — a negative stack is a bug, never a state. */
export function subtractChips(a: ChipAmount, b: ChipAmount): ChipAmount {
  return chipAmount(a - b)
}
