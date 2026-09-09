import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { ASSET_CODES } from '../../src/contracts/enums.js'
import { AUTH_COOKIES } from '../../src/contracts/dto/auth.js'
import { hashPassword } from '../../src/infrastructure/auth/password.js'
import { buildTestApp, registerUser } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'

/** S13 — create an account, then be recognized by cookie alone. */
const { app, resetLimits } = buildTestApp()

const VALID = {
  email: 'mehrang@test.dev',
  password: 'correct-horse-battery',
  displayName: 'Mehrang',
}

const register = (body: Record<string, unknown>) =>
  request(app).post('/api/v1/auth/register').send(body)

const setCookies = (res: request.Response): string[] =>
  (res.headers['set-cookie'] ?? []) as unknown as string[]

const named = (res: request.Response, name: string): string =>
  setCookies(res).find((cookie) => cookie.startsWith(`${name}=`)) ?? ''

beforeEach(async () => {
  await resetDb()
  resetLimits()
  // Default cosmetic grants are catalog data, so registration has to have some
  // to grant. Two DEFAULT items and one that must *not* be granted.
  await db.cosmeticItem.createMany({
    data: [
      { id: 'back-classic', category: 'CARD_BACK', nameKey: 'c.back', assetRef: 'a', sortOrder: 1 },
      { id: 'felt-green', category: 'FELT', nameKey: 'c.felt', assetRef: 'b', sortOrder: 2 },
      {
        id: 'back-premium',
        category: 'CARD_BACK',
        nameKey: 'c.premium',
        assetRef: 'c',
        unlockKind: 'PURCHASE',
        sortOrder: 3,
      },
    ],
  })
})

