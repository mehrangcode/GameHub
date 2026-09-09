import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { AUTH_COOKIES } from '../../src/contracts/dto/auth.js'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'

/**
 * S14 — a stolen refresh token gets **contained**, not honoured for 30 days
 * (03 §6.2).
 */
const { app, resetLimits } = buildTestApp()

const CREDS = { email: 'rotator@test.dev', password: 'correct-horse-battery' }

/** The `refresh=…` cookie header value from a response, ready to replay. */
function refreshCookie(res: request.Response): string {
  const headers = (res.headers['set-cookie'] ?? []) as unknown as string[]
  const cookie = headers.find((h) => h.startsWith(`${AUTH_COOKIES.refresh}=`)) ?? ''
  return cookie.split(';')[0] ?? ''
}

function accessCookie(res: request.Response): string {
  const headers = (res.headers['set-cookie'] ?? []) as unknown as string[]
  const cookie = headers.find((h) => h.startsWith(`${AUTH_COOKIES.access}=`)) ?? ''
  return cookie.split(';')[0] ?? ''
}

async function login() {
  return request(app)
    .post('/api/v1/auth/register')
    .send({ ...CREDS, displayName: 'Rotator' })
}

const rotate = (cookie: string) => request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)

beforeEach(async () => {
  await resetDb()
  resetLimits()
})

describe('POST /auth/refresh', () => {
  it('★ issues a new token in the same family and marks the old one replaced', async () => {
    const session = await login()
    const first = await db.refreshToken.findFirstOrThrow()

    const rotated = await rotate(refreshCookie(session))
    expect(rotated.status).toBe(200)

    const rows = await db.refreshToken.findMany({ orderBy: { issuedAt: 'asc' } })
    expect(rows).toHaveLength(2)

    const [older, newer] = rows as [(typeof rows)[number], (typeof rows)[number]]
    expect(older.id).toBe(first.id)
    expect(older.revokedAt).not.toBeNull()
    expect(older.replacedById).toBe(newer.id)
    // Same family: that is what makes one revocation kill the whole chain.
    expect(newer.familyId).toBe(older.familyId)
    expect(newer.revokedAt).toBeNull()
  })

  it('rotates both cookies, and the new pair works', async () => {
    const session = await login()
    const rotated = await rotate(refreshCookie(session))

    expect(refreshCookie(rotated)).not.toBe(refreshCookie(session))
    expect(accessCookie(rotated)).toBeTruthy()

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', accessCookie(rotated))
    expect(me.status).toBe(200)
    expect(me.body.email).toBe(CREDS.email)
  })

  it('★ replaying a revoked token kills the family, including the live token', async () => {
    const session = await login()
    const stolen = refreshCookie(session)

    const rotated = await rotate(stolen)
    const current = refreshCookie(rotated)
    expect((await rotate(current)).status).toBe(200) // the honest holder is fine

    // Now the thief presents the token they captured before rotation.
    const replay = await rotate(stolen)
    expect(replay.status).toBe(401)
    expect(replay.body.details.reason).toBe('TOKEN_REUSED')

    // …and the point of the session: the *currently valid* token dies too.
    // We cannot tell the thief from the victim, so both must log in again.
    const live = await db.refreshToken.findMany()
    expect(live.every((token) => token.revokedAt !== null)).toBe(true)
  })

  it('★ records the reuse as an ALERT SecurityEvent', async () => {
    const session = await login()
    const stolen = refreshCookie(session)
    await rotate(stolen)
    await rotate(stolen)

    const events = await db.securityEvent.findMany({ where: { kind: 'BAD_TOKEN' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.severity).toBe('ALERT')
    expect(events[0]?.detailsJson).toContain('REFRESH_TOKEN_REUSED')
    expect(events[0]?.userId).toBeTruthy()
  })

  it('counts the reuse in the metrics registry', async () => {
    const { app: counted, container, resetLimits: reset } = buildTestApp()
    reset()
    const session = await request(counted)
      .post('/api/v1/auth/register')
      .send({ email: 'counted@test.dev', password: CREDS.password, displayName: 'Counted' })

    const stolen = refreshCookie(session)
    await request(counted).post('/api/v1/auth/refresh').set('Cookie', stolen)
    await request(counted).post('/api/v1/auth/refresh').set('Cookie', stolen)

    expect(container.metrics.snapshot().counters.token_reuse_detected).toBe(1)
  })

  it('an unknown token is 401 and audited, with no family to kill', async () => {
    const res = await rotate(`${AUTH_COOKIES.refresh}=nobody-issued-this`)

    expect(res.status).toBe(401)
    expect(res.body.details.reason).toBe('UNKNOWN_TOKEN')
    const events = await db.securityEvent.findMany({ where: { kind: 'BAD_TOKEN' } })
    expect(events[0]?.detailsJson).toContain('UNKNOWN_REFRESH_TOKEN')
  })

  it('no cookie at all is 401, not a crash', async () => {
    const res = await request(app).post('/api/v1/auth/refresh')

    expect(res.status).toBe(401)
    expect(res.body.details.reason).toBe('NO_TOKEN')
  })

  it('★ an expired token is 401, never 500', async () => {
    const session = await login()
    await db.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })

    const res = await rotate(refreshCookie(session))
    expect(res.status).toBe(401)
    expect(res.body.details.reason).toBe('TOKEN_EXPIRED')
    // Expiry is ordinary, not suspicious — no audit row for it.
    expect(await db.securityEvent.count()).toBe(0)
  })

  it('refuses to refresh a banned account, and ends its family', async () => {
    const session = await login()
    await db.user.updateMany({ where: { email: CREDS.email }, data: { status: 'BANNED' } })

    const res = await rotate(refreshCookie(session))
    expect(res.status).toBe(401)
    expect(res.body.details.reason).toBe('ACCOUNT_INACTIVE')
    expect((await db.refreshToken.findFirstOrThrow()).revokedAt).not.toBeNull()
  })

  it('★ two parallel refreshes leave exactly one live token in the family', async () => {
    const session = await login()
    const cookie = refreshCookie(session)

    // The race S39's single-flight interceptor exists to avoid — which the
    // server must survive regardless of what the client does.
    const [a, b] = await Promise.all([rotate(cookie), rotate(cookie)])

    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 401])

    const rows = await db.refreshToken.findMany()
    // One winner wrote a replacement; the loser wrote nothing at all, so the
    // chain is still a chain rather than a fork.
    expect(rows.filter((token) => token.revokedAt === null)).toHaveLength(1)
    expect(rows).toHaveLength(2)
    // And the loser did not trip the reuse alarm: it presented a live token.
    expect(await db.securityEvent.count()).toBe(0)
  })
})

