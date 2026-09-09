import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { REPO_HARNESSES } from '../../../harnesses.js'
import { EmailTakenError, NotFoundError } from '../../../../src/domain/errors/errors.js'
import { makeGuest, makeTable, makeUser, uniq } from '../fixtures.js'

describe.each(REPO_HARNESSES)('[$name] identity repositories', (harness) => {
  beforeEach(async () => {
    await harness.reset()
  })
  afterAll(async () => {
    await harness.dispose()
  })

  describe('IUserRepository', () => {
    it('creates a user with schema defaults applied', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)

      expect(user.id).toBeTruthy()
      expect(user.role).toBe('USER')
      expect(user.status).toBe('ACTIVE')
      expect(user.locale).toBe('en')
      expect(user.avatarKind).toBe('preset')
      expect(user.emailVerified).toBe(false)
      expect(user.lastSeenAt).toBeNull()
      expect(user.createdAt).toBeInstanceOf(Date)
    })

    it('finds by id and by email, and misses cleanly', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos, { email: 'find@test.dev' })

      expect((await repos.users.findById(user.id))?.id).toBe(user.id)
      expect((await repos.users.findByEmail('find@test.dev'))?.id).toBe(user.id)
      expect(await repos.users.findById('nope')).toBeNull()
      expect(await repos.users.findByEmail('nobody@test.dev')).toBeNull()
    })

    it('★ rejects a duplicate email with EmailTakenError, not a raw driver error', async () => {
      const repos = harness.repos()
      await makeUser(repos, { email: 'dupe@test.dev' })

      // The unique constraint is the arbiter, and the repository is where a
      // constraint becomes a domain error — so `AuthService.register` needs no
      // read-then-write check, which would be wrong under concurrency anyway.
      await expect(makeUser(repos, { email: 'dupe@test.dev' })).rejects.toThrow(EmailTakenError)
    })

    it('patches only the supplied fields', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const updated = await repos.users.update(user.id, { displayName: 'Renamed' })

      expect(updated.displayName).toBe('Renamed')
      expect(updated.email).toBe(user.email)
      expect(updated.role).toBe('USER')
    })

    it('throws NotFoundError when updating or deleting a missing row', async () => {
      const repos = harness.repos()
      await expect(repos.users.update('nope', { displayName: 'x' })).rejects.toThrow(NotFoundError)
      await expect(repos.users.delete('nope')).rejects.toThrow(NotFoundError)
    })

    it('deletes', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await repos.users.delete(user.id)
      expect(await repos.users.findById(user.id)).toBeNull()
    })

    it('touches lastSeenAt without a full update', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const at = new Date('2026-01-01T00:00:00.000Z')

      await repos.users.touchLastSeen(user.id, at)
      expect((await repos.users.findById(user.id))?.lastSeenAt?.toISOString()).toBe(
        at.toISOString(),
      )
    })
  })

  describe('IGuestSessionRepository', () => {
    it('creates a guest bound to exactly one table', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)

      expect(guest.tableId).toBe(table.id)
      expect(guest.claimedAt).toBeNull()
      expect(guest.claimedByUserId).toBeNull()
      expect(guest.locale).toBe('en')
    })

    it('finds by token hash', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id, { tokenHash: 'known-hash' })

      expect((await repos.guests.findByTokenHash('known-hash'))?.id).toBe(guest.id)
      expect(await repos.guests.findByTokenHash('other')).toBeNull()
    })

    it('rejects a duplicate token hash', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      await makeGuest(repos, table.id, { tokenHash: 'same' })
      await expect(makeGuest(repos, table.id, { tokenHash: 'same' })).rejects.toThrow()
    })

    it('lists the guests of one table only', async () => {
      const repos = harness.repos()
      const [a, b] = [await makeTable(repos), await makeTable(repos)]
      await makeGuest(repos, a.id)
      await makeGuest(repos, a.id)
      await makeGuest(repos, b.id)

      expect(await repos.guests.listByTable(a.id)).toHaveLength(2)
      expect(await repos.guests.listByTable(b.id)).toHaveLength(1)
    })

    it('marks a guest claimed, keeping the row for audit', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const user = await makeUser(repos)
      const at = new Date('2026-02-02T10:00:00.000Z')

      const claimed = await repos.guests.claimIfUnclaimed(guest.id, user.id, at)
      expect(claimed?.claimedByUserId).toBe(user.id)
      expect(claimed?.claimedAt?.toISOString()).toBe(at.toISOString())
      // The row survives — a claimed guest is history, not a deletion.
      expect(await repos.guests.findById(guest.id)).not.toBeNull()
    })

    it('★ a second claim of the same session loses, and changes nothing', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const [first, second] = [await makeUser(repos), await makeUser(repos)]
      const at = new Date('2026-02-02T10:00:00.000Z')

      expect(await repos.guests.claimIfUnclaimed(guest.id, first.id, at)).not.toBeNull()
      // This is what makes S22 race-safe: the loser gets null and unwinds its
      // whole transaction rather than overwriting the winner's attribution.
      expect(
        await repos.guests.claimIfUnclaimed(guest.id, second.id, new Date(at.getTime() + 1000)),
      ).toBeNull()

      const settled = await repos.guests.findById(guest.id)
      expect(settled?.claimedByUserId).toBe(first.id)
      expect(settled?.claimedAt?.toISOString()).toBe(at.toISOString())
    })

    it('claiming an unknown session is null, not a throw', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      expect(await repos.guests.claimIfUnclaimed('no-such-guest', user.id, new Date())).toBeNull()
    })

    it('deletes only sessions that have actually expired', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const now = new Date('2026-03-01T00:00:00.000Z')
      const stale = await makeGuest(repos, table.id, {
        expiresAt: new Date(now.getTime() - 1000),
      })
      const live = await makeGuest(repos, table.id, {
        expiresAt: new Date(now.getTime() + 60_000),
      })

      expect(await repos.guests.deleteExpired(now)).toBe(1)
      expect(await repos.guests.findById(stale.id)).toBeNull()
      expect(await repos.guests.findById(live.id)).not.toBeNull()
    })
  })

  describe('IRefreshTokenRepository', () => {
    const makeToken = async (userId: string, familyId: string, tokenHash = uniq('t')) => {
      const repos = harness.repos()
      return repos.refreshTokens.create({
        userId,
        tokenHash,
        familyId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    }

    it('creates and finds by token hash', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const token = await makeToken(user.id, 'fam-1', 'hash-1')

      expect(token.revokedAt).toBeNull()
      expect((await repos.refreshTokens.findByTokenHash('hash-1'))?.id).toBe(token.id)
    })

    it('lists only live tokens for a user', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const now = new Date()
      const live = await makeToken(user.id, 'fam-1')
      const revoked = await makeToken(user.id, 'fam-1')
      await repos.refreshTokens.revoke(revoked.id, now)
      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: uniq('t'),
        familyId: 'fam-1',
        expiresAt: new Date(now.getTime() - 1000), // already expired
      })

      const active = await repos.refreshTokens.listActiveByUser(user.id, now)
      expect(active.map((t) => t.id)).toEqual([live.id])
    })

    it('records the replacement on rotation', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const old = await makeToken(user.id, 'fam-1')
      const fresh = await makeToken(user.id, 'fam-1')

      const revoked = await repos.refreshTokens.revoke(old.id, new Date(), fresh.id)
      expect(revoked.replacedById).toBe(fresh.id)
      expect(revoked.revokedAt).toBeInstanceOf(Date)
    })

    it('revokes an entire family and leaves other families alone (03 §6.2)', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await makeToken(user.id, 'compromised')
      await makeToken(user.id, 'compromised')
      const other = await makeToken(user.id, 'healthy')

      expect(await repos.refreshTokens.revokeFamily('compromised', new Date())).toBe(2)
      expect((await repos.refreshTokens.findById(other.id))?.revokedAt).toBeNull()
    })

    it('★ revokeIfActive: exactly one of two concurrent rotations wins', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const token = await makeToken(user.id, 'fam-1')

      // Both racers already read the row as active. Only one may claim it —
      // otherwise two live refresh tokens exist in one family and the chain is
      // no longer a chain.
      const outcomes = await Promise.all([
        repos.refreshTokens.revokeIfActive(token.id, new Date()),
        repos.refreshTokens.revokeIfActive(token.id, new Date()),
      ])

      expect(outcomes.filter(Boolean)).toHaveLength(1)
      expect((await repos.refreshTokens.findById(token.id))?.revokedAt).toBeInstanceOf(Date)
    })

    it('revokeIfActive reports false for a missing or already-revoked token', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const token = await makeToken(user.id, 'fam-1')
      await repos.refreshTokens.revoke(token.id, new Date())

      expect(await repos.refreshTokens.revokeIfActive(token.id, new Date())).toBe(false)
      expect(await repos.refreshTokens.revokeIfActive('nope', new Date())).toBe(false)
    })

    it('revoking a family twice revokes nothing the second time', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await makeToken(user.id, 'fam-1')

      expect(await repos.refreshTokens.revokeFamily('fam-1', new Date())).toBe(1)
      expect(await repos.refreshTokens.revokeFamily('fam-1', new Date())).toBe(0)
    })

    it('sweeps expired tokens and keeps live ones', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const now = new Date()
      const live = await makeToken(user.id, 'fam-1')
      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: uniq('t'),
        familyId: 'fam-1',
        expiresAt: new Date(now.getTime() - 1000),
      })

      expect(await repos.refreshTokens.deleteExpired(now)).toBe(1)
      expect(await repos.refreshTokens.findById(live.id)).not.toBeNull()
    })
  })

  describe('IPreferencesRepository', () => {
    it('returns null for a user who has never set preferences', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      expect(await repos.preferences.findByUser(user.id)).toBeNull()
    })

    it('creates on first upsert with the documented defaults', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const prefs = await repos.preferences.upsert(user.id, {})

      expect(prefs.theme).toBe('system')
      expect(prefs.numeralSystem).toBe('auto')
      expect(prefs.soundVolume).toBe(70)
      expect(prefs.showLegalMoveHints).toBe(true)
    })

    it('patches on subsequent upserts without resetting the rest', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await repos.preferences.upsert(user.id, { theme: 'dark', soundVolume: 10 })
      const prefs = await repos.preferences.upsert(user.id, { locale: 'fa' })

      expect(prefs.locale).toBe('fa')
      expect(prefs.theme).toBe('dark')
      expect(prefs.soundVolume).toBe(10)
    })
  })

  describe('ISecurityEventRepository', () => {
    it('records with INFO severity by default', async () => {
      const repos = harness.repos()
      const event = await repos.securityEvents.record({ kind: 'BAD_TOKEN' })

      expect(event.severity).toBe('INFO')
      expect(event.createdAt).toBeInstanceOf(Date)
      expect(event.userId).toBeNull()
    })

    it('round-trips structured details rather than a rendered sentence', async () => {
      const repos = harness.repos()
      const event = await repos.securityEvents.record({
        kind: 'ILLEGAL_MOVE',
        severity: 'WARN',
        details: { attempted: 'AS', reason: 'not in hand' },
      })

      expect(event.details).toEqual({ attempted: 'AS', reason: 'not in hand' })
    })

    it('filters by kind and by user', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await repos.securityEvents.record({ kind: 'ILLEGAL_MOVE', userId: user.id })
      await repos.securityEvents.record({ kind: 'RATE_LIMIT' })

      expect(await repos.securityEvents.list({ kind: 'ILLEGAL_MOVE' })).toHaveLength(1)
      expect(await repos.securityEvents.list({ userId: user.id })).toHaveLength(1)
      expect(await repos.securityEvents.list()).toHaveLength(2)
    })

    it('counts a kind since a moment', async () => {
      const repos = harness.repos()
      const before = new Date(Date.now() - 60_000)
      await repos.securityEvents.record({ kind: 'SEAT_IMPERSONATION' })

      expect(await repos.securityEvents.countSince('SEAT_IMPERSONATION', before)).toBe(1)
      expect(
        await repos.securityEvents.countSince('SEAT_IMPERSONATION', new Date(Date.now() + 60_000)),
      ).toBe(0)
    })
  })
})
