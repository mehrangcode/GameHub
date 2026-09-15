import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { REPO_HARNESSES } from '../../../harnesses.js'
import { findChainBreak } from '../../../../src/domain/admin/auditChain.js'
import type { NewAdminAuditEntry } from '../../../../src/domain/repositories/admin.js'
import { makeUser } from '../fixtures.js'

/**
 * ★ S48–S50's repositories, held to one contract by both implementations —
 * 12-admin-console.md §4.
 *
 * Three properties matter more than the rest:
 *
 *   1. **`IAdminAuditRepository` has no `update` and no `delete`.** Asserted
 *      *structurally*, by reflecting over each implementation, because A4 is a
 *      statement about what code exists — not about what it currently does.
 *   2. **The hash chain is computed identically on both sides.** The fake and
 *      the Prisma repository each call `computeAuditHash`; if either ever
 *      inlined its own version, `GET /audit/verify` would report a break in a
 *      log that is perfectly sound, or miss one that is not.
 *   3. **`rotate` never moves `expiresAt`.** One line in either implementation
 *      would turn the 8-hour absolute cap into a sliding window, and nothing
 *      else in the system would notice.
 */

const HOUR = 3_600_000

function entry(overrides: Partial<NewAdminAuditEntry> = {}): NewAdminAuditEntry {
  return {
    actorUserId: 'replaced-by-caller',
    actorIp: '127.0.0.1',
    actorUserAgent: 'vitest',
    requestId: 'req-contract',
    action: 'user.disable',
    targetType: 'user',
    targetId: 'target-1',
    reason: 'contract test',
    ...overrides,
  }
}

