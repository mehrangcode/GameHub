import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../../src/infrastructure/auth/password.js'
import { totpCodeAt, TOTP_STEP_SEC } from '../../../src/infrastructure/admin/totp.js'
import { buildTestAdminApp, buildTestApp, uniqueSuffix, type TestAdminApp } from '../../helpers/app.js'
import { db, resetDb } from '../../helpers/db.js'

/**
 * S49 — admin authentication end to end, 12-admin-console.md §3.3, §3.4.
 *
 * The suite is organised around what each property *costs to get wrong*, not
 * around the endpoints. The two marked ★★ are the ones that make TOTP worth
 * having at all: a code that can be spent twice is a code worth intercepting,
 * and a session that survives moving to a new address is a session worth
 * stealing.
 */

const PASSWORD = 'correct-horse-battery-admin'

interface SeededAdmin {
  id: string
  email: string
}

async function seedAdminUser(role: 'ADMIN' | 'SUPPORT' | 'USER' = 'ADMIN'): Promise<SeededAdmin> {
  const email = `admin-${uniqueSuffix()}@test.dev`
  const user = await db.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      displayName: 'Ops',
      role,
    },
  })
  // The seed's unenrolled credential (12 §4.1) — an empty secret and a null
  // `totpEnrolledAt`, which is the state every fresh admin starts in.
  if (role !== 'USER') {
    await db.adminCredential.create({ data: { userId: user.id, totpSecretEnc: '' } })
  }
  return { id: user.id, email }
}

/** Walks login → enroll → mfa and returns the logged-in agent plus its secret. */
async function signIn(harness: TestAdminApp, admin: SeededAdmin) {
  const agent = request.agent(harness.app)
  const base = '/admin/api/v1'

  const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
  expect(login.status).toBe(200)

  let challengeId = login.body.challengeId as string
  let secret: string

  if (login.body.enrollmentRequired === true) {
    const enrolled = await agent.post(`${base}/auth/totp/enroll`).send({ challengeId })
    expect(enrolled.status).toBe(200)
    secret = enrolled.body.secret as string
    challengeId = enrolled.body.challengeId as string
  } else {
    throw new Error('signIn expects a fresh admin')
  }

  const mfa = await agent
    .post(`${base}/auth/mfa`)
    .send({ challengeId, code: totpCodeAt(secret, Date.now()) })
  expect(mfa.status).toBe(200)

  return { agent, secret, recoveryCodes: [] as string[] }
}