describe('POST /auth/logout', () => {
  it('revokes the family and clears the cookies', async () => {
    const session = await login()
    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', refreshCookie(session))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const cleared = (res.headers['set-cookie'] ?? []) as unknown as string[]
    for (const name of Object.values(AUTH_COOKIES)) {
      expect(
        cleared.some((c) => c.startsWith(`${name}=;`)),
        name,
      ).toBe(true)
    }
    expect((await db.refreshToken.findFirstOrThrow()).revokedAt).not.toBeNull()
  })

  it('★ refresh after logout is 401', async () => {
    const session = await login()
    const cookie = refreshCookie(session)
    await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)

    expect((await rotate(cookie)).status).toBe(401)
  })

  it('is idempotent — logging out twice, or with no session, still succeeds', async () => {
    const session = await login()
    const cookie = refreshCookie(session)

    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(200)
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(200)
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(200)
  })
})

describe('expired-token cleanup', () => {
  it('sweeps refresh tokens and guest sessions nobody can use again', async () => {
    const { container } = buildTestApp()
    await login()
    const live = await db.refreshToken.findFirstOrThrow()

    const user = await db.user.findFirstOrThrow()
    await db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: 'stale-hash',
        familyId: 'stale',
        expiresAt: new Date(Date.now() - 1000),
      },
    })

    const swept = await container.auth.purgeExpired()
    expect(swept.refreshTokens).toBe(1)
    expect(await db.refreshToken.findUnique({ where: { id: live.id } })).not.toBeNull()
  })
})