describe.each(REPO_HARNESSES)('[$name] admin repositories', (harness) => {
  beforeEach(async () => {
    await harness.reset()
  })
  afterAll(async () => {
    await harness.dispose()
  })

  describe('IAdminCredentialRepository', () => {
    it('returns null for a user with no credential row', async () => {
      const repos = harness.repos()
      expect(await repos.adminCredentials.findByUser('nobody')).toBeNull()
    })

    it('enroll writes the secret, the hashes and the timestamp — and creates the row', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      const credential = await repos.adminCredentials.enroll(user.id, {
        totpSecretEnc: 'iv:tag:ct',
        recoveryCodeHashes: ['h1', 'h2'],
        enrolledAt: at,
      })

      expect(credential.totpSecretEnc).toBe('iv:tag:ct')
      expect(credential.totpEnrolledAt?.toISOString()).toBe(at.toISOString())
      // A `string[]` in the entity, a JSON column in the schema (rule 2).
      expect(credential.recoveryCodeHashes).toEqual(['h1', 'h2'])
    })

    it('★ re-enrolling clears the replay guard and any lockout', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      await repos.adminCredentials.enroll(user.id, {
        totpSecretEnc: 'a',
        recoveryCodeHashes: [],
        enrolledAt: at,
      })
      await repos.adminCredentials.recordSuccess(user.id, 999, at)
      await repos.adminCredentials.recordFailure(user.id, at, { maxAttempts: 1, lockoutMs: HOUR })

      const fresh = await repos.adminCredentials.enroll(user.id, {
        totpSecretEnc: 'b',
        recoveryCodeHashes: ['x'],
        enrolledAt: at,
      })

      // A new secret's steps have nothing to do with the old one's, and an
      // operator who re-enrolled to escape a lockout must not still be locked.
      expect(fresh.lastTotpStep).toBeNull()
      expect(fresh.failedAttempts).toBe(0)
      expect(fresh.lockedUntil).toBeNull()
    })

    it('★ recordSuccess advances the replay guard and clears the attempt count', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const at = new Date()

      await repos.adminCredentials.enroll(user.id, {
        totpSecretEnc: 'a',
        recoveryCodeHashes: [],
        enrolledAt: at,
      })
      await repos.adminCredentials.recordFailure(user.id, at, { maxAttempts: 5, lockoutMs: HOUR })
      await repos.adminCredentials.recordSuccess(user.id, 42, at)

      const after = await repos.adminCredentials.findByUser(user.id)
      expect(after?.lastTotpStep).toBe(42)
      // A success ends a lockout — otherwise the correct code is useless.
      expect(after?.failedAttempts).toBe(0)
      expect(after?.lockedUntil).toBeNull()
    })

    it('recordFailure counts up, and locks only at the threshold', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      await repos.adminCredentials.enroll(user.id, {
        totpSecretEnc: 'a',
        recoveryCodeHashes: [],
        enrolledAt: at,
      })

      for (let i = 1; i < 3; i += 1) {
        const row = await repos.adminCredentials.recordFailure(user.id, at, {
          maxAttempts: 3,
          lockoutMs: HOUR,
        })
        expect(row.failedAttempts).toBe(i)
        expect(row.lockedUntil).toBeNull()
      }

      const locked = await repos.adminCredentials.recordFailure(user.id, at, {
        maxAttempts: 3,
        lockoutMs: HOUR,
      })
      expect(locked.failedAttempts).toBe(3)
      expect(locked.lockedUntil?.toISOString()).toBe(new Date(at.getTime() + HOUR).toISOString())
    })

    it('★ a recovery code is single-use, and spending an absent one changes nothing', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const at = new Date()

      await repos.adminCredentials.enroll(user.id, {
        totpSecretEnc: 'a',
        recoveryCodeHashes: ['h1', 'h2', 'h3'],
        enrolledAt: at,
      })

      expect(await repos.adminCredentials.consumeRecoveryCode(user.id, 'h2')).toBe(true)
      // The second attempt on the same code is the case that matters: two
      // requests must not both succeed with one code.
      expect(await repos.adminCredentials.consumeRecoveryCode(user.id, 'h2')).toBe(false)
      expect(await repos.adminCredentials.consumeRecoveryCode(user.id, 'nope')).toBe(false)

      expect((await repos.adminCredentials.findByUser(user.id))?.recoveryCodeHashes).toEqual([
        'h1',
        'h3',
      ])
    })

    it('consuming for an unknown user is false, not a throw', async () => {
      const repos = harness.repos()
      expect(await repos.adminCredentials.consumeRecoveryCode('nobody', 'h1')).toBe(false)
    })
  })

  describe('IAdminSessionRepository', () => {
    async function session(repos: ReturnType<typeof harness.repos>, userId: string) {
      const now = new Date('2026-09-15T10:00:00.000Z')
      return repos.adminSessions.create({
        userId,
        tokenHash: `hash-${userId}`,
        ip: '127.0.0.1',
        userAgent: 'vitest',
        mfaAt: now,
        expiresAt: new Date(now.getTime() + 8 * HOUR),
      })
    }

    it('creates and reads back by id and by token hash', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const created = await session(repos, user.id)

      expect(await repos.adminSessions.findById(created.id)).toMatchObject({ id: created.id })
      expect(await repos.adminSessions.findByTokenHash(created.tokenHash)).toMatchObject({
        id: created.id,
      })
      expect(created.revokedAt).toBeNull()
    })

    it('★★ rotate replaces the token hash and NEVER moves the absolute cap', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const created = await session(repos, user.id)
      const later = new Date(created.createdAt.getTime() + 2 * HOUR)

      const rotated = await repos.adminSessions.rotate(created.id, 'rotated-hash', later)

      expect(rotated.tokenHash).toBe('rotated-hash')
      expect(rotated.lastSeenAt.toISOString()).toBe(later.toISOString())
      // The single assertion that keeps an 8-hour cap from becoming a session
      // that renews itself for ever.
      expect(rotated.expiresAt.toISOString()).toBe(created.expiresAt.toISOString())
      expect(await repos.adminSessions.findByTokenHash(created.tokenHash)).toBeNull()
    })

    it('refreshMfa advances mfaAt — the step-up window restarts there', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const created = await session(repos, user.id)
      const later = new Date(created.mfaAt.getTime() + HOUR)

      const refreshed = await repos.adminSessions.refreshMfa(created.id, later)
      expect(refreshed.mfaAt.toISOString()).toBe(later.toISOString())
      expect(refreshed.expiresAt.toISOString()).toBe(created.expiresAt.toISOString())
    })

    it('revoke is idempotent, and revoking an unknown id does not throw', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const created = await session(repos, user.id)
      const at = new Date()

      await repos.adminSessions.revoke(created.id, at)
      const first = await repos.adminSessions.findById(created.id)

      await repos.adminSessions.revoke(created.id, new Date(at.getTime() + HOUR))
      const second = await repos.adminSessions.findById(created.id)

      // The second revoke must not rewrite the timestamp: when a session died
      // is a fact, and the first answer is the true one.
      expect(second?.revokedAt?.toISOString()).toBe(first?.revokedAt?.toISOString())
      await expect(repos.adminSessions.revoke('no-such-session', at)).resolves.toBeUndefined()
    })

    it('revokeAllForUser touches only live sessions, and reports how many', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const other = await makeUser(repos, { email: 'other@t.dev' })
      const now = new Date()

      const a = await repos.adminSessions.create({
        userId: user.id,
        tokenHash: 'a',
        ip: '127.0.0.1',
        userAgent: 'v',
        mfaAt: now,
        expiresAt: new Date(now.getTime() + 8 * HOUR),
      })
      await repos.adminSessions.create({
        userId: user.id,
        tokenHash: 'b',
        ip: '127.0.0.1',
        userAgent: 'v',
        mfaAt: now,
        expiresAt: new Date(now.getTime() + 8 * HOUR),
      })
      await repos.adminSessions.create({
        userId: other.id,
        tokenHash: 'c',
        ip: '127.0.0.1',
        userAgent: 'v',
        mfaAt: now,
        expiresAt: new Date(now.getTime() + 8 * HOUR),
      })
      await repos.adminSessions.revoke(a.id, now)

      expect(await repos.adminSessions.revokeAllForUser(user.id, now)).toBe(1)
      expect(await repos.adminSessions.listActiveByUser(user.id, now)).toHaveLength(0)
      expect(await repos.adminSessions.listActiveByUser(other.id, now)).toHaveLength(1)
    })

    it('listActiveByUser excludes expired and revoked rows', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const now = new Date('2026-09-15T10:00:00.000Z')

      await repos.adminSessions.create({
        userId: user.id,
        tokenHash: 'expired',
        ip: '127.0.0.1',
        userAgent: 'v',
        mfaAt: now,
        expiresAt: new Date(now.getTime() - HOUR),
      })
      await session(repos, user.id)

      expect(await repos.adminSessions.listActiveByUser(user.id, now)).toHaveLength(1)
    })

    it('deleteExpired removes only what is past its cap', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const now = new Date('2026-09-15T10:00:00.000Z')

      await repos.adminSessions.create({
        userId: user.id,
        tokenHash: 'expired',
        ip: '127.0.0.1',
        userAgent: 'v',
        mfaAt: now,
        expiresAt: new Date(now.getTime() - HOUR),
      })
      const live = await session(repos, user.id)

      expect(await repos.adminSessions.deleteExpired(now)).toBe(1)
      expect(await repos.adminSessions.findById(live.id)).not.toBeNull()
    })
  })

  describe('★ IAdminAuditRepository — append-only (A4)', () => {
    it('★★ declares NO update and NO delete — the guarantee is structural', () => {
      const repos = harness.repos()
      const audit = repos.adminAudit as unknown as Record<string, unknown>

      // Not "they throw": they do not exist. A method that threw would still be
      // a method somebody could decide to make work during an incident at 3am.
      for (const forbidden of ['update', 'delete', 'deleteMany', 'deleteExpired', 'prune']) {
        expect(audit[forbidden]).toBeUndefined()
      }
      // And the same, one level up, so an inherited method cannot sneak in.
      const proto = Object.getPrototypeOf(repos.adminAudit) as object
      expect(Object.getOwnPropertyNames(proto)).not.toContain('update')
      expect(Object.getOwnPropertyNames(proto)).not.toContain('delete')
    })

    it('appends a row, parsing before/after back into objects', async () => {
      const repos = harness.repos()
      const actor = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      const row = await repos.adminAudit.append(
        entry({
          actorUserId: actor.id,
          before: { status: 'ACTIVE' },
          after: { status: 'DISABLED' },
        }),
        at,
      )

      expect(row.before).toEqual({ status: 'ACTIVE' })
      expect(row.after).toEqual({ status: 'DISABLED' })
      expect(row.reason).toBe('contract test')
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('★ the first row is the genesis link — prevHash is null exactly once', async () => {
      const repos = harness.repos()
      const actor = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      const first = await repos.adminAudit.append(entry({ actorUserId: actor.id }), at)
      const second = await repos.adminAudit.append(
        entry({ actorUserId: actor.id }),
        new Date(at.getTime() + 1000),
      )

      expect(first.prevHash).toBeNull()
      expect(second.prevHash).toBe(first.hash)
    })

    it('★★ the chain verifies across a run of rows, on both implementations', async () => {
      const repos = harness.repos()
      const actor = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      for (let i = 0; i < 12; i += 1) {
        await repos.adminAudit.append(
          entry({ actorUserId: actor.id, targetId: `user-${i}`, after: { i } }),
          new Date(at.getTime() + i * 1000),
        )
      }

      const all = await repos.adminAudit.listForVerification()
      expect(all).toHaveLength(12)
      // The property `GET /audit/verify` rests on. If the fake and the Prisma
      // repository ever hashed differently, this passes for one and fails for
      // the other — which is exactly what running the suite twice is for.
      expect(findChainBreak(all)).toBeNull()
    })

    it('latest() is the chain tip', async () => {
      const repos = harness.repos()
      const actor = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      expect(await repos.adminAudit.latest()).toBeNull()

      await repos.adminAudit.append(entry({ actorUserId: actor.id }), at)
      const last = await repos.adminAudit.append(
        entry({ actorUserId: actor.id }),
        new Date(at.getTime() + 1000),
      )

      expect((await repos.adminAudit.latest())?.id).toBe(last.id)
      expect(await repos.adminAudit.count()).toBe(2)
    })

    it('lists newest-first and filters by actor, action and target', async () => {
      const repos = harness.repos()
      const actor = await makeUser(repos)
      const other = await makeUser(repos, { email: 'other@t.dev' })
      const at = new Date('2026-09-15T10:00:00.000Z')

      await repos.adminAudit.append(entry({ actorUserId: actor.id, action: 'user.disable' }), at)
      await repos.adminAudit.append(
        entry({ actorUserId: other.id, action: 'wallet.adjust', targetType: 'wallet' }),
        new Date(at.getTime() + 1000),
      )

      const newest = await repos.adminAudit.list()
      expect(newest[0]?.action).toBe('wallet.adjust')

      expect(await repos.adminAudit.list({ actorUserId: actor.id })).toHaveLength(1)
      expect(await repos.adminAudit.list({ action: 'wallet.adjust' })).toHaveLength(1)
      expect(await repos.adminAudit.list({ targetType: 'wallet' })).toHaveLength(1)
      expect(await repos.adminAudit.list({ targetType: 'table' })).toHaveLength(0)
    })

    it('listForVerification walks OLDEST first — the chain is an ordering', async () => {
      const repos = harness.repos()
      const actor = await makeUser(repos)
      const at = new Date('2026-09-15T10:00:00.000Z')

      const first = await repos.adminAudit.append(entry({ actorUserId: actor.id }), at)
      await repos.adminAudit.append(entry({ actorUserId: actor.id }), new Date(at.getTime() + 1000))

      const walked = await repos.adminAudit.listForVerification()
      // Verifying newest-first would report a break in a perfectly sound log.
      expect(walked[0]?.id).toBe(first.id)
      expect(await repos.adminAudit.listForVerification(first.id)).toHaveLength(1)
    })
  })
})
