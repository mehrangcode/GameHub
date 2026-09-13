import type { PlacementTable } from '../entities/economy.js'

/**
 * ★ The reward maths — 10-economy-and-rewards.md §3.1–3.6.
 *
 *     reward = round( base × placement × premium × integrity × repeatDecay × duration )
 *
 * Six factors, and **every one of them is data**: `base`, the placement table,
 * the decay curve and `expectedMinMs` all come off a `RewardRule` row, so
 * rebalancing the economy is an `UPDATE`, not a deploy (10 §3). Nothing in this
 * file reads a clock, a database or a config constant — it is handed numbers
 * and returns a number, which is what lets the whole of §3.2–3.6 be checked
 * against the document row for row in a unit test with no container.
 *
 * The *policy* that chooses those numbers — which outcome forfeits, whether a
 * subscription is active, how many times this group has met in the last half
 * hour — lives in `application/services/RewardService.ts`. The split is the
 * same one `caps.ts` makes against `WalletService`, and for the same reason:
 * the interesting cases here are boundaries, and a boundary is cheap to
 * enumerate and expensive to set up through a database.
 *
 * ### Why `null` rather than a default
 *
 * {@link placementMultiplier} returns `null` when the rule declares nothing for
 * this shape of table, instead of quietly falling back to 1. A silent 1 would
 * pay a full reward from a misconfigured row and nobody would ever find out; a
 * `null` becomes a zero-amount ledger row carrying a reason, which is the same
 * discipline `CAP_REJECTED` applies to a capped credit (10 §2.4). A reward that
 * is not paid must always be *explained*.
 */

/** Every multiplier in §3.1, kept apart so §11's breakdown can render each line. */
export interface RewardFactors {
  readonly base: number
  readonly placement: number
  readonly premium: number
  readonly integrity: number
  readonly repeatDecay: number
  readonly duration: number
}

/**
 * Which cell of §3.3 applies.
 *
 * `isDraw` is passed in rather than inferred from shared ranks: a draw is a
 * property of the *match* (`MatchResult.reason`), and two seats tying for
 * second in a six-handed game is not one.
 */
export interface PlacementQuery {
  readonly placement: PlacementTable
  readonly seatCount: number
  readonly rank: number
  readonly isDraw: boolean
}

/**
 * §3.3's table, looked up. `null` when the rule declares no placement at all.
 *
 * Two fallbacks, both of which exist in the document itself:
 *
 * | Case | Resolution | Where it comes from |
 * |---|---|---|
 * | A seat count the rule never declared | the nearest declared count, larger on a tie | A rule seeded for 4 seats should still pay a 5-seat table something sane rather than nothing |
 * | A rank past the last declared row | the last declared row | §3.3's bottom row is literally **"5th+"** — ranks beyond the table share its multiplier |
 */
export function placementMultiplier(query: PlacementQuery): number | null {
  if (query.isDraw) return query.placement.draw

  const counts = Object.keys(query.placement.bySeatCount)
    .map((key) => Number(key))
    .filter((count) => Number.isFinite(count))
  if (counts.length === 0) return null

  const chosen = nearest(counts, query.seatCount)
  const row = query.placement.bySeatCount[String(chosen)] ?? {}

  const ranks = Object.keys(row)
    .map((key) => Number(key))
    .filter((rank) => Number.isFinite(rank))
    .sort((a, b) => a - b)
  if (ranks.length === 0) return null

  // The largest declared rank at or below this one — "5th+" behaviour. Below
  // the first declared rank (rank 0 would be a bug upstream) takes the first.
  const applicable = ranks.filter((rank) => rank <= query.rank).at(-1) ?? ranks[0]!
  return row[String(applicable)] ?? null
}

/**
 * §3.5 — the same set of identities meeting repeatedly decays the reward.
 *
 * `index` is 1-based and **includes the match being settled**: the first
 * meeting is index 1. Past the end of the curve the last value repeats, so
 * `[1, 1, 0.6, 0.3, 0.1]` means a fifth, ninth and fiftieth match all pay 0.1×
 * — the curve's tail is a floor, not a cliff that wraps.
 *
 * An empty curve is 1.0, not 0: a rule row that forgot to declare a decay
 * should pay normally, never nothing.
 */
export function repeatDecayMultiplier(curve: readonly number[], index: number): number {
  if (curve.length === 0) return 1
  const clamped = Math.max(1, Math.trunc(index))
  return curve[Math.min(clamped, curve.length) - 1] ?? 1
}

/**
 * §3.6 — `clamp(actualMs / expectedMinMs, 0, 1)`.
 *
 * The main defence against "deliberately lose in 30 seconds, repeat": the
 * reward shrinks in direct proportion to the shortcut rather than by a cliff,
 * so there is no threshold to play just above.
 *
 * `exempt` is §3.6's own carve-out — a chess resignation in a lost position and
 * an all-fold poker hand are legitimately fast and pay in full. An
 * `expectedMinMs` of 0 (the `fixture` engine, and any game that has not
 * declared one) is 1.0 rather than a division by zero: "no expectation" cannot
 * mean "you failed it".
 */
export function durationFactor(actualMs: number, expectedMinMs: number, exempt = false): number {
  if (exempt) return 1
  if (expectedMinMs <= 0) return 1
  if (!Number.isFinite(actualMs) || actualMs <= 0) return 0
  return Math.min(1, actualMs / expectedMinMs)
}

/**
 * The product, rounded — §3.1's `round(...)`.
 *
 * Rounding happens **once, at the end**, never per factor: rounding each step
 * would make the order of multiplication observable in the payout, and §11
 * publishes the formula as a single line of arithmetic.
 */
export function rewardAmount(factors: RewardFactors): number {
  const raw =
    factors.base *
    factors.placement *
    factors.premium *
    factors.integrity *
    factors.repeatDecay *
    factors.duration

  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.round(raw)
}

/** The declared value closest to `wanted`; the larger one on a tie. */
function nearest(values: readonly number[], wanted: number): number {
  return [...values].sort((a, b) => {
    const distance = Math.abs(a - wanted) - Math.abs(b - wanted)
    return distance === 0 ? b - a : distance
  })[0]!
}
