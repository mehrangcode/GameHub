/**
 * A seat index at a table. 0-based, `< table.seatCount`.
 *
 * Branded so a raw `number` — a score, a team, a rank — cannot be passed where
 * a seat is expected. The brand costs nothing at runtime and catches the class
 * of bug where `team` and `seat` get swapped in an argument list.
 */
declare const seatBrand: unique symbol

export type SeatId = number & { readonly [seatBrand]: 'SeatId' }

export function isSeatId(value: unknown): value is SeatId {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Throws rather than coercing — P7, fail fast at the boundary. */
export function seatId(value: number): SeatId {
  if (!isSeatId(value)) {
    throw new RangeError(`seat must be a non-negative integer, got ${String(value)}`)
  }
  return value
}

/** `[0, 1, … seatCount - 1]` — the seat map every table renders from. */
export function seatRange(seatCount: number): SeatId[] {
  if (!Number.isInteger(seatCount) || seatCount <= 0) {
    throw new RangeError(`seatCount must be a positive integer, got ${String(seatCount)}`)
  }
  return Array.from({ length: seatCount }, (_, i) => i as SeatId)
}

/** Partnership seating: Shelem's 0/2 versus 1/3 (05 §7). */
export function teamOf(seat: SeatId, teamCount = 2): number {
  return seat % teamCount
}

/** Turn order, wrapping at the table edge. */
export function nextSeat(seat: SeatId, seatCount: number): SeatId {
  return ((seat + 1) % seatCount) as SeatId
}