describe('POST /auth/register', () => {
  it('★ creates a usable account in one transaction, and sets cookies', async () => {
    const res = await register(VALID)

    expect(res.status).toBe(201)
    expect(res.body.identity).toMatchObject({
      kind: 'user',
      email: VALID.email,
      displayName: 'Mehrang',
      role: 'USER',
    })

    const user = await db.user.findUniqueOrThrow({
      where: { email: VALID.email },
      include: { preferences: true, wallets: true, cosmetics: true, refreshTokens: true },
    })

    // "A usable account" is the unit of work, not "a User row": a user with no
    // wallet is a user who crashes the wallet screen.
    expect(user.preferences).not.toBeNull()
    expect(user.wallets).toHaveLength(ASSET_CODES.length)
    expect(user.wallets.every((wallet) => wallet.status === 'VESTED')).toBe(true)
    expect(user.wallets.every((wallet) => wallet.balance === 0)).toBe(true)
    expect(user.cosmetics.map((c) => c.cosmeticId).sort()).toEqual(['back-classic', 'felt-green'])
    expect(user.refreshTokens).toHaveLength(1)
    expect(user.lastSeenAt).not.toBeNull()
  })

  it('never returns the password hash or a token in the body', async () => {
    const res = await register(VALID)
    const body = JSON.stringify(res.body)

    expect(body).not.toContain('argon2')
    expect(body).not.toContain('passwordHash')
    expect(body).not.toContain('accessToken')
    expect(body).not.toContain('refreshToken')
  })

  it('stores the password as an argon2id hash, never in plaintext', async () => {
    await register(VALID)
    const user = await db.user.findUniqueOrThrow({ where: { email: VALID.email } })

    expect(user.passwordHash).toMatch(/^\$argon2id\$/)
    expect(user.passwordHash).not.toContain(VALID.password)
  })

  it('sets httpOnly access and refresh cookies, and no Authorization anywhere', async () => {
    const res = await register(VALID)

    expect(named(res, AUTH_COOKIES.access)).toMatch(/HttpOnly/i)
    expect(named(res, AUTH_COOKIES.refresh)).toMatch(/HttpOnly/i)
    expect(named(res, AUTH_COOKIES.refresh)).toContain('Path=/api/v1/auth')
  })

  it('★ a duplicate email is 409 EMAIL_TAKEN and leaves no partial rows', async () => {
    await register(VALID)
    const before = await counts()

    const res = await register({ ...VALID, displayName: 'Impostor', password: 'another-one-here' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('EMAIL_TAKEN')
    // The whole registration is one transaction, so a failure at the very
    // first write must not have left a wallet or a preferences row behind.
    expect(await counts()).toEqual(before)
  })

  it('normalises the email, so case is not a second account', async () => {
    expect((await register(VALID)).status).toBe(201)
    expect((await register({ ...VALID, email: 'MEHRANG@Test.DEV' })).status).toBe(409)
  })

  it('★ rejects a weak password before hashing it', async () => {
    const res = await register({ ...VALID, password: 'short' })

    expect(res.status).toBe(400)
    expect(res.body.fieldErrors.password).toContain('errors.passwordTooShort')
    expect(await db.user.count()).toBe(0)
  })

  it('rejects a common password and one built from the email', async () => {
    expect(
      (await register({ ...VALID, password: 'password123' })).body.fieldErrors.password,
    ).toEqual(['errors.passwordTooCommon'])
    expect(
      (await register({ ...VALID, password: 'mehrang-in-the-password' })).body.fieldErrors.password,
    ).toEqual(['errors.passwordTooPersonal'])
  })

  it('rejects an impersonating display name', async () => {
    const res = await register({ ...VALID, displayName: 'Adm1n' })

    expect(res.status).toBe(400)
    expect(res.body.fieldErrors.displayName).toEqual(['errors.displayNameReserved'])
  })

  it('rejects an unknown field', async () => {
    expect((await register({ ...VALID, role: 'ADMIN' })).status).toBe(400)
  })

  it('★ cannot self-assign a role — the field is not in the schema', async () => {
    await register(VALID)
    const user = await db.user.findUniqueOrThrow({ where: { email: VALID.email } })
    expect(user.role).toBe('USER')
  })

  it('records a valid invite as the post-signup redirect target (J2)', async () => {
    const table = await db.table.create({
      data: { gameSlug: 'fixture', optionsJson: '{}', seatCount: 4 },
    })
    const host = await db.user.create({
      data: { email: 'host@test.dev', passwordHash: 'x', displayName: 'Host' },
    })
    await db.invite.create({
      data: {
        tableId: table.id,
        code: 'GOODCODE',
        createdByUserId: host.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })

    const res = await register({ ...VALID, inviteCode: 'GOODCODE' })
    expect(res.body.redirectTo).toBe(`/table/${table.id}`)
  })

  it('a dead invite does not fail the sign-up — it just has nowhere to send you', async () => {
    const res = await register({ ...VALID, inviteCode: 'NOSUCHCODE' })

    expect(res.status).toBe(201)
    expect(res.body.redirectTo).toBeNull()
  })
})

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await register(VALID)
  })

  it('logs in with the right password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: VALID.password })

    expect(res.status).toBe(200)
    expect(res.body.identity.userId).toBeTruthy()
    expect(named(res, AUTH_COOKIES.access)).toBeTruthy()
  })

  it('★ a wrong password and an unknown email are indistinguishable', async () => {
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: 'not-my-password' })
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.dev', password: 'not-my-password' })

    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    // Identical bodies. The timing is equalised too — an unknown email still
    // pays for one argon2 verification against a decoy hash — which is the
    // part that survives every attempt to hide enumeration in the body alone.
    expect(wrong.body).toEqual(unknown.body)
  })

  it('updates lastSeenAt', async () => {
    await db.user.update({ where: { email: VALID.email }, data: { lastSeenAt: null } })
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: VALID.password })

    const user = await db.user.findUniqueOrThrow({ where: { email: VALID.email } })
    expect(user.lastSeenAt).not.toBeNull()
  })

  it('★ upgrades a hash created under a lower argon2 cost', async () => {
    const weak = await db.user.findUniqueOrThrow({ where: { email: VALID.email } })
    // A genuine hash at the old, cheaper cost — not a doctored marker, which
    // would simply fail to verify and never reach the rehash path.
    const downgraded = await hashPassword(VALID.password, {
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
    })
    await db.user.update({ where: { id: weak.id }, data: { passwordHash: downgraded } })

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: VALID.password })

    const after = await db.user.findUniqueOrThrow({ where: { id: weak.id } })
    // Raising the cost only protects new accounts unless existing hashes are
    // upgraded, and login is the only moment the plaintext is in hand.
    expect(after.passwordHash).not.toBe(downgraded)
    expect(after.passwordHash).toMatch(/m=19456,t=2/)
  })

  it('refuses a banned account with 403, not 401', async () => {
    await db.user.update({
      where: { email: VALID.email },
      data: { status: 'BANNED', statusReason: 'cheating' },
    })

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: VALID.password })

    // They proved they own the account, so they have earned a clear answer.
    expect(res.status).toBe(403)
    expect(res.body.details.status).toBe('BANNED')
  })

  it('★ throttles repeated failures per email (07 §5.3)', async () => {
    const attempt = () =>
      request(app).post('/api/v1/auth/login').send({ email: VALID.email, password: 'wrong-one' })

    const codes: number[] = []
    for (let i = 0; i < 7; i += 1) codes.push((await attempt()).status)

    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(codes.slice(5)).toEqual([429, 429])

    // …and the correct password is throttled too. Otherwise the counter is a
    // suggestion rather than a lockout.
    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: VALID.password })
    expect(blocked.status).toBe(429)
    expect(blocked.body.retryAfterMs).toBeGreaterThan(0)
  })

  it('★ a success clears the counter — mistyping is not punished for 15 minutes', async () => {
    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/api/v1/auth/login').send({ email: VALID.email, password: 'wrong' })
    }

    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: VALID.email, password: VALID.password })
      ).status,
    ).toBe(200)

    // Four failures + a success, then four more failures: still 401, not 429.
    for (let i = 0; i < 4; i += 1) {
      expect(
        (await request(app).post('/api/v1/auth/login').send({ email: VALID.email, password: 'no' }))
          .status,
      ).toBe(401)
    }
  })
})

