import pino from 'pino'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  InviteResponseSchema,
  PublicInviteResponseSchema,
} from '../../src/contracts/dto/invites.js'
import { InviteService } from '../../src/application/services/InviteService.js'
import { INVITE_ALPHABET } from '../../src/infrastructure/invites/inviteCode.js'
import { buildTestApp, client, registerUser, type Client } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'

/**
 * S19 — the link you send a friend.
 *
 * ★ The two properties that make journey J1→J2 work at all:
 *
 *   1. `GET /invites/:code` resolves with **no cookie whatsoever**. Every test
 *      here that resolves uses a bare `request(app)` rather than an agent, so
 *      the day someone adds `requireIdentity()` to that route, this file fails.
 *   2. Revoked, expired, exhausted and never-existed produce a **byte-identical
 *      410**. Any difference makes the endpoint an oracle for enumerating live
 *      codes (07 §5.2).
 */
const { app, container, resetLimits } = buildTestApp()

let host: Client
let hostUserId: string
let tableId: string

const mint = (agent: Client, body?: Record<string, unknown>) => {
  const req = agent.post(`/api/v1/tables/${tableId}/invites`)
  return body === undefined ? req : req.send(body)
}

/** Always uncookied, on purpose. */
const resolve = (code: string) => request(app).get(`/api/v1/invites/${code}`)

beforeEach(async () => {
  await resetDb()
  resetLimits()

  const registered = await registerUser(app, { displayName: 'TheHost' })
  host = registered.agent
  hostUserId = registered.response.body.identity.userId

  const table = await host
    .post('/api/v1/tables')
    .send({ gameSlug: 'fixture', seatCount: 4, options: {} })
  tableId = table.body.id
})

