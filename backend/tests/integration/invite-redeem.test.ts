import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, client, registerUser } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import { RedeemInviteResponseSchema } from '../../src/contracts/dto/invites.js'

/**
 * S43 — `POST /invites/:code/redeem`.
 *
 * The route exists because `GET /invites/:code` withholds `tableId` from
 * everyone, which is right for a pre-join screen shown to anybody holding a
 * leaked link — and left a signed-in user with no way to reach the table a
 * friend invited them to, short of becoming a guest.
 *
 * Two properties matter, and the second was a bug caught while writing this
 * file:
 *
 *   1. failures answer **byte-identically to the public resolve**, so an
 *      account is not a cheaper way to enumerate live codes;
 *   2. ★ it **consumes no use**. `maxUses` counts guest identities minted
 *      against a link; a user refreshing the invite page must not burn two uses
 *      of a `maxUses: 2` link and lock out the friend it was for.
 */

const { app, container, resetLimits } = buildTestApp()

beforeEach(async () => {
  await resetDb()
  resetLimits()
})

afterAll(async () => {
  await container.shutdown()
})

async function seedInvite(maxUses: number | null = null) {
  const host = await registerUser(app)
  const table = await host.agent
    .post('/api/v1/tables')
    .send({ gameSlug: 'fixture', seatCount: 4, options: {} })

  const invite = await host.agent
    .post(`/api/v1/tables/${table.body.id}/invites`)
    .send(maxUses === null ? {} : { maxUses })

  return { host, tableId: table.body.id as string, code: invite.body.code as string }
}

describe('POST /invites/:code/redeem', () => {
  it('answers a signed-in user with the tableId the public resolve withholds', async () => {
    const { tableId, code } = await seedInvite()
    const friend = await registerUser(app)

    const response = await friend.agent.post(`/api/v1/invites/${code}/redeem`)

    expect(response.status).toBe(200)
    expect(RedeemInviteResponseSchema.safeParse(response.body).success).toBe(true)
    expect(response.body.tableId).toBe(tableId)
    // Server-decided, exactly as on the guest and claim responses — a client
    // that reconstructed this could drift to a stale table.
    expect(response.body.redirectTo).toBe(`/table/${tableId}`)
  })

  it('★★ consumes NO invite use — a refresh must not burn the link', async () => {
    const { code } = await seedInvite(2)
    const friend = await registerUser(app)

    await friend.agent.post(`/api/v1/invites/${code}/redeem`)
    await friend.agent.post(`/api/v1/invites/${code}/redeem`)
    await friend.agent.post(`/api/v1/invites/${code}/redeem`)

    const invite = await db.invite.findFirst({ where: { code } })
    // Three redeems, zero uses. `maxUses` counts guest identities minted
    // against the link (`POST /auth/guest`), and this route mints none.
    expect(invite?.useCount).toBe(0)
  })

  it('…while the guest path still DOES consume one', async () => {
    const { code } = await seedInvite(2)

    await client(app).post('/api/v1/auth/guest').send({ inviteCode: code, displayName: 'Sara' })

    const invite = await db.invite.findFirst({ where: { code } })
    expect(invite?.useCount).toBe(1)
  })

  it('reports alreadyMember as information, gating nothing on it', async () => {
    const { code } = await seedInvite()
    const friend = await registerUser(app)

    const response = await friend.agent.post(`/api/v1/invites/${code}/redeem`)

    // Membership is created by `table:join` over the socket, never here, so on
    // this path it is false — and the route still answers in full.
    expect(response.status).toBe(200)
    expect(response.body.alreadyMember).toBe(false)
  })

  it('★ an unknown code answers exactly as the public resolve does', async () => {
    const friend = await registerUser(app)

    const redeem = await friend.agent.post('/api/v1/invites/NOPE12345/redeem')
    const resolve = await client(app).get('/api/v1/invites/NOPE12345')

    expect(redeem.status).toBe(410)
    expect(redeem.body.code).toBe('INVITE_EXPIRED')
    // An account must not be a cheaper oracle than anonymity (07 §5.2).
    expect(redeem.body).toEqual(resolve.body)
  })

  it('★ …and so does a revoked one — never a distinguishable answer', async () => {
    const { tableId, code, host } = await seedInvite()
    await host.agent.delete(`/api/v1/tables/${tableId}/invites/${code}`)

    const friend = await registerUser(app)
    const revoked = await friend.agent.post(`/api/v1/invites/${code}/redeem`)
    const unknown = await friend.agent.post('/api/v1/invites/NEVERMADE/redeem')

    expect(revoked.body).toEqual(unknown.body)
  })

  it('★ leaks no tableId in a failure body', async () => {
    const friend = await registerUser(app)

    const response = await friend.agent.post('/api/v1/invites/NOPE12345/redeem')

    expect(response.body).not.toHaveProperty('tableId')
    expect(response.body).not.toHaveProperty('redirectTo')
  })

  it('★ refuses a guest: they already have a table, and it is not negotiable', async () => {
    const { code } = await seedInvite()

    const guest = client(app)
    await guest.post('/api/v1/auth/guest').send({ inviteCode: code, displayName: 'Sara' })

    const response = await guest.post(`/api/v1/invites/${code}/redeem`)

    // A guest identity is bound to exactly one table (07 §3). Letting one
    // redeem a second code would make the guest token a wildcard identity.
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FORBIDDEN')
  })

  it('refuses an anonymous caller — the public resolve is that route', async () => {
    const { code } = await seedInvite()

    const response = await client(app).post(`/api/v1/invites/${code}/redeem`)

    expect(response.status).toBe(401)
  })

  it('a closed table is a dead link, same as any other', async () => {
    const { tableId, code, host } = await seedInvite()
    await host.agent.delete(`/api/v1/tables/${tableId}`)

    const friend = await registerUser(app)
    const response = await friend.agent.post(`/api/v1/invites/${code}/redeem`)

    expect(response.status).toBe(410)
  })
})