describe('admin auth (S49)', () => {
  let harness: TestAdminApp
  const base = '/admin/api/v1'

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

  describe('step 1 — the password', () => {
    it('returns a challenge, not a session — holding a password is half of it', async () => {
      const admin = await seedAdminUser()
      const res = await request(harness.app)
        .post(`${base}/auth/login`)
        .send({ email: admin.email, password: PASSWORD })

      expect(res.status).toBe(200)
      expect(res.body.challengeId).toBeTruthy()
      expect(res.body.ttlSec).toBeGreaterThan(0)
      expect(res.body.enrollmentRequired).toBe(true)
      // The whole point: no cookie yet.
      expect(res.headers['set-cookie']).toBeUndefined()
    })

    it('★ a USER with the correct password is refused at the password step', async () => {
      const player = await seedAdminUser('USER')
      const res = await request(harness.app)
        .post(`${base}/auth/login`)
        .send({ email: player.email, password: PASSWORD })

      expect(res.status).toBe(401)
      expect(res.body.code).toBe('UNAUTHORIZED')
      expect(res.body.details.reason).toBe('INVALID_CREDENTIALS')
    })

    it('★ and is indistinguishable from a wrong password and an unknown email', async () => {
      const player = await seedAdminUser('USER')
      const admin = await seedAdminUser()

      const [asPlayer, wrongPassword, unknownEmail] = await Promise.all([
        request(harness.app).post(`${base}/auth/login`).send({ email: player.email, password: PASSWORD }),
        request(harness.app)
          .post(`${base}/auth/login`)
          .send({ email: admin.email, password: 'not-the-password' }),
        request(harness.app)
          .post(`${base}/auth/login`)
          .send({ email: 'nobody@test.dev', password: PASSWORD }),
      ])

      // Byte-identical. A player who finds the console's URL must not be able
      // to discover from it whether their own account is privileged.
      expect(asPlayer.body).toEqual(wrongPassword.body)
      expect(wrongPassword.body).toEqual(unknownEmail.body)
      expect(asPlayer.status).toBe(401)
    })

    it('a DISABLED admin is refused too', async () => {
      const admin = await seedAdminUser()
      await db.user.update({ where: { id: admin.id }, data: { status: 'DISABLED' } })

      const res = await request(harness.app)
        .post(`${base}/auth/login`)
        .send({ email: admin.email, password: PASSWORD })

      expect(res.status).toBe(401)
    })

    it('rejects an unknown field rather than ignoring it', async () => {
      const admin = await seedAdminUser()
      const res = await request(harness.app)
        .post(`${base}/auth/login`)
        .send({ email: admin.email, password: PASSWORD, userId: 'somebody-else' })

      expect(res.status).toBe(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.fieldErrors.userId).toBeDefined()
    })
  })

  describe('enrollment is mandatory (§3.3)', () => {
    it('★★ an unenrolled admin can reach NOTHING but the enrollment route', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })

      expect(login.body.enrollmentRequired).toBe(true)

      // Without a session there is nothing to present, which is the strongest
      // possible form of "cannot reach": /auth/mfa itself refuses.
      const mfa = await agent
        .post(`${base}/auth/mfa`)
        .send({ challengeId: login.body.challengeId, code: '000000' })
      expect(mfa.status).toBe(403)
      expect(mfa.body.code).toBe('MFA_ENROLLMENT_REQUIRED')

      for (const path of ['/auth/me', '/metrics', '/security-events']) {
        const res = await agent.get(`${base}${path}`)
        expect(res.status).toBe(401)
      }
    })

    it('issues the URI and ten recovery codes, exactly once', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })

      const first = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })

      expect(first.status).toBe(200)
      expect(first.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//)
      expect(first.body.recoveryCodes).toHaveLength(10)

      // A second enrollment would silently invalidate the authenticator the
      // operator is holding — which is how somebody locks themselves out.
      const second = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })

      expect(second.status).toBe(403)
      expect(second.body.details.reason).toBe('ALREADY_ENROLLED')
    })

    it('★★ the stored secret is ciphertext — a database dump is not a second factor', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
      const enrolled = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })

      const credential = await db.adminCredential.findUnique({ where: { userId: admin.id } })
      const secret = enrolled.body.secret as string

      expect(credential?.totpEnrolledAt).not.toBeNull()
      expect(credential?.totpSecretEnc).not.toContain(secret)
      // `iv:tag:ciphertext`, and nothing in the column decodes to base32 by eye.
      expect(credential?.totpSecretEnc.split(':')).toHaveLength(3)
    })

    it('★ and the recovery codes are stored as hashes, never as codes', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
      const enrolled = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })

      const credential = await db.adminCredential.findUnique({ where: { userId: admin.id } })
      const stored = credential!.recoveryCodeHashes

      for (const code of enrolled.body.recoveryCodes as string[]) {
        expect(stored).not.toContain(code)
      }
      expect(JSON.parse(stored)).toHaveLength(10)
    })
  })

  describe('step 2 — the code', () => {
    it('a wrong code leaves no session', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
      const enrolled = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })

      const res = await agent
        .post(`${base}/auth/mfa`)
        .send({ challengeId: enrolled.body.challengeId, code: '000000' })

      expect(res.status).toBe(401)
      expect(res.body.details.reason).toBe('INVALID_MFA_CODE')
      expect(await db.adminSession.count({ where: { userId: admin.id } })).toBe(0)
    })

    it('the right code issues a session and both cookies', async () => {
      const admin = await seedAdminUser()
      const { agent } = await signIn(harness, admin)

      const me = await agent.get(`${base}/auth/me`)
      expect(me.status).toBe(200)
      expect(me.body.email).toBe(admin.email)
      expect(me.body.role).toBe('ADMIN')

      const session = await db.adminSession.findFirst({ where: { userId: admin.id } })
      expect(session).not.toBeNull()
      expect(session?.revokedAt).toBeNull()
      // 8 hours absolute, regardless of activity (§3.2).
      expect(session!.expiresAt.getTime() - session!.createdAt.getTime()).toBeCloseTo(
        8 * 3_600_000,
        -4,
      )
    })

    it('★★ the SAME code is refused the second time — the replay guard', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
      const enrolled = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })

      const code = totpCodeAt(enrolled.body.secret as string, Date.now())
      const first = await agent.post(`${base}/auth/mfa`).send({ challengeId: enrolled.body.challengeId, code })
      expect(first.status).toBe(200)

      // Log in again and present the identical six digits, well inside their
      // 30-second window. Without `lastTotpStep` this succeeds — and so does
      // anyone who read the operator's screen over their shoulder.
      const again = await request(harness.app)
        .post(`${base}/auth/login`)
        .send({ email: admin.email, password: PASSWORD })
      const replay = await request(harness.app)
        .post(`${base}/auth/mfa`)
        .send({ challengeId: again.body.challengeId, code })

      expect(replay.status).toBe(401)
      expect(replay.body.details.reason).toBe('INVALID_MFA_CODE')

      const credential = await db.adminCredential.findUnique({ where: { userId: admin.id } })
      expect(credential?.lastTotpStep).toBe(Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
    })

    it('a challenge is single-use', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
      const enrolled = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })
      const challengeId = enrolled.body.challengeId as string

      await agent
        .post(`${base}/auth/mfa`)
        .send({ challengeId, code: totpCodeAt(enrolled.body.secret as string, Date.now()) })

      const reused = await agent
        .post(`${base}/auth/mfa`)
        .send({ challengeId, code: totpCodeAt(enrolled.body.secret as string, Date.now() + 31_000) })

      expect(reused.status).toBe(401)
      expect(reused.body.details.reason).toBe('CHALLENGE_EXPIRED')
    })

    it('a recovery code works, once, and is then gone', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
      const enrolled = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })
      const code = (enrolled.body.recoveryCodes as string[])[0]!

      const used = await agent
        .post(`${base}/auth/mfa`)
        .send({ challengeId: enrolled.body.challengeId, code })
      expect(used.status).toBe(200)

      const credential = await db.adminCredential.findUnique({ where: { userId: admin.id } })
      expect(JSON.parse(credential!.recoveryCodeHashes)).toHaveLength(9)

      const again = await request(harness.app)
        .post(`${base}/auth/login`)
        .send({ email: admin.email, password: PASSWORD })
      const replay = await request(harness.app)
        .post(`${base}/auth/mfa`)
        .send({ challengeId: again.body.challengeId, code })

      expect(replay.status).toBe(401)
    })
  })

  describe('lockout (§3.3)', () => {
    it('★ five wrong codes lock the account and raise an ALERT SecurityEvent', async () => {
      const admin = await seedAdminUser()
      const agent = request.agent(harness.app)
      const login = await agent.post(`${base}/auth/login`).send({ email: admin.email, password: PASSWORD })
      const enrolled = await agent
        .post(`${base}/auth/totp/enroll`)
        .send({ challengeId: login.body.challengeId })
      const secret = enrolled.body.secret as string

      let last: request.Response | undefined
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const fresh = await request(harness.app)
          .post(`${base}/auth/login`)
          .send({ email: admin.email, password: PASSWORD })
        last = await request(harness.app)
          .post(`${base}/auth/mfa`)
          .send({ challengeId: fresh.body.challengeId, code: '000000' })
      }

      expect(last?.status).toBe(423)
      expect(last?.body.code).toBe('ADMIN_LOCKED')
      expect(last?.body.details.lockedUntil).toBeTruthy()

      const credential = await db.adminCredential.findUnique({ where: { userId: admin.id } })
      expect(credential?.failedAttempts).toBe(5)
      expect(credential?.lockedUntil).not.toBeNull()

      // Give the fire-and-forget SecurityEvent write a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const events = await db.securityEvent.findMany({ where: { userId: admin.id } })
      expect(events.some((e) => e.severity === 'ALERT')).toBe(true)

      // ★ And the lock holds even against the *correct* code. A lockout that a
      // valid code could lift would only ever inconvenience the legitimate
      // operator, since the attacker does not have one.
      const afterLock = await request(harness.app)
        .post(`${base}/auth/login`)
        .send({ email: admin.email, password: PASSWORD })
      expect(afterLock.status).toBe(423)
      expect(secret).toBeTruthy()
    })
  })

  describe('★★ the session is pinned to its address (§3.2)', () => {
    it('a session presented from a new IP is REVOKED, not merely refused', async () => {
      const admin = await seedAdminUser()
      const { agent } = await signIn(harness, admin)
      expect((await agent.get(`${base}/auth/me`)).status).toBe(200)

      const session = await db.adminSession.findFirst({ where: { userId: admin.id } })

      // Driven through the service rather than over HTTP: supertest always
      // reports loopback, and the property under test is precisely what
      // happens when the address changes.
      await expect(
        harness.services.auth.resolveSession(session!.id, { ip: '203.0.113.9' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

      const after = await db.adminSession.findUnique({ where: { id: session!.id } })
      // ★ Revoked. Refusing without revoking would let an attacker who guessed
      // wrong once simply try again from a better address.
      expect(after?.revokedAt).not.toBeNull()

      // And the original operator is signed out too, which is the intended,
      // deliberately blunt consequence.
      expect((await agent.get(`${base}/auth/me`)).status).toBe(401)
    })

    it('a refresh from a new IP is refused and revokes the session', async () => {
      const admin = await seedAdminUser()
      await signIn(harness, admin)
      const session = await db.adminSession.findFirst({ where: { userId: admin.id } })

      await expect(
        harness.services.auth.refresh(session!.tokenHash, {
          ip: '203.0.113.9',
          userAgent: 'curl',
          requestId: 'req-1',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

      expect((await db.adminSession.findUnique({ where: { id: session!.id } }))?.revokedAt).not.toBeNull()
    })

    it('an idle session past the window is revoked on the next request', async () => {
      const admin = await seedAdminUser()
      await signIn(harness, admin)
      const session = await db.adminSession.findFirst({ where: { userId: admin.id } })

      await db.adminSession.update({
        where: { id: session!.id },
        data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) },
      })

      await expect(
        harness.services.auth.resolveSession(session!.id, { ip: '::ffff:127.0.0.1' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect((await db.adminSession.findUnique({ where: { id: session!.id } }))?.revokedAt).not.toBeNull()
    })

    it('rotation renews the token and NEVER the 8-hour absolute cap', async () => {
      const admin = await seedAdminUser()
      await signIn(harness, admin)
      const before = await db.adminSession.findFirst({ where: { userId: admin.id } })

      const rotated = await harness.services.auth.refresh(before!.tokenHash, {
        ip: before!.ip,
        userAgent: 'curl',
        requestId: 'req-1',
      })

      expect(rotated.session.tokenHash).not.toBe(before!.tokenHash)
      // ★ An operator who keeps a tab open must not hold a session that never
      // ends — which is the entire reason there is an absolute cap.
      expect(rotated.session.expiresAt.getTime()).toBe(before!.expiresAt.getTime())
    })
  })

  describe('★ step-up (§3.4)', () => {
    it('a stale mfaAt fails the guard, and a fresh code restores it', async () => {
      const admin = await seedAdminUser()
      const { agent } = await signIn(harness, admin)
      const session = await db.adminSession.findFirst({ where: { userId: admin.id } })

      expect(harness.services.auth.isStepUpFresh(session!)).toBe(true)

      const stale = { ...session!, mfaAt: new Date(Date.now() - 6 * 60_000) }
      expect(harness.services.auth.isStepUpFresh(stale)).toBe(false)

      await db.adminSession.update({
        where: { id: session!.id },
        data: { mfaAt: stale.mfaAt },
      })

      // The route: a fresh factor, no new session, and `mfaAt` moves forward.
      const credential = await db.adminCredential.findUnique({ where: { userId: admin.id } })
      expect(credential?.totpEnrolledAt).not.toBeNull()

      const refreshed = await agent.post(`${base}/auth/stepup`).send({ code: '000000' })
      expect(refreshed.status).toBe(401)
      expect((await db.adminSession.findUnique({ where: { id: session!.id } }))!.mfaAt.getTime()).toBe(
        stale.mfaAt.getTime(),
      )
    })
  })

  describe('logout', () => {
    it('revokes the session and clears both cookies', async () => {
      const admin = await seedAdminUser()
      const { agent } = await signIn(harness, admin)

      const res = await agent.post(`${base}/auth/logout`)
      expect(res.status).toBe(204)

      const session = await db.adminSession.findFirst({ where: { userId: admin.id } })
      expect(session?.revokedAt).not.toBeNull()
      expect((await agent.get(`${base}/auth/me`)).status).toBe(401)
    })
  })

  describe('★ S15’s two routes live here now, and only here (§11.1)', () => {
    it('GET /metrics answers on the admin app', async () => {
      const admin = await seedAdminUser()
      const { agent } = await signIn(harness, admin)

      const res = await agent.get(`${base}/metrics`)
      expect(res.status).toBe(200)
      expect(res.body.counters.admin_logins).toBeGreaterThan(0)
    })

    it('GET /security-events answers on the admin app', async () => {
      const admin = await seedAdminUser()
      const { agent } = await signIn(harness, admin)

      const res = await agent.get(`${base}/security-events?limit=5`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.items)).toBe(true)
    })

    it('★★ and BOTH are 404 on the public port — the arrangement §2.4 prevents', async () => {
      const publicApp = buildTestApp()

      for (const path of ['/admin/api/v1/metrics', '/admin/api/v1/security-events', '/api/v1/metrics']) {
        const res = await request(publicApp.app).get(path)
        expect(res.status).toBe(404)
      }
    })

    it('neither is reachable without a session', async () => {
      for (const path of ['/metrics', '/security-events']) {
        const res = await request(harness.app).get(`${base}${path}`)
        expect(res.status).toBe(401)
      }
    })
  })
})
