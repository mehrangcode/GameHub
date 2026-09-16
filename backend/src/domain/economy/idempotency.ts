import type { HolderKey } from '../value-objects/identity.js'

/**
 * ★ The derived idempotency keys — 10-economy-and-rewards.md §2.4, invariant E2.
 *
 * Every credit carries a key derived **from the event that caused it**, never a
 * random value, and `(walletId, idempotencyKey)` is unique in the database. That
 * one property is the whole double-credit defence: replaying a settlement, a
 * socket ack retried after a dropped connection, or a worker restarted
 * mid-transaction all produce the *same* key and therefore collide instead of
 * paying twice.
 *
 * A random key would satisfy the constraint and defeat the mechanism entirely,
 * which is why the builders live here as pure functions rather than as string
 * templates scattered through the services: there is one place to read to know
 * what a key looks like, and one place a test can pin the formats to the spec
 * (`tests/unit/wallet/idempotency.test.ts` asserts each one character by
 * character against §2.4's table).
 *
 * | Credit | Key |
 * |---|---|
 * | Match reward | `match:{matchResultId}:{seat}` |
 * | Daily bonus | `daily:{holderKey}:{YYYY-MM-DD}` |
 * | Achievement | `achv:{achievementId}:{holderKey}` |
 * | Premium grant | `premium:{subscriptionId}:{periodIndex}` |
 * | Guest vesting | `vest:{guestSessionId}` |
 * | Hint point earned | `sudoku-hint:{userId}:{milestone}` |
 * | Hint point spent | `sudoku-hint-spend:{gameId}:{seat}:{seq}` |
 */

/** UTC, always. A key that depended on the server's timezone would not be derived. */
export function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * Per **seat**, not per team or per user (10 §5.2). Reward eligibility is a seat
 * property, so an ejected player and their paid partner need distinct keys even
 * though one match produced both rows.
 */
export function matchRewardKey(matchResultId: string, seat: number): string {
  return `match:${matchResultId}:${seat}`
}

export function dailyBonusKey(holder: HolderKey, at: Date): string {
  return `daily:${holder}:${isoDay(at)}`
}

export function achievementKey(achievementId: string, holder: HolderKey): string {
  return `achv:${achievementId}:${holder}`
}

export function premiumGrantKey(subscriptionId: string, periodIndex: number): string {
  return `premium:${subscriptionId}:${periodIndex}`
}

/**
 * One vest per guest session, forever (10 §3.4). This is what stops a single
 * guest session from vesting into two accounts even if the claim request is
 * retried — and it is the reason `GuestSession` rows are kept after being
 * claimed rather than deleted.
 */
export function guestVestKey(guestSessionId: string): string {
  return `vest:${guestSessionId}`
}

/**
 * Not in §2.4's table, derived by the same rule: a guest session forfeits its
 * unvested remainder exactly once, whether by the vesting cap (S22) or by
 * expiry (S38).
 */
export function guestForfeitKey(guestSessionId: string): string {
  return `forfeit:${guestSessionId}`
}

/**
 * `games/sudoku.md` §13.1 — a hint point is earned every 3 solved puzzles, so
 * the key is the **milestone**, `floor(solves / 3)`, not the match that happened
 * to cross it.
 *
 * That choice is what makes the grant safe under every retry shape at once. A
 * key derived from the match would be unique per match and would therefore pay
 * twice if the solve counter were ever recomputed; keying on "how many puzzles
 * has this player solved" means the answer to *should this grant exist* is a
 * function of the player's history rather than of when the code ran. Replay the
 * settlement, re-run a backfill, race two workers — all three produce milestone
 * 7 and collide on the constraint.
 */
export function hintGrantKey(userId: string, milestone: number): string {
  return `sudoku-hint:${userId}:${milestone}`
}

/**
 * The spend side, keyed by the move that caused it: `seq` is the event sequence
 * number the hint will be appended at, which is unique per game and known before
 * `applyMove` runs. A socket ack retried after a dropped connection replays the
 * same `seq` and therefore cannot charge twice.
 */
export function hintSpendKey(gameId: string, seat: number, seq: number): string {
  return `sudoku-hint-spend:${gameId}:${seat}:${seq}`
}

/**
 * 12-admin-console.md §7.2 — an operator adjustment is keyed by the audit row
 * that authorised it, so "the money moved" and "someone is accountable for it"
 * cannot exist apart.
 */
export function adminAdjustKey(auditLogId: string): string {
  return `admin:${auditLogId}`
}
