import type { SeatOutcome } from '../../contracts/enums.js'
import type { GameEvent } from '../../domain/entities/game.js'
import type { TableMember } from '../../domain/entities/table.js'

/**
 * ★ What a seat's match outcome is — S33, feeding S36's settlement.
 *
 * ### Why this is a function and not a column
 *
 * `MatchParticipant.outcome` is a *column* (03 §3.5) rather than something
 * derived from the standings, because ejection is not the engine's business:
 * `GameEngine.result()` reports `COMPLETED` for every seat, on purpose, and
 * knows nothing about strikes or disconnections. Somebody has to overwrite it
 * before settlement, and that somebody reads `TableMember` plus the log — which
 * is exactly what this does.
 *
 * It is pure, takes everything it needs as arguments, and is therefore testable
 * against every combination without a database. S36 calls it once per seat
 * inside the settlement transaction and writes the result down; nothing else
 * should re-derive it, because at that point the member row may already have
 * been reset by a reclaim.
 *
 * ### The ordering is the policy
 *
 * | Checked | Result | Why it comes first |
 * |---|---|---|
 * | A bot seat | `BOT` | Nobody is owed anything; there is no human behind it |
 * | Returned after ejection | `REPLACED_RETURNED` | ★ Beats the ejection *that is still in the log*. Coming back is supposed to pay (0.5×, 04 §6.4), and an outcome that reported the ejection instead would make returning worth exactly as much as staying away |
 * | Ejected, by which timer | `EJECTED_TIMEOUT` / `EJECTED_ABANDON` | 10 §5.1 pays these differently; conflating them is the mistake 04 §5.2 explicitly warns about |
 * | Kicked by the host | `KICKED` | A platform-initiated removal, not a player's failure |
 * | Anything else | `COMPLETED` | Including a player who took a strike and then played on — a strike is not an outcome |
 */
export function seatOutcomeOf(member: TableMember, events: readonly GameEvent[] = []): SeatOutcome {
  if (member.isBot) return 'BOT'

  if (member.seat !== null && hasReturned(events, member.seat)) return 'REPLACED_RETURNED'

  switch (member.ejectionReason) {
    case 'TURN_TIMEOUT':
      return 'EJECTED_TIMEOUT'
    case 'ABANDON':
      return 'EJECTED_ABANDON'
    case 'KICKED':
      return 'KICKED'
    default:
      return 'COMPLETED'
  }
}

/**
 * ★ The reward multiplier that goes with an outcome — 04 §6.4, 10 §5.1.
 *
 * Zero for an ejected seat *even when their team wins*: reward eligibility is
 * per **seat**, not per team, and their partner is still paid in full. Half for
 * a player who was ejected and came back inside the window, which is the whole
 * incentive design in one number — coming back beats staying away, and never
 * leaving beats both.
 *
 * S35 consumes this as `integrityFactor`. Declared here, next to the outcome it
 * belongs to, so the two cannot drift into disagreeing about what an ejection
 * costs.
 *
 * ### The two values that are not 0 or 1
 *
 * **`RESIGNED` is 0.25** (10 §5.2 rule 2), corrected at S35 — it returned 1
 * when this function shipped at S33, which nothing consumed yet. Conceding a
 * lost position promptly is *courteous*: it gives the other players their
 * evening back. Vanishing mid-hand and forcing a bot substitution is not, and
 * the gap between 0.25 and 0 is exactly how much that difference is worth.
 *
 * **`KICKED` is 1**, against 10 §5.1's own table, and deliberately: a host or
 * an admin removing somebody is *platform-initiated*, and forfeiture exists to
 * punish idling, not operations (12 A8). A player kicked from a table they were
 * playing properly keeps what they earned.
 */
export function integrityFactorOf(outcome: SeatOutcome): number {
  switch (outcome) {
    case 'EJECTED_TIMEOUT':
    case 'EJECTED_ABANDON':
    case 'BOT':
      return 0
    case 'REPLACED_RETURNED':
      return 0.5
    case 'RESIGNED':
      return 0.25
    case 'KICKED':
    case 'COMPLETED':
      return 1
  }
}

/**
 * Did this seat come back?
 *
 * Read from the log rather than from the member row on purpose: a completed
 * reclaim *clears* `ejectedAt` and `ejectionReason`, so by the time settlement
 * runs the row looks like somebody who never left. The event is what remembers.
 */
function hasReturned(events: readonly GameEvent[], seat: number): boolean {
  return events.some(
    (event) =>
      event.seat === seat &&
      event.kind === 'SYSTEM' &&
      event.payload['system'] === 'PLAYER_RETURNED',
  )
}