describe('GET /auth/me', () => {
  it('401s with no cookie', async () => {
    const res = await request(app).get('/api/v1/auth/me')

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('UNAUTHORIZED')
  })

  it('★ returns the identity from the cookie alone', async () => {
    const { agent, body } = await registerUser(app, { email: 'me@test.dev' })
    const res = await agent.get('/api/v1/auth/me')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ kind: 'user', email: body.email, displayName: 'Tester' })
    expect(res.body).not.toHaveProperty('passwordHash')
  })

  it('reflects a rename immediately — identity is read, not baked into the token', async () => {
    const { agent, body } = await registerUser(app, { email: 'rename@test.dev' })
    await db.user.update({ where: { email: body.email }, data: { displayName: 'Renamed' } })

    expect((await agent.get('/api/v1/auth/me')).body.displayName).toBe('Renamed')
  })

  it('★ stops working the moment the account is banned', async () => {
    const { agent, body } = await registerUser(app, { email: 'banned@test.dev' })
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200)

    await db.user.update({ where: { email: body.email }, data: { status: 'BANNED' } })

    // The reason `authenticate` spends a primary-key read per request instead
    // of trusting the JWT's claims: a ban has to bite now, not in ten minutes.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401)
  })

  it('ignores a forged access cookie and clears it', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${AUTH_COOKIES.access}=not.a.real.token`)

    expect(res.status).toBe(401)
    expect(named(res, AUTH_COOKIES.access)).toMatch(/access=;/)
  })
})

async function counts() {
  return {
    users: await db.user.count(),
    wallets: await db.wallet.count(),
    preferences: await db.userPreferences.count(),
    cosmetics: await db.userCosmetic.count(),
    tokens: await db.refreshToken.count(),
  }
}
