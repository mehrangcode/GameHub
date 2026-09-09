import { describe, expect, it } from 'vitest'
import {
  achievementKey,
  adminAdjustKey,
  dailyBonusKey,
  guestForfeitKey,
  guestVestKey,
  isoDay,
  matchRewardKey,
  premiumGrantKey,
} from '../../../src/domain/economy/idempotency.js'
import { holderKey, guestRef, userRef } from '../../../src/domain/value-objects/identity.js'

/**
 * The key formats, pinned character for character against
 * 10-economy-and-rewards.md §2.4's table.
 *
 * This file looks trivial and is not. A key that drifts from the format the
 * *emitting* code uses still satisfies the unique constraint — it simply
 * creates a second, parallel idempotency namespace, and the first replay after
 * a deploy pays twice. So the formats are asserted as literals rather than
 * against the functions themselves.
 */
describe('derived idempotency keys (10 §2.4, E2)', () => {
  const user = holderKey(userRef('usr_1'))
  const guest = holderKey(guestRef('gst_9'))

  it('match reward — per seat, not per user', () => {
    expect(matchRewardKey('mr_42', 2)).toBe('match:mr_42:2')
    // Two seats of one match are two different credits: an ejected player
    // earns zero while their partner is paid in full (10 §5.2).
    expect(matchRewardKey('mr_42', 3)).not.toBe(matchRewardKey('mr_42', 2))
  })

  it('daily bonus — one per holder per UTC day', () => {
    const at = new Date('2026-09-09T22:40:00.000Z')
    expect(dailyBonusKey(user, at)).toBe('daily:user:usr_1:2026-09-09')
    expect(dailyBonusKey(guest, at)).toBe('daily:guest:gst_9:2026-09-09')
  })

  it('★ the day boundary is UTC, not the server s timezone', () => {
    // A key that moved with the host's clock would not be derived: the same
    // event replayed on a machine in another zone would mint a second bonus.
    expect(isoDay(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01')
    expect(isoDay(new Date('2026-01-01T23:59:59.999Z'))).toBe('2026-01-01')
    expect(isoDay(new Date('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02')
  })

  it('achievement', () => {
    expect(achievementKey('tutorial', user)).toBe('achv:tutorial:user:usr_1')
  })

  it('premium grant — per subscription period', () => {
    expect(premiumGrantKey('sub_7', 3)).toBe('premium:sub_7:3')
  })

  it('★ guest vesting — one vest per session, ever', () => {
    // This single string is what stops one guest session from vesting into two
    // accounts, even under a retried claim (10 §3.4).
    expect(guestVestKey('gst_9')).toBe('vest:gst_9')
    expect(guestForfeitKey('gst_9')).toBe('forfeit:gst_9')
    // Vest and forfeit are distinct keys on purpose: a capped claim writes both
    // to the same guest wallet.
    expect(guestVestKey('gst_9')).not.toBe(guestForfeitKey('gst_9'))
  })

  it('admin adjustment — keyed by the audit row that authorised it', () => {
    expect(adminAdjustKey('aud_5')).toBe('admin:aud_5')
  })

  it('every builder is a pure function of its inputs', () => {
    const at = new Date('2026-09-09T10:00:00.000Z')
    expect(dailyBonusKey(user, at)).toBe(dailyBonusKey(user, at))
    expect(matchRewardKey('mr_1', 0)).toBe(matchRewardKey('mr_1', 0))
  })
})
