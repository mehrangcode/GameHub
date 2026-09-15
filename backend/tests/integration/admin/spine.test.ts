import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { computeAuditHash, toChainInput } from '../../../src/domain/admin/auditChain.js'
import { ADMIN_ROUTES, fullPath, rolesFor } from '../../../src/interface/admin/manifest.js'
import { mountManifest } from '../../../src/interface/admin/routes/adminRouter.js'
import { hashPassword } from '../../../src/infrastructure/auth/password.js'
import { totpCodeAt } from '../../../src/infrastructure/admin/totp.js'
import { buildTestAdminApp, uniqueSuffix, type TestAdminApp } from '../../helpers/app.js'
import { db, resetDb } from '../../helpers/db.js'

/**
 * ★★ S50 — the audit spine, driven by the route manifest.
 *
 * 12-admin-console.md §10 tests 2, 3, 4, 6 and 13, and the reason they are all
 * in one file: each of them iterates `ADMIN_ROUTES`, so **adding a route adds a
 * test case automatically**. A new mutating endpoint that forgets `withAudit`,
 * a new `ADMIN`-only route that forgets its role guard, a new 📝 route that
 * treats `reason` as a UI placeholder — each fails here, on the commit that
 * introduced it, rather than being discovered as a gap in the history a year
 * later by the one person who needed the history.
 */

const PASSWORD = 'correct-horse-battery-admin'
const BASE = '/admin/api/v1'

interface Seeded {
  id: string
  email: string
}

async function seedUser(role: 'ADMIN' | 'SUPPORT' | 'USER'): Promise<Seeded> {
  const email = `spine-${uniqueSuffix()}@test.dev`
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), displayName: 'Ops', role },
  })
  if (role !== 'USER') {
    await db.adminCredential.create({ data: { userId: user.id, totpSecretEnc: '' } })
  }
  return { id: user.id, email }
}

async function signIn(harness: TestAdminApp, admin: Seeded) {
  const agent = request.agent(harness.app)
  const login = await agent.post(`${BASE}/auth/login`).send({ email: admin.email, password: PASSWORD })
  const enrolled = await agent
    .post(`${BASE}/auth/totp/enroll`)
    .send({ challengeId: login.body.challengeId })
  const secret = enrolled.body.secret as string

  const mfa = await agent
    .post(`${BASE}/auth/mfa`)
    .send({ challengeId: enrolled.body.challengeId, code: totpCodeAt(secret, Date.now()) })
  expect(mfa.status).toBe(200)

  return { agent, secret }
}

/** Every mutating route, with a body that would succeed if the guards allowed it. */
const MUTATING_FIXTURES: Record<string, { body: () => Record<string, unknown> }> = {
  'users.disable': { body: () => ({ reason: 'manifest-driven test' }) },
}

