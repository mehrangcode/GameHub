import {
  DEFAULT_TURN_ENFORCEMENT,
  TurnEnforcementSchema,
  type TurnEnforcement,
} from '../../contracts/dto/turnEnforcement.js'

/**
 * Turn-enforcement policy, resolved — S31–S34, 04 §6.3.
 *
 * The *shape* lives in `contracts/` (a schema and a type, which the frontend
 * mirror copies verbatim); the two functions that act on it live here, because
 * `contracts/` declares and never executes. Both are pure, so the interesting
 * cases — a partial patch, a zero-length reclaim window — are unit tests with
 * no database in sight.
 */

/**
 * Applies the defaults to a partial or absent setting.
 *
 * Used for the stored column (`null` ⇒ defaults) and for a `PATCH` that names
 * one field. The `base` parameter is what makes the second case correct: a
 * patch setting `ejectAfterStrikes` must be merged over the table's *current*
 * policy, not over the platform defaults, or it would silently reset a
 * `warningSeconds` the host chose last week.
 */
export function withTurnEnforcementDefaults(
  value: Partial<TurnEnforcement> | null | undefined,
  base: TurnEnforcement = DEFAULT_TURN_ENFORCEMENT,
): TurnEnforcement {
  return TurnEnforcementSchema.parse({ ...base, ...(value ?? {}) })
}

/**
 * When an ejected seat stops being reclaimable — 04 §6.4.
 *
 * Returns an **absolute instant**, and `null` when the window is zero (the bot
 * keeps the seat the moment it takes it). Kept in one place so that nothing
 * anywhere stores a *duration* and recomputes the deadline from it later, which
 * is how a restart ends up extending somebody's window.
 */
export function reclaimDeadline(now: Date, settings: TurnEnforcement): Date | null {
  if (settings.reclaimWindowSec === 0) return null
  return new Date(now.getTime() + settings.reclaimWindowSec * 1_000)
}