describe('POST /tables/:id/invites', () => {
  it('mints a link with no body at all — "all defaults" is the common case', async () => {
    const res = await mint(host)

    expect(res.status).toBe(201)
    const parsed = InviteResponseSchema.safeParse(res.body)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)

    // The server owns the link shape, so changing it later is one edit rather
    // than a grep for string concatenation in the client.
    expect(res.body.joinPath).toBe(`/t/${res.body.code}`)
    expect(res.body.useCount).toBe(0)
    expect(res.body.maxUses).toBeNull()
    expect(res.body.revokedAt).toBeNull()
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  /**
   * Asserted on the **alphabet**, not on a sampled code.
   *
   * The sampled version of this test is worse than useless: `U` sat in the
   * alphabet for a whole session while a one-code check passed roughly four
   * runs in five, and it took a Postman run minting `WRQ6UUR6` to expose it.
   * A property that holds "usually" is not a property.
   */
  it('★ the alphabet contains nothing you can mistype off a phone screen', () => {
    // I/1, L/1, O/0 and U/V are the confusions that turn a working link into a
    // support conversation — `SEEDDEM0` versus `SEEDDEMO`.
    for (const char of 'ILOU01') {
      expect(INVITE_ALPHABET, `alphabet contains "${char}"`).not.toContain(char)
    }
    expect(INVITE_ALPHABET).toHaveLength(30)
    // Upper case only: a code is read aloud and typed back, and case is one
    // more thing to get wrong.
    expect(INVITE_ALPHABET).toBe(INVITE_ALPHABET.toUpperCase())
  })

  it('mints codes drawn only from that alphabet', async () => {
    const res = await mint(host)

    expect(res.body.code).toHaveLength(8)
    for (const char of res.body.code as string) {
      expect(INVITE_ALPHABET, `code contains "${char}"`).toContain(char)
    }
  })

  it('honours expiresInHours and maxUses', async () => {
    const res = await mint(host, { expiresInHours: 1, maxUses: 2 })

    expect(res.body.maxUses).toBe(2)
    const hours = (new Date(res.body.expiresAt).getTime() - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(0.9)
    expect(hours).toBeLessThan(1.1)
  })

  it('★ a non-host cannot mint a join capability', async () => {
    const stranger = (await registerUser(app, { displayName: 'Stranger' })).agent

    const res = await mint(stranger)

    expect(res.status).toBe(403)
    expect(res.body.details.reason).toBe('HOST_REQUIRED')
    expect(await db.invite.count()).toBe(0)
  })

  it('a guest cannot mint one either, even at its own table', async () => {
    const code = (await mint(host)).body.code
    const guest = await guestWith(code)

    expect((await mint(guest)).status).toBe(403)
  })

  it('refuses to mint for a closed table', async () => {
    await host.delete(`/api/v1/tables/${tableId}`)

    expect((await mint(host)).status).toBe(409)
  })

  it('the host can list their own links', async () => {
    await mint(host)
    await mint(host)

    const res = await host.get(`/api/v1/tables/${tableId}/invites`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
  })

  it('survives a code collision by retrying with a fresh code', async () => {
    // Real randomness cannot be made to collide on demand, which is exactly
    // why the generator is a port.
    let calls = 0
    const codes = ['COLLIDE1', 'COLLIDE1', 'SURVIVE2']
    const service = new InviteService({
      repos: container.repos,
      registry: container.registry,
      codes: { next: () => codes[calls++] ?? 'FALLBACK' },
      security: container.security,
      metrics: container.metrics,
      logger: pino({ level: 'silent' }),
      defaultTtlHours: 24,
    })

    const first = await service.mint(tableId, hostUserId)
    const second = await service.mint(tableId, hostUserId)

    expect(first.code).toBe('COLLIDE1')
    expect(second.code).toBe('SURVIVE2')
  })
})

describe('★ GET /invites/:code — public', () => {
  it('★ resolves with no cookie at all', async () => {
    const code = (await mint(host)).body.code

    const res = await resolve(code)

    expect(res.status).toBe(200)
    const parsed = PublicInviteResponseSchema.safeParse(res.body)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('tells a stranger what a pre-join screen needs, in i18n keys', async () => {
    const code = (await mint(host)).body.code

    const res = await resolve(code)

    expect(res.body).toEqual({
      gameSlug: 'fixture',
      gameNameKey: 'games.fixture.name',
      hostDisplayName: 'TheHost',
      seatCount: 4,
      seatsFree: 4,
      inProgress: false,
      allowSpectators: true,
      requireApproval: false,
    })
  })

  it('★ leaks no PII, no ids and no game state', async () => {
    const code = (await mint(host)).body.code

    const res = await resolve(code)
    const wire = JSON.stringify(res.body)

    // This payload goes to anyone holding the code, so a leaked link must not
    // also leak the table's identifier or the host's account.
    expect(wire).not.toContain(hostUserId)
    expect(wire).not.toContain(tableId)
    expect(wire).not.toContain('@')
    for (const forbidden of ['tableId', 'hostUserId', 'email', 'options', 'state', 'members']) {
      expect(res.body, `public payload carries "${forbidden}"`).not.toHaveProperty(forbidden)
    }
    expect(Object.keys(res.body).sort()).toEqual(
      Object.keys(PublicInviteResponseSchema.shape).sort(),
    )
  })

  it('counts the seats actually free', async () => {
    const code = (await mint(host)).body.code
    await host.post(`/api/v1/_probe/tables/${tableId}/seats`).send({ seat: 0 })

    expect((await resolve(code)).body.seatsFree).toBe(3)
  })

  it('reports a match already in progress, so the screen can offer spectating', async () => {
    const code = (await mint(host)).body.code
    await db.table.update({ where: { id: tableId }, data: { status: 'IN_PROGRESS' } })

    expect((await resolve(code)).body.inProgress).toBe(true)
  })
})

describe('★ every dead link answers identically (07 §5.2)', () => {
  /** All five causes, each producing the same body. */
  const causes: Array<[string, () => Promise<string>]> = [
    [
      'revoked',
      async () => {
        const code = (await mint(host)).body.code
        await host.delete(`/api/v1/tables/${tableId}/invites/${code}`)
        return code
      },
    ],
    [
      'expired',
      async () => {
        const code = (await mint(host)).body.code
        await db.invite.updateMany({
          where: { code },
          data: { expiresAt: new Date(Date.now() - 1000) },
        })
        return code
      },
    ],
    [
      'exhausted',
      async () => {
        const code = (await mint(host, { maxUses: 1 })).body.code
        await db.invite.updateMany({ where: { code }, data: { useCount: 1 } })
        return code
      },
    ],
    [
      'table closed',
      async () => {
        const code = (await mint(host)).body.code
        await host.delete(`/api/v1/tables/${tableId}`)
        return code
      },
    ],
    ['never existed', async () => 'TOTALFAKE'],
  ]

  it.each(causes)('%s → 410 INVITE_EXPIRED', async (_name, arrange) => {
    const res = await resolve(await arrange())

    expect(res.status).toBe(410)
    expect(res.body.code).toBe('INVITE_EXPIRED')
    expect(res.body.i18nKey).toBe('errors.inviteExpired')
  })

  it('★ the bodies are byte-identical, so codes cannot be enumerated', async () => {
    const bodies: string[] = []
    const statuses: number[] = []

    for (const [, arrange] of causes) {
      await resetDb()
      resetLimits()
      const registered = await registerUser(app, { displayName: 'TheHost' })
      host = registered.agent
      hostUserId = registered.response.body.identity.userId
      tableId = (
        await host.post('/api/v1/tables').send({ gameSlug: 'fixture', seatCount: 4, options: {} })
      ).body.id

      const res = await resolve(await arrange())
      statuses.push(res.status)
      bodies.push(JSON.stringify(res.body))
    }

    expect(new Set(statuses).size).toBe(1)
    expect(new Set(bodies).size, `distinct bodies: ${[...new Set(bodies)].join(' | ')}`).toBe(1)
  })

  it('a revoked link stays a row — revocation is a tombstone', async () => {
    const code = (await mint(host)).body.code

    const res = await host.delete(`/api/v1/tables/${tableId}/invites/${code}`)

    expect(res.status).toBe(200)
    expect(res.body.revokedAt).not.toBeNull()
    const row = await db.invite.findUniqueOrThrow({ where: { code } })
    expect(row.revokedAt).not.toBeNull()
  })

  it('revoking twice is idempotent', async () => {
    const code = (await mint(host)).body.code

    const first = await host.delete(`/api/v1/tables/${tableId}/invites/${code}`)
    const second = await host.delete(`/api/v1/tables/${tableId}/invites/${code}`)

    expect(second.status).toBe(200)
    expect(second.body.revokedAt).toBe(first.body.revokedAt)
  })

  it('a host cannot revoke someone else’s link, even holding the code', async () => {
    const code = (await mint(host)).body.code
    const other = (await registerUser(app, { displayName: 'Other' })).agent
    const theirTable = (
      await other.post('/api/v1/tables').send({ gameSlug: 'fixture', seatCount: 4, options: {} })
    ).body.id

    // Scoped to the table in the path: holding a valid code is not authority
    // over the table it belongs to.
    const res = await other.delete(`/api/v1/tables/${theirTable}/invites/${code}`)

    expect(res.status).toBe(404)
    expect((await db.invite.findUniqueOrThrow({ where: { code } })).revokedAt).toBeNull()
  })
})

describe('★ bad-code spraying is limited and audited', () => {
  it('records an INVITE_ABUSE event for every dead code', async () => {
    await resolve('FAKECODE')
    await resolve('FAKECOD2')

    const events = await eventually(
      () => db.securityEvent.findMany({ where: { kind: 'INVITE_ABUSE' } }),
      (rows) => rows.length >= 2,
    )

    expect(events.length).toBeGreaterThanOrEqual(2)
    // The *reason* lives in the audit row, where it is useful, and never in the
    // response to whoever supplied the code.
    expect(events[0]?.detailsJson ?? '').toContain('INVITE_NOT_USABLE')
  })

  it('★ throttles resolution on its own tighter budget, and says when to return', async () => {
    const limit = container.env.INVITE_RESOLVE_MAX
    let limited: request.Response | undefined

    for (let i = 0; i <= limit + 1; i += 1) {
      const res = await resolve('FAKECODE')
      if (res.status === 429) {
        limited = res
        break
      }
    }

    expect(limited, `no 429 within ${limit + 2} attempts`).toBeDefined()
    expect(limited?.body.code).toBe('RATE_LIMITED')
    expect(limited?.body.retryAfterMs).toBeGreaterThan(0)
    expect(limited?.headers['retry-after']).toBeDefined()

    const events = await eventually(
      () => db.securityEvent.findMany({ where: { kind: 'INVITE_ABUSE' } }),
      (rows) => rows.some((row) => (row.detailsJson ?? '').includes('RESOLVE_RATE_LIMIT')),
    )
    expect(events.some((row) => (row.detailsJson ?? '').includes('RESOLVE_RATE_LIMIT'))).toBe(true)
  })

  it('a malformed code is refused by the boundary before any lookup', async () => {
    // `InviteCodeSchema` bounds the shape, so the database is never asked about
    // a 300-character "code".
    expect((await resolve('x'.repeat(300))).status).toBe(400)
  })
})

/** A guest identity minted from a real invite code. */
async function guestWith(code: string): Promise<Client> {
  const agent = client(app)
  const res = await agent.post('/api/v1/auth/guest').send({ inviteCode: code, displayName: 'Sara' })

  expect(res.status).toBe(201)
  return agent
}

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