describe('★★ the admin spine (S50)', () => {
  let harness: TestAdminApp

  beforeAll(async () => {
    await resetDb()
    harness = buildTestAdminApp()
  })

  afterAll(async () => {
    await resetDb()
  })

  beforeEach(() => {
    harness.resetLimits()
  })

  describe('the manifest and the router cannot disagree', () => {
    it('every declared route has a controller — asserted at construction', () => {
      // `mountManifest` throws for a spec with no handler, so the fact that the
      // app built at all is the assertion. This makes it explicit.
      expect(() => buildTestAdminApp()).not.toThrow()
    })

    it('★ a manifest entry with no controller is a startup failure, not a 404', () => {
      expect(() =>
        mountManifest(harness.services, {}, [
          {
            key: 'ghost.route',
            method: 'get',
            path: '/ghost',
            role: 'ADMIN',
            mutating: false,
            requiresStepUp: false,
            requiresReason: false,
          },
        ]),
      ).toThrow(/no controller/)
    })

    it('★ a mutating entry with no action is a startup failure', () => {
      // Without an action the audit-completeness test below has nothing to
      // assert against, so the omission must not be silently allowed.
      expect(() =>
        mountManifest(harness.services, { 'x.y': (_req, res) => res.json({}) }, [
          {
            key: 'x.y',
            method: 'post',
            path: '/x',
            role: 'ADMIN',
            mutating: true,
            requiresStepUp: false,
            requiresReason: false,
          },
        ]),
      ).toThrow(/declares no action/)
    })

    it('every mutating route in the manifest has a fixture in this file', () => {
      // The guard on the guard: a mutating route added without a fixture would
      // silently skip the audit-completeness case below.
      for (const spec of ADMIN_ROUTES.filter((route) => route.mutating)) {
        expect(MUTATING_FIXTURES[spec.key], `no fixture for ${spec.key}`).toBeDefined()
      }
    })
  })

  describe('★★ audit completeness — every mutating route writes exactly one row', () => {
    it.each(ADMIN_ROUTES.filter((spec) => spec.mutating))(
      '$key produces exactly one AdminAuditLog row carrying $action',
      async (spec) => {
        const admin = await seedUser('ADMIN')
        const target = await seedUser('USER')
        const { agent } = await signIn(harness, admin)

        const before = await db.adminAuditLog.count()
        const res = await agent[spec.method](
          fullPath(spec).replace(':id', target.id),
        ).send(MUTATING_FIXTURES[spec.key]!.body())

        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)

        const rows = await db.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' } })
        // ★ Exactly one. Two would mean the wrapper ran twice; zero means the
        // endpoint wrote state with no record of who did it — which is the
        // failure this whole file exists to make impossible to ship.
        expect(rows.length - before).toBe(1)

        const row = rows[0]!
        expect(row.action).toBe(spec.action)
        expect(row.actorUserId).toBe(admin.id)
        expect(row.targetId).toBe(target.id)
        expect(row.requestId).toBeTruthy()
        expect(row.actorIp).toBeTruthy()
        expect(row.reason).toBeTruthy()
      },
    )

    it('★ and a rollback leaves NO row — the audit row shares the transaction', async () => {
      const admin = await seedUser('ADMIN')
      const { agent } = await signIn(harness, admin)
      const before = await db.adminAuditLog.count()

      // A target that does not exist: the service throws inside `withAudit`,
      // after the wrapper has opened its transaction.
      const res = await agent
        .post(`${BASE}/users/no-such-user/disable`)
        .send({ reason: 'rollback test' })

      expect(res.status).toBe(404)
      // If the audit row were written outside the transaction, this would be
      // `before + 1` and the log would claim something that never happened.
      expect(await db.adminAuditLog.count()).toBe(before)
    })
  })

  describe('★ RBAC matrix — SUPPORT against every ADMIN-only route (§10 test 3)', () => {
    const adminOnly = ADMIN_ROUTES.filter((spec) => !rolesFor(spec).includes('SUPPORT'))

    it('there is at least one ADMIN-only route to check', () => {
      expect(adminOnly.length).toBeGreaterThan(0)
    })

    it.each(adminOnly)('SUPPORT is 403 on $method $path', async (spec) => {
      const support = await seedUser('SUPPORT')
      const { agent } = await signIn(harness, support)

      const res = await agent[spec.method](fullPath(spec).replace(':id', 'anything')).send({
        reason: 'probe',
      })

      expect(res.status).toBe(403)
      expect(res.body.code).toBe('FORBIDDEN')
      expect(res.body.details.reason).toBe('ROLE_REQUIRED')
    })

    it.each(ADMIN_ROUTES.filter((spec) => rolesFor(spec).includes('SUPPORT')))(
      'SUPPORT is NOT refused on $method $path for role reasons',
      async (spec) => {
        const support = await seedUser('SUPPORT')
        const { agent } = await signIn(harness, support)

        const res = await agent[spec.method](fullPath(spec).replace(':id', 'anything')).send({
          reason: 'probe',
        })

        // It may well fail for another reason (a missing target, a stale
        // factor). What it must not be is a role refusal — otherwise SUPPORT
        // silently has no capabilities and nobody notices for a milestone.
        expect(res.body?.details?.reason).not.toBe('ROLE_REQUIRED')
      },
    )
  })

  describe('★ reason enforcement — §10 test 6', () => {
    it.each(ADMIN_ROUTES.filter((spec) => spec.requiresReason))(
      '$key without a reason is REASON_REQUIRED, and writes nothing',
      async (spec) => {
        const admin = await seedUser('ADMIN')
        const target = await seedUser('USER')
        const { agent } = await signIn(harness, admin)
        const before = await db.adminAuditLog.count()

        for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
          const res = await agent[spec.method](fullPath(spec).replace(':id', target.id)).send(body)

          expect(res.status).toBe(400)
          expect(res.body.code).toBe('REASON_REQUIRED')
        }

        // Refused before the transaction opens, so nothing moved.
        expect(await db.adminAuditLog.count()).toBe(before)
        expect((await db.user.findUnique({ where: { id: target.id } }))?.status).toBe('ACTIVE')
      },
    )
  })

  describe('★ step-up — §10 test 4', () => {
    it.each(ADMIN_ROUTES.filter((spec) => spec.requiresStepUp))(
      '$key with a stale mfaAt is STEP_UP_REQUIRED, and changes NO state',
      async (spec) => {
        const admin = await seedUser('ADMIN')
        const target = await seedUser('USER')
        const { agent } = await signIn(harness, admin)

        // Age the factor past the 5-minute window.
        await db.adminSession.updateMany({
          where: { userId: admin.id },
          data: { mfaAt: new Date(Date.now() - 10 * 60_000) },
        })

        const before = await db.adminAuditLog.count()
        const res = await agent[spec.method](fullPath(spec).replace(':id', target.id)).send(
          MUTATING_FIXTURES[spec.key]?.body() ?? { reason: 'probe' },
        )

        expect(res.status).toBe(401)
        expect(res.body.code).toBe('STEP_UP_REQUIRED')
        // ★ The half that makes it a control rather than a dialog.
        expect(await db.adminAuditLog.count()).toBe(before)
        expect((await db.user.findUnique({ where: { id: target.id } }))?.status).toBe('ACTIVE')
      },
    )
  })

  describe('★★ disabling a player costs them NOTHING — invariant A8', () => {
    it('changes status, revokes every session, and touches no wallet', async () => {
      const admin = await seedUser('ADMIN')
      const target = await seedUser('USER')
      const { agent } = await signIn(harness, admin)

      // Two refresh families — a phone and a laptop — plus some coins.
      for (const familyId of ['fam-a', 'fam-b']) {
        await db.refreshToken.create({
          data: {
            userId: target.id,
            tokenHash: `hash-${familyId}`,
            familyId,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        })
      }
      const wallet = await db.wallet.create({
        data: { userId: target.id, assetCode: 'COIN', balance: 500 },
      })
      await db.walletTransaction.create({
        data: {
          walletId: wallet.id,
          assetCode: 'COIN',
          kind: 'MATCH_REWARD',
          amount: 500,
          balanceAfter: 500,
          idempotencyKey: `seed:${target.id}`,
        },
      })

      const res = await agent
        .post(`${BASE}/users/${target.id}/disable`)
        .send({ reason: 'investigating a report' })

      expect(res.status).toBe(200)
      expect(res.body.user.status).toBe('DISABLED')
      expect(res.body.user.statusReason).toBe('investigating a report')
      // Both families, not just the newest — a laptop left signed in would
      // otherwise keep minting access tokens for thirty days.
      expect(res.body.refreshFamiliesRevoked).toBe(2)

      const after = await db.user.findUnique({ where: { id: target.id } })
      expect(after?.statusChangedBy).toBe(admin.id)
      expect(await db.refreshToken.count({ where: { userId: target.id, revokedAt: null } })).toBe(0)

      // ★★ A8. Forfeiture punishes idling, not operations: an operator looking
      // into a report must not be able to fine the person they are looking into.
      expect((await db.wallet.findUnique({ where: { id: wallet.id } }))?.balance).toBe(500)
      expect(await db.walletTransaction.count({ where: { walletId: wallet.id } })).toBe(1)
    })

    it('★ writes a ControlCommand in the same transaction, linked to its audit row', async () => {
      const admin = await seedUser('ADMIN')
      const target = await seedUser('USER')
      const { agent } = await signIn(harness, admin)

      const res = await agent
        .post(`${BASE}/users/${target.id}/disable`)
        .send({ reason: 'outbox test' })

      const command = await db.controlCommand.findUnique({
        where: { id: res.body.controlCommandId as string },
      })

      expect(command?.kind).toBe('user.disabled')
      expect(JSON.parse(command!.payloadJson)).toEqual({ userId: target.id })
      // The link that makes "who ordered this, and why" answerable from the
      // gateway's log line when the consumer lands at M3.
      expect(command?.auditLogId).toBe(res.body.auditLogId)
      expect(command?.consumedAt).toBeNull()
    })

    it('an admin cannot disable themselves', async () => {
      const admin = await seedUser('ADMIN')
      const { agent } = await signIn(harness, admin)

      const res = await agent
        .post(`${BASE}/users/${admin.id}/disable`)
        .send({ reason: 'two tabs open' })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('SELF_TARGET_FORBIDDEN')
      expect((await db.user.findUnique({ where: { id: admin.id } }))?.status).toBe('ACTIVE')
    })
  })

  describe('★★ the hash chain — §10 test 13', () => {
    /**
     * A clean log per case, and this block is the only one that needs it: two
     * of the tests below deliberately break the chain, and a broken chain stays
     * broken for every later verification. Without this, the *first* tampering
     * test would mask every one after it — which is precisely the failure mode
     * the chain exists to make visible, arriving here as a confusing red test.
     */
    beforeEach(async () => {
      await resetDb()
    })

    it('verifies clean over a run of real actions', async () => {
      const admin = await seedUser('ADMIN')
      const { agent } = await signIn(harness, admin)

      for (let i = 0; i < 4; i += 1) {
        const target = await seedUser('USER')
        await agent.post(`${BASE}/users/${target.id}/disable`).send({ reason: `chain ${i}` })
      }

      const res = await agent.get(`${BASE}/audit/verify`)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.checked).toBeGreaterThan(4)
      expect(res.body.brokenAt).toBeNull()
    })

    it('★★ a row deleted directly in SQL is reported, at the right index', async () => {
      const admin = await seedUser('ADMIN')
      const { agent } = await signIn(harness, admin)

      for (let i = 0; i < 4; i += 1) {
        const target = await seedUser('USER')
        await agent.post(`${BASE}/users/${target.id}/disable`).send({ reason: `chain ${i}` })
      }

      const ordered = await db.adminAuditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const victim = ordered[2]!
      // What an operator covering their tracks would actually do.
      await db.adminAuditLog.delete({ where: { id: victim.id } })

      const res = await agent.get(`${BASE}/audit/verify`)
      expect(res.body.ok).toBe(false)
      // The row *after* the deleted one no longer links to anything that
      // exists, which is exactly where the walk stops adding up.
      expect(res.body.brokenAt.index).toBe(2)
      expect(res.body.brokenAt.entryId).toBe(ordered[3]!.id)
      expect(res.body.brokenAt.reason).toBe('PREV_HASH_MISMATCH')
    })

    it('★ and an EDITED row is reported differently from a deleted one', async () => {
      const admin = await seedUser('ADMIN')
      const target = await seedUser('USER')
      const { agent } = await signIn(harness, admin)
      await agent.post(`${BASE}/users/${target.id}/disable`).send({ reason: 'the real reason' })

      const ordered = await db.adminAuditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const victim = ordered.at(-1)!
      await db.adminAuditLog.update({
        where: { id: victim.id },
        data: { reason: 'a more flattering reason' },
      })

      const res = await agent.get(`${BASE}/audit/verify`)
      expect(res.body.ok).toBe(false)
      // A row whose content changed still links correctly to its predecessor —
      // it is its *own* hash that no longer matches. Distinguishing the two
      // tells an investigator whether history was deleted or rewritten.
      expect(res.body.brokenAt.reason).toBe('HASH_MISMATCH')
      expect(res.body.brokenAt.entryId).toBe(victim.id)
    })

    it('a row can be verified by hand, without database access', async () => {
      const admin = await seedUser('ADMIN')
      const target = await seedUser('USER')
      const { agent } = await signIn(harness, admin)
      await agent.post(`${BASE}/users/${target.id}/disable`).send({ reason: 'by hand' })

      const listed = await agent.get(`${BASE}/audit?limit=1`)
      const row = listed.body.items[0]

      // The API hands out `prevHash` and `hash`, so anyone can recompute the
      // link from the payload alone — which is what makes the chain a public
      // check rather than a claim the server makes about itself.
      const recomputed = computeAuditHash(
        toChainInput({
          ...row,
          createdAt: new Date(row.createdAt),
        }),
        row.prevHash,
      )
      expect(recomputed).toBe(row.hash)
    })

    it('verify is ADMIN-only while the rest of the reads are SUPPORT', async () => {
      const support = await seedUser('SUPPORT')
      const { agent } = await signIn(harness, support)

      expect((await agent.get(`${BASE}/audit`)).status).toBe(200)
      expect((await agent.get(`${BASE}/audit/verify`)).status).toBe(403)
    })
  })

  describe('the read endpoints', () => {
    it('GET /users searches by email, id and display name', async () => {
      const admin = await seedUser('ADMIN')
      const target = await seedUser('USER')
      const { agent } = await signIn(harness, admin)

      const byEmail = await agent.get(`${BASE}/users?q=${encodeURIComponent(target.email)}`)
      expect(byEmail.status).toBe(200)
      expect(byEmail.body.items.map((u: { id: string }) => u.id)).toContain(target.id)

      const byId = await agent.get(`${BASE}/users?q=${target.id}`)
      expect(byId.body.items).toHaveLength(1)

      const byStatus = await agent.get(`${BASE}/users?status=BANNED`)
      expect(byStatus.body.items).toHaveLength(0)
    })

    it('★ never returns a password hash', async () => {
      const admin = await seedUser('ADMIN')
      const target = await seedUser('USER')
      const { agent } = await signIn(harness, admin)

      const list = await agent.get(`${BASE}/users?limit=100`)
      const detail = await agent.get(`${BASE}/users/${target.id}`)

      expect(JSON.stringify(list.body)).not.toContain('passwordHash')
      expect(JSON.stringify(list.body)).not.toContain('argon2')
      expect(JSON.stringify(detail.body)).not.toContain('passwordHash')
      expect(JSON.stringify(detail.body)).not.toContain('argon2')
    })

    it('GET /users/:id carries the cached wallet balances', async () => {
      const admin = await seedUser('ADMIN')
      const target = await seedUser('USER')
      await db.wallet.create({ data: { userId: target.id, assetCode: 'COIN', balance: 120 } })
      const { agent } = await signIn(harness, admin)

      const res = await agent.get(`${BASE}/users/${target.id}`)
      expect(res.status).toBe(200)
      expect(res.body.wallets).toEqual([{ assetCode: 'COIN', balance: 120, status: 'VESTED' }])
    })

    it('GET /users/:id is 404 for an unknown id', async () => {
      const admin = await seedUser('ADMIN')
      const { agent } = await signIn(harness, admin)
      expect((await agent.get(`${BASE}/users/no-such-user`)).status).toBe(404)
    })

    it('★ every manifest route is 401 with no session at all', async () => {
      for (const spec of ADMIN_ROUTES) {
        const res = await request(harness.app)[spec.method](
          fullPath(spec).replace(':id', 'anything'),
        ).send({ reason: 'probe' })

        expect(res.status, `${spec.method} ${spec.path}`).toBe(401)
      }
    })
  })
})
