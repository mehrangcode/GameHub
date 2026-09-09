import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { REPO_HARNESSES } from '../../../harnesses.js'
import { botRef, guestRef, userRef } from '../../../../src/domain/value-objects/identity.js'
import { makeGuest, makeInvite, makeTable, makeUser, seat, uniq } from '../fixtures.js'

describe.each(REPO_HARNESSES)('[$name] table repositories', (harness) => {
  beforeEach(async () => {
    await harness.reset()
  })
  afterAll(async () => {
    await harness.dispose()
  })

  describe('ITableRepository — table lifecycle', () => {
    it('creates with defaults and parses options back as an object', async () => {
      const repos = harness.repos()
      const table = await repos.tables.create({
        gameSlug: 'shelem',
        options: { targetScore: 1165, strictEjection: true },
        seatCount: 4,
      })

      expect(table.status).toBe('WAITING')
      expect(table.origin).toBe('PRIVATE')
      expect(table.rewardEligible).toBe(true)
      expect(table.allowSpectators).toBe(true)
      expect(table.hostUserId).toBeNull()
      // The column is a JSON String (03 §1 rule 3); the domain never sees that.
      expect(table.options).toEqual({ targetScore: 1165, strictEjection: true })
    })

    it('lists a user’s open tables, hosted or joined', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const hosted = await makeTable(repos, { hostUserId: user.id })
      const joined = await makeTable(repos)
      await repos.tables.claimSeat(joined.id, seat(1), userRef(user.id))
      const stranger = await makeTable(repos)
      const closed = await makeTable(repos, { hostUserId: user.id })
      await repos.tables.update(closed.id, { status: 'CLOSED' })

      const ids = (await repos.tables.findOpenTablesForUser(user.id)).map((t) => t.id).sort()
      expect(ids).toEqual([hosted.id, joined.id].sort())
      expect(ids).not.toContain(stranger.id)
      expect(ids).not.toContain(closed.id)
    })

    it('returns the table with its members attached', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      await repos.tables.claimSeat(table.id, seat(0), userRef(user.id))

      const withMembers = await repos.tables.findWithMembers(table.id)
      expect(withMembers?.members).toHaveLength(1)
      expect(withMembers?.members[0]?.userId).toBe(user.id)
      expect(await repos.tables.findWithMembers('nope')).toBeNull()
    })
  })

  describe('ITableRepository — the seat race (03 §6.3)', () => {
    it('seats an occupant and reports the identity, not a payload claim', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)

      const member = await repos.tables.claimSeat(table.id, seat(2), userRef(user.id))
      expect(member?.seat).toBe(2)
      expect(member?.userId).toBe(user.id)
      expect(member?.role).toBe('PLAYER')
      expect(member?.isBot).toBe(false)
      expect(member?.timeoutStrikes).toBe(0)
    })

    it('★ returns null — never throws — when the seat is taken', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const [first, second] = [await makeUser(repos), await makeUser(repos)]

      expect(await repos.tables.claimSeat(table.id, seat(1), userRef(first.id))).not.toBeNull()
      expect(await repos.tables.claimSeat(table.id, seat(1), userRef(second.id))).toBeNull()
    })

    it('★ two simultaneous claims for one seat: exactly one wins', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const [a, b] = [await makeUser(repos), await makeUser(repos)]

      const results = await Promise.all([
        repos.tables.claimSeat(table.id, seat(3), userRef(a.id)),
        repos.tables.claimSeat(table.id, seat(3), userRef(b.id)),
      ])

      expect(results.filter((r) => r !== null)).toHaveLength(1)
      expect(await repos.tables.listMembers(table.id)).toHaveLength(1)
    })

    it('refuses to seat one identity twice — the cheapest self-collusion', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)

      await repos.tables.claimSeat(table.id, seat(0), userRef(user.id))
      expect(await repos.tables.claimSeat(table.id, seat(1), userRef(user.id))).toBeNull()
    })

    it('seats a guest and a bot alongside a user', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const guest = await makeGuest(repos, table.id)

      await repos.tables.claimSeat(table.id, seat(0), userRef(user.id))
      const seated = await repos.tables.claimSeat(table.id, seat(1), guestRef(guest.id))
      const bot = await repos.tables.claimSeat(table.id, seat(2), botRef('hard'))

      expect(seated?.guestSessionId).toBe(guest.id)
      expect(seated?.userId).toBeNull()
      expect(bot?.isBot).toBe(true)
      expect(bot?.botDifficulty).toBe('hard')
      expect(bot?.userId).toBeNull()
      expect(bot?.guestSessionId).toBeNull()
    })

    it('frees a seat so someone else can take it', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const [a, b] = [await makeUser(repos), await makeUser(repos)]

      await repos.tables.claimSeat(table.id, seat(1), userRef(a.id))
      await repos.tables.releaseSeat(table.id, seat(1))
      expect(await repos.tables.claimSeat(table.id, seat(1), userRef(b.id))).not.toBeNull()
    })

    it('releasing an empty seat is a no-op, not an error', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      await expect(repos.tables.releaseSeat(table.id, seat(3))).resolves.toBeUndefined()
    })

    it('lets several spectators coexist — NULL seats stay distinct', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const [a, b] = [await makeUser(repos), await makeUser(repos)]

      const first = await repos.tables.addSpectator(table.id, userRef(a.id))
      const second = await repos.tables.addSpectator(table.id, userRef(b.id))

      expect(first.seat).toBeNull()
      expect(first.role).toBe('SPECTATOR')
      expect(second.id).not.toBe(first.id)
      expect(await repos.tables.listMembers(table.id)).toHaveLength(2)
    })

    it('finds a member by seat and by identity', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      await repos.tables.claimSeat(table.id, seat(2), userRef(user.id))

      expect((await repos.tables.findMemberBySeat(table.id, seat(2)))?.userId).toBe(user.id)
      expect((await repos.tables.findMemberByIdentity(table.id, userRef(user.id)))?.seat).toBe(2)
      expect(await repos.tables.findMemberBySeat(table.id, seat(3))).toBeNull()
    })

    it('updates the turn-enforcement fields on a member (04 §6)', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const member = await repos.tables.claimSeat(table.id, seat(0), userRef(user.id))
      const until = new Date(Date.now() + 120_000)

      const struck = await repos.tables.updateMember(member!.id, {
        timeoutStrikes: 2,
        ejectedAt: new Date(),
        ejectionReason: 'TURN_TIMEOUT',
        reclaimableUntil: until,
        botSubstituted: true,
      })

      expect(struck.timeoutStrikes).toBe(2)
      expect(struck.ejectionReason).toBe('TURN_TIMEOUT')
      expect(struck.botSubstituted).toBe(true)
      expect(struck.reclaimableUntil?.toISOString()).toBe(until.toISOString())
    })

    it('counts only members who have not left', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const [a, b] = [await makeUser(repos), await makeUser(repos)]
      await repos.tables.claimSeat(table.id, seat(0), userRef(a.id))
      const leaver = await repos.tables.claimSeat(table.id, seat(1), userRef(b.id))

      expect(await repos.tables.countActiveMembers(table.id)).toBe(2)
      await repos.tables.updateMember(leaver!.id, { leftAt: new Date() })
      expect(await repos.tables.countActiveMembers(table.id)).toBe(1)
    })

    it('transfers a guest’s seat to their new account (the claim, 03 §7)', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const user = await makeUser(repos)
      await repos.tables.claimSeat(table.id, seat(2), guestRef(guest.id))

      const moved = await repos.tables.transferSeat(guest.id, user.id)
      expect(moved?.userId).toBe(user.id)
      expect(moved?.guestSessionId).toBeNull()
      // Same seat, same member row — the friend at the table sees nothing move.
      expect(moved?.seat).toBe(2)
      expect(await repos.tables.transferSeat('no-such-guest', user.id)).toBeNull()
    })
  })

  describe('IInviteRepository', () => {
    it('creates with unlimited uses by default', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos, { hostUserId: user.id })
      const invite = await makeInvite(repos, table.id, user.id)

      expect(invite.maxUses).toBeNull()
      expect(invite.useCount).toBe(0)
      expect(invite.revokedAt).toBeNull()
    })

    it('rejects a duplicate code', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos, { hostUserId: user.id })
      await makeInvite(repos, table.id, user.id, { code: 'SAME' })
      await expect(makeInvite(repos, table.id, user.id, { code: 'SAME' })).rejects.toThrow()
    })

    it('findValidByCode ignores revoked and expired invites', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos, { hostUserId: user.id })

      const live = await makeInvite(repos, table.id, user.id, { code: uniq('live') })
      const revoked = await makeInvite(repos, table.id, user.id, { code: uniq('rev') })
      const expired = await makeInvite(repos, table.id, user.id, {
        code: uniq('exp'),
        expiresAt: new Date(Date.now() - 1000),
      })
      await repos.invites.revoke(revoked.id, new Date())

      expect((await repos.invites.findValidByCode(live.code))?.id).toBe(live.id)
      expect(await repos.invites.findValidByCode(revoked.code)).toBeNull()
      expect(await repos.invites.findValidByCode(expired.code)).toBeNull()
      // …but the raw row is still findable, so support can explain why.
      expect(await repos.invites.findByCode(revoked.code)).not.toBeNull()
      expect(await repos.invites.findByCode(expired.code)).not.toBeNull()
    })

    it('findValidByCode ignores an invite whose uses are spent', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos, { hostUserId: user.id })
      const invite = await makeInvite(repos, table.id, user.id, { maxUses: 1 })

      await repos.invites.consumeUse(invite.id)
      expect(await repos.invites.findValidByCode(invite.code)).toBeNull()
    })

    it('consumeUse increments, then refuses past maxUses', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos, { hostUserId: user.id })
      const invite = await makeInvite(repos, table.id, user.id, { maxUses: 2 })

      expect((await repos.invites.consumeUse(invite.id))?.useCount).toBe(1)
      expect((await repos.invites.consumeUse(invite.id))?.useCount).toBe(2)
      expect(await repos.invites.consumeUse(invite.id)).toBeNull()
    })

    it('resolves a table through a live invite code and misses on a dead one', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos, { hostUserId: user.id })
      const invite = await makeInvite(repos, table.id, user.id)

      expect((await repos.tables.findByInviteCode(invite.code))?.id).toBe(table.id)
      await repos.invites.revoke(invite.id, new Date())
      expect(await repos.tables.findByInviteCode(invite.code)).toBeNull()
      expect(await repos.tables.findByInviteCode('never-existed')).toBeNull()
    })

    it('lists the invites of one table', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos, { hostUserId: user.id })
      await makeInvite(repos, table.id, user.id)
      await makeInvite(repos, table.id, user.id)

      expect(await repos.invites.listByTable(table.id)).toHaveLength(2)
    })
  })

  describe('IChatRepository', () => {
    it('appends a text message with defaults', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const message = await repos.chat.append({ tableId: table.id, userId: user.id, body: 'hi' })

      expect(message.kind).toBe('TEXT')
      expect(message.redactedAt).toBeNull()
      expect(message.guestSessionId).toBeNull()
    })

    it('stores a SYSTEM message as an i18n key with params, never English prose', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const message = await repos.chat.append({
        tableId: table.id,
        kind: 'SYSTEM',
        body: 'chat.system.playerEjected',
        params: { seat: 2, reason: 'TURN_TIMEOUT' },
      })

      expect(message.body).toBe('chat.system.playerEjected')
      expect(message.params).toEqual({ seat: 2, reason: 'TURN_TIMEOUT' })
    })

    it('lists newest first and pages backwards from a cursor', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const ids: string[] = []
      for (const body of ['one', 'two', 'three']) {
        ids.push((await repos.chat.append({ tableId: table.id, body })).id)
      }

      const page = await repos.chat.listByTable(table.id, { limit: 2 })
      expect(page).toHaveLength(2)
      expect(page[0]?.body).toBe('three')

      const next = await repos.chat.listByTable(table.id, { limit: 2, before: page[1]!.id })
      expect(next.map((m) => m.id)).toEqual([ids[0]])
    })

    it('redacts rather than deletes', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const message = await repos.chat.append({ tableId: table.id, body: 'oops' })
      const at = new Date()

      const redacted = await repos.chat.redact(message.id, at)
      expect(redacted.redactedAt?.toISOString()).toBe(at.toISOString())
      expect(await repos.chat.findById(message.id)).not.toBeNull()
    })
  })
})
