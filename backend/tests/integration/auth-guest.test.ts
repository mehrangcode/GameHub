import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { AUTH_COOKIES } from '../../src/contracts/dto/auth.js'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'

/**
 * S16 — `POST /auth/guest` issues an identity that works on **exactly one
 * table and nowhere else** (persona P2 without the privilege-escalation hole).
 */
const { app, resetLimits } = buildTestApp()

let tableId: string
let otherTableId: string

const guestCookie = (res: request.Response): string => {
  const headers = (res.headers['set-cookie'] ?? []) as unknown as string[]
  return (headers.find((h) => h.startsWith(`${AUTH_COOKIES.guest}=`)) ?? '').split(';')[0] ?? ''
}

const joinAs = (displayName: string, inviteCode = 'GOODCODE') =>
  request(app).post('/api/v1/auth/guest').send({ inviteCode, displayName })

beforeEach(async () => {
  await resetDb()
  resetLimits()

  const host = await db.user.create({
    data: { email: 'host@test.dev', passwordHash: 'x', displayName: 'TheHost' },
  })
  const table = await db.table.create({
    data: { hostUserId: host.id, gameSlug: 'fixture', optionsJson: '{}', seatCount: 4 },
  })
  const other = await db.table.create({
    data: { hostUserId: host.id, gameSlug: 'fixture', optionsJson: '{}', seatCount: 4 },
  })
  tableId = table.id
  otherTableId = other.id

  await db.invite.create({
    data: {
      tableId: table.id,
      code: 'GOODCODE',
      createdByUserId: host.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
})

describe('POST /auth/guest', () => {
  it('★ seats a guest with no account created', async () => {
    const res = await joinAs('Sara')

    expect(res.status).toBe(201)
    expect(res.body.identity).toMatchObject({ kind: 'guest', displayName: 'Sara', tableId })
    expect(res.body.redirectTo).toBe(`/table/${tableId}`)

    // The feature the whole product hangs on: no `User` row was written.
    expect(await db.user.count()).toBe(1) // the host, and only the host
    expect(guestCookie(res)).toBeTruthy()
  })

  it('★ takes the table from the invite, never from the caller', async () => {
    const res = await joinAs('Sara')
    const session = await db.guestSession.findFirstOrThrow()

    expect(session.tableId).toBe(tableId)
    expect(res.body.identity.tableId).toBe(tableId)
  })

  it('★ stores only a hash of the token', async () => {
    const res = await joinAs('Sara')
    const raw = guestCookie(res).split('=')[1] ?? ''
    const session = await db.guestSession.findFirstOrThrow()

    expect(raw).toBeTruthy()
    expect(session.tokenHash).not.toBe(raw)
    expect(session.tokenHash).not.toContain(raw)
  })

  it('★ creates a PROVISIONAL wallet with a zero balance', async () => {
    await joinAs('Sara')
    const session = await db.guestSession.findFirstOrThrow()
    const wallets = await db.wallet.findMany({ where: { guestSessionId: session.id } })

    expect(wallets).toHaveLength(1)
    expect(wallets[0]).toMatchObject({ assetCode: 'COIN', status: 'PROVISIONAL', balance: 0 })
  })

  it('expires in 12 hours', async () => {
    await joinAs('Sara')
    const session = await db.guestSession.findFirstOrThrow()
    const hours = (session.expiresAt.getTime() - session.createdAt.getTime()) / 3_600_000

    expect(Math.round(hours)).toBe(12)
  })

  it('sets an httpOnly guest cookie', async () => {
    const res = await joinAs('Sara')
    const headers = (res.headers['set-cookie'] ?? []) as unknown as string[]
    const cookie = headers.find((h) => h.startsWith(`${AUTH_COOKIES.guest}=`)) ?? ''

    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
  })

  it('consumes one use of the invite', async () => {
    await joinAs('Sara')
    expect((await db.invite.findFirstOrThrow()).useCount).toBe(1)
  })

  it('★ unknown, expired and revoked codes are indistinguishable', async () => {
    await db.invite.create({
      data: {
        tableId,
        code: 'EXPIRED1',
        createdByUserId: (await db.user.findFirstOrThrow()).id,
        expiresAt: new Date(Date.now() - 1000),
      },
    })
    await db.invite.create({
      data: {
        tableId,
        code: 'REVOKED1',
        createdByUserId: (await db.user.findFirstOrThrow()).id,
        expiresAt: new Date(Date.now() + 3_600_000),
        revokedAt: new Date(),
      },
    })

    const responses = await Promise.all([
      joinAs('Sara', 'NOSUCHCD'),
      joinAs('Sara', 'EXPIRED1'),
      joinAs('Sara', 'REVOKED1'),
    ])

    // 07 §5.2: identical shape for all three, so probing yields no signal
    // about which codes exist.
    for (const res of responses) {
      expect(res.status).toBe(410)
      expect(res.body.code).toBe('INVITE_EXPIRED')
      expect(res.body).toEqual(responses[0]?.body)
    }
    expect(await db.guestSession.count()).toBe(0)
  })

  it('records a failed resolve as INVITE_ABUSE', async () => {
    await joinAs('Sara', 'NOSUCHCD')
    const events = await eventually(
      () => db.securityEvent.findMany({ where: { kind: 'INVITE_ABUSE' } }),
      (rows) => rows.length > 0,
    )

    expect(events).toHaveLength(1)
    // The code is recorded for the audit table, not echoed back to the caller.
    expect(events[0]?.detailsJson).toContain('INVITE_NOT_USABLE')
  })

  it('refuses an exhausted invite without creating a guest', async () => {
    await db.invite.updateMany({ where: { code: 'GOODCODE' }, data: { maxUses: 1, useCount: 1 } })

    expect((await joinAs('Sara')).status).toBe(410)
    expect(await db.guestSession.count()).toBe(0)
  })

  it('★ enforces the display-name rules', async () => {
    expect((await joinAs('H0st')).body.fieldErrors.displayName).toEqual([
      'errors.displayNameReserved',
    ])
    expect((await joinAs('Admin')).body.fieldErrors.displayName).toEqual([
      'errors.displayNameReserved',
    ])
    expect((await joinAs('a')).status).toBe(400)
    expect((await joinAs('x'.repeat(30))).status).toBe(400)
    expect(await db.guestSession.count()).toBe(0)
  })
})

describe('a guest identity on GET /auth/me', () => {
  it('★ reports kind: guest and its bound table', async () => {
    const created = await joinAs('Sara')
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', guestCookie(created))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ kind: 'guest', displayName: 'Sara', tableId })
  })

  it('★ an expired guest session is 401', async () => {
    const created = await joinAs('Sara')
    await db.guestSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })

    expect(
      (await request(app).get('/api/v1/auth/me').set('Cookie', guestCookie(created))).status,
    ).toBe(401)
  })

  it('★ a claimed guest token stops working immediately', async () => {
    const created = await joinAs('Sara')
    const host = await db.user.findFirstOrThrow()
    await db.guestSession.updateMany({
      data: { claimedAt: new Date(), claimedByUserId: host.id },
    })

    // A claimed token that still authenticated would be a second, weaker
    // credential for a real user's seat (07 §5.1). S22 relies on this.
    expect(
      (await request(app).get('/api/v1/auth/me').set('Cookie', guestCookie(created))).status,
    ).toBe(401)
  })

  it('a forged guest cookie is ignored and cleared', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${AUTH_COOKIES.guest}=g1.YWJj.nonce.forged`)

    expect(res.status).toBe(401)
  })
})

/**
 * S16's property, asserted on the **real** route from S18 onwards.
 *
 * These three cases used to run against a dev-only `/_probe/table/:tableId`,
 * which existed for exactly two sessions because S16 landed before there was
 * any table route to guard. `GET /tables/:id` now carries
 * `enforceGuestBinding` itself, so the cross-table 403 and its audit row are
 * observable on the endpoint a browser actually calls — which is the whole
 * reason the stand-in was marked for deletion here.
 */
describe('★ the guest binding, enforced on every request (07 §3)', () => {
  it('lets a guest reach its own table', async () => {
    const created = await joinAs('Sara')
    const res = await request(app)
      .get(`/api/v1/tables/${tableId}`)
      .set('Cookie', guestCookie(created))

    expect(res.status).toBe(200)
    expect(res.body.id).toBe(tableId)
  })

  it('★ refuses another table with 403 — and audits it', async () => {
    const created = await joinAs('Sara')
    const res = await request(app)
      .get(`/api/v1/tables/${otherTableId}`)
      .set('Cookie', guestCookie(created))

    // The core assertion of S16. A leaked guest token is worth exactly one
    // already-public table, not a wildcard identity.
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(res.body.details.reason).toBe('GUEST_TABLE_BINDING')

    const events = await eventually(
      () => db.securityEvent.findMany({ where: { kind: 'SEAT_IMPERSONATION' } }),
      (rows) => rows.length > 0,
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.severity).toBe('ALERT')
    expect(events[0]?.guestSessionId).toBeTruthy()
    expect(events[0]?.detailsJson).toContain(otherTableId)
  })

  it('leaves users and anonymous callers to the ownership rules instead', async () => {
    const user = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'real@test.dev', password: 'correct-horse-battery', displayName: 'Real' })
    const access =
      ((user.headers['set-cookie'] ?? []) as unknown as string[])
        .find((c) => c.startsWith(`${AUTH_COOKIES.access}=`))
        ?.split(';')[0] ?? ''

    // A real account is not table-bound: the table id is a cuid and therefore
    // the capability, exactly as the invite code is (S18). Whether they may
    // *act* at the table is host and membership logic, not this guard.
    expect(
      (await request(app).get(`/api/v1/tables/${otherTableId}`).set('Cookie', access)).status,
    ).toBe(200)

    // Anonymous is still 401 — the guard is about binding, not authentication.
    expect((await request(app).get(`/api/v1/tables/${otherTableId}`)).status).toBe(401)
  })
})

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest = await read()

  while (!done(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    latest = await read()
  }
  return latest
}
