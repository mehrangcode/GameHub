import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { TableDetailSchema } from '../../src/contracts/dto/tables.js'
import { buildTestApp, client, registerUser, type Client } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'

/**
 * S18 — table lifecycle over REST.
 *
 * The load-bearing test in this file is the one that asserts what the detail
 * response does *not* contain. REST carries the table before play; cards, turn
 * order and legal moves travel over the socket, projected once per viewer
 * (02 §3.1). That rule erodes one convenient field at a time, so it is pinned
 * here rather than trusted.
 */
const { app, resetLimits } = buildTestApp()

let host: Client
let hostUserId: string

const createTable = (agent: Client, body: Record<string, unknown> = {}) =>
  agent.post('/api/v1/tables').send({ gameSlug: 'fixture', seatCount: 4, options: {}, ...body })

beforeEach(async () => {
  await resetDb()
  resetLimits()

  const registered = await registerUser(app, { displayName: 'TheHost' })
  host = registered.agent
  hostUserId = registered.response.body.identity.userId
})

describe('POST /tables', () => {
  it('creates a table for a playable game', async () => {
    const res = await createTable(host)

    expect(res.status).toBe(201)
    const parsed = TableDetailSchema.safeParse(res.body)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)

    expect(res.body).toMatchObject({
      gameSlug: 'fixture',
      seatCount: 4,
      status: 'WAITING',
      // A private table is reward-eligible by construction; only the farming
      // guard (09 §7) flips this off, and it inspects matchmade tables.
      origin: 'PRIVATE',
      rewardEligible: true,
      isHost: true,
      hostDisplayName: 'TheHost',
    })
  })

  it('★ does not seat the host — sitting down is a separate act', async () => {
    const res = await createTable(host)

    expect(res.body.seatsTaken).toBe(0)
    expect(res.body.mySeat).toBeNull()
    // Exactly `seatCount` entries, all empty, index-aligned: this is what the
    // "sit here" buttons bind to.
    expect(res.body.seats).toHaveLength(4)
    for (const [index, seat] of res.body.seats.entries()) {
      expect(seat).toMatchObject({ seat: index, occupant: null, memberId: null })
    }
  })

  it('stores post-parse options, defaults filled in', async () => {
    const res = await createTable(host, { options: { target: 3 } })

    // What you see is what plays — and what a replay a year from now uses.
    expect(res.body.options).toEqual({ target: 3, strikesResetOnAction: true })
    const row = await db.table.findFirstOrThrow()
    expect(JSON.parse(row.optionsJson)).toEqual({ target: 3, strikesResetOnAction: true })
  })

  it('invalid options → 400 with per-field i18n keys', async () => {
    const res = await createTable(host, { options: { target: 999 } })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.fieldErrors['options.target']).toEqual(['errors.field.tooBig'])
    // Nothing was written: an unplayable table is a refusal, not a row.
    expect(await db.table.count()).toBe(0)
  })

  it('an unknown option key → 400, named', async () => {
    const res = await createTable(host, { options: { nope: true } })

    expect(res.status).toBe(400)
    expect(res.body.fieldErrors['options.nope']).toEqual(['errors.field.unknownKey'])
  })

  it('a seatCount outside playableCounts → 400 listing the counts that work', async () => {
    const res = await createTable(host, { seatCount: 1 })

    expect(res.status).toBe(400)
    expect(res.body.fieldErrors.seatCount).toEqual(['errors.seatCountNotPlayable'])
    expect(res.body.details.playableCounts).toEqual([2, 3, 4])
  })

  it('a comingSoon game → 400, not a table nobody can play', async () => {
    const res = await createTable(host, { gameSlug: 'shelem' })

    expect(res.status).toBe(400)
    expect(res.body.fieldErrors.gameSlug).toEqual(['errors.gameComingSoon'])
  })

  it('an unknown game → 404', async () => {
    expect((await createTable(host, { gameSlug: 'nope' })).status).toBe(404)
  })

  it('hosting requires an account — a guest is 403, not 401', async () => {
    const table = await db.table.create({
      data: { hostUserId, gameSlug: 'fixture', optionsJson: '{}', seatCount: 4 },
    })
    const guest = await guestAt(table.id)

    // 401 would mean "refresh and retry", which a guest can never win.
    const res = await createTable(guest)
    expect(res.status).toBe(403)
  })

  it('anonymous is 401', async () => {
    expect((await createTable(client(app))).status).toBe(401)
  })
})

describe('GET /tables/:id', () => {
  it('★ carries no game state — the transport rule, pinned', async () => {
    const created = await createTable(host)
    const res = await host.get(`/api/v1/tables/${created.body.id}`)

    expect(res.status).toBe(200)

    // Every one of these is a socket concern, projected once per viewer. A
    // `deck` on a REST response would leak the entire future of the game
    // (02 §3.1, and the classic bug 05 §2 names).
    for (const forbidden of [
      'state',
      'gameState',
      'deck',
      'deckCount',
      'hands',
      'hand',
      'cards',
      'board',
      'turn',
      'currentSeat',
      'legalMoves',
      'events',
      'seed',
      'rngSeed',
      'snapshot',
    ]) {
      expect(res.body, `detail carries "${forbidden}"`).not.toHaveProperty(forbidden)
    }

    expect(Object.keys(res.body).sort()).toEqual(Object.keys(TableDetailSchema.shape).sort())
  })

  it('names occupants without handing out account identifiers', async () => {
    const created = await createTable(host)
    await host.post(`/api/v1/_probe/tables/${created.body.id}/seats`).send({ seat: 1 })

    const res = await host.get(`/api/v1/tables/${created.body.id}`)
    const seat = res.body.seats[1]

    expect(seat.occupant).toMatchObject({ kind: 'user', displayName: 'TheHost' })
    // "Which seat is mine?" is answered by `isSelf`, so a seat map shown to
    // spectators and invite-holders need not carry ids at all.
    expect(seat.isSelf).toBe(true)
    expect(seat.occupant).not.toHaveProperty('userId')
    expect(JSON.stringify(res.body)).not.toContain(hostUserId)
  })

  it('is readable by anyone who can name it — the id is the capability', async () => {
    const created = await createTable(host)
    const stranger = (await registerUser(app, { displayName: 'Stranger' })).agent

    const res = await stranger.get(`/api/v1/tables/${created.body.id}`)

    expect(res.status).toBe(200)
    expect(res.body.isHost).toBe(false)
    expect(res.body.mySeat).toBeNull()
  })

  it('unknown table → 404', async () => {
    expect((await host.get('/api/v1/tables/does-not-exist')).status).toBe(404)
  })

  it('anonymous is 401', async () => {
    const created = await createTable(host)
    expect((await request(app).get(`/api/v1/tables/${created.body.id}`)).status).toBe(401)
  })

  it('★ a guest reads its own table and is 403 on any other', async () => {
    const mine = await createTable(host)
    const other = await createTable(host)
    const guest = await guestAt(mine.body.id)

    expect((await guest.get(`/api/v1/tables/${mine.body.id}`)).status).toBe(200)

    const refused = await guest.get(`/api/v1/tables/${other.body.id}`)
    expect(refused.status).toBe(403)
    expect(refused.body.details.reason).toBe('GUEST_TABLE_BINDING')
  })
})

describe('GET /tables/mine', () => {
  it('lists the tables you host, for the resume screen', async () => {
    const first = await createTable(host)
    await createTable(host, { seatCount: 2 })
    const other = (await registerUser(app, { displayName: 'Other' })).agent
    await createTable(other)

    const res = await host.get('/api/v1/tables/mine')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
    expect(res.body.map((table: { id: string }) => table.id)).toContain(first.body.id)
    for (const table of res.body) expect(table.isHost).toBe(true)
  })

  it('includes a table you are only seated at, and drops closed ones', async () => {
    const hosted = await createTable(host)
    const guestHost = (await registerUser(app, { displayName: 'Other' })).agent
    const theirs = await createTable(guestHost)

    await host.post(`/api/v1/_probe/tables/${theirs.body.id}/seats`).send({ seat: 2 })
    await host.delete(`/api/v1/tables/${hosted.body.id}`)

    const res = await host.get('/api/v1/tables/mine')

    expect(res.body.map((table: { id: string }) => table.id)).toEqual([theirs.body.id])
    expect(res.body[0].mySeat).toBe(2)
    expect(res.body[0].isHost).toBe(false)
  })

  it('"mine" is not read as a table id', async () => {
    // The route order matters: `/tables/mine` must be declared before
    // `/tables/:id`, or this is a 404 for a table called "mine".
    expect((await host.get('/api/v1/tables/mine')).status).toBe(200)
  })

  it('a guest has no list to browse — 403', async () => {
    const created = await createTable(host)
    const guest = await guestAt(created.body.id)

    expect((await guest.get('/api/v1/tables/mine')).status).toBe(403)
  })
})

describe('PATCH /tables/:id', () => {
  it('the host edits the deal while WAITING', async () => {
    const created = await createTable(host)

    const res = await host
      .patch(`/api/v1/tables/${created.body.id}`)
      .send({ seatCount: 2, options: { target: 7 }, allowSpectators: false })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ seatCount: 2, allowSpectators: false })
    expect(res.body.options).toEqual({ target: 7, strikesResetOnAction: true })
    expect(res.body.seats).toHaveLength(2)
  })

  it('★ a non-host is 403', async () => {
    const created = await createTable(host)
    const stranger = (await registerUser(app, { displayName: 'Stranger' })).agent

    const res = await stranger
      .patch(`/api/v1/tables/${created.body.id}`)
      .send({ allowSpectators: false })

    expect(res.status).toBe(403)
    expect(res.body.details.reason).toBe('HOST_REQUIRED')
  })

  it('a guest is 403 — hosting needs an account', async () => {
    const created = await createTable(host)
    const guest = await guestAt(created.body.id)

    const res = await guest
      .patch(`/api/v1/tables/${created.body.id}`)
      .send({ allowSpectators: false })

    expect(res.status).toBe(403)
  })

  it('★ IN_PROGRESS is 409 — the request is fine, the table is past accepting it', async () => {
    const created = await createTable(host)
    await db.table.update({ where: { id: created.body.id }, data: { status: 'IN_PROGRESS' } })

    const res = await host.patch(`/api/v1/tables/${created.body.id}`).send({ seatCount: 2 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ILLEGAL_PHASE_TRANSITION')
  })

  it('will not shrink a table out from under a seated player', async () => {
    const created = await createTable(host)
    await host.post(`/api/v1/_probe/tables/${created.body.id}/seats`).send({ seat: 3 })

    const res = await host.patch(`/api/v1/tables/${created.body.id}`).send({ seatCount: 2 })

    expect(res.status).toBe(400)
    expect(res.body.fieldErrors.seatCount).toEqual(['errors.seatCountBelowOccupied'])
    expect(res.body.details.occupiedSeats).toEqual([3])
  })

  it('an empty patch is a refusal, not a no-op success', async () => {
    const created = await createTable(host)

    // "Change nothing" almost always means the client sent the wrong field
    // name, and answering 200 hides that bug.
    expect((await host.patch(`/api/v1/tables/${created.body.id}`).send({})).status).toBe(400)
  })

  it('cannot change the game — that would be a different table', async () => {
    const created = await createTable(host)

    const res = await host
      .patch(`/api/v1/tables/${created.body.id}`)
      .send({ gameSlug: 'blackjack' })

    expect(res.status).toBe(400)
  })
})

describe('DELETE /tables/:id', () => {
  it('the host closes the table, and closing is a tombstone', async () => {
    const created = await createTable(host)

    expect((await host.delete(`/api/v1/tables/${created.body.id}`)).status).toBe(204)

    // Never a DELETE: the event log, match results and ledger rows all
    // reference this table, and cascading would delete the history that pays
    // people.
    const row = await db.table.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.status).toBe('CLOSED')
    expect(row.closedAt).not.toBeNull()
  })

  it('is idempotent', async () => {
    const created = await createTable(host)

    await host.delete(`/api/v1/tables/${created.body.id}`)
    expect((await host.delete(`/api/v1/tables/${created.body.id}`)).status).toBe(204)
  })

  it('a non-host is 403 and the table stays open', async () => {
    const created = await createTable(host)
    const stranger = (await registerUser(app, { displayName: 'Stranger' })).agent

    expect((await stranger.delete(`/api/v1/tables/${created.body.id}`)).status).toBe(403)
    expect(
      (await db.table.findUniqueOrThrow({ where: { id: created.body.id } })).closedAt,
    ).toBeNull()
  })

  it('a matchmade table has no host, so every host-level route refuses it', async () => {
    // Nobody owns a table the matchmaker assembled; its options are the
    // preset's, not a player's (09 §2).
    const table = await db.table.create({
      data: {
        hostUserId: null,
        gameSlug: 'fixture',
        optionsJson: '{}',
        seatCount: 4,
        origin: 'MATCHMADE',
      },
    })

    expect((await host.delete(`/api/v1/tables/${table.id}`)).status).toBe(403)
    expect((await host.patch(`/api/v1/tables/${table.id}`).send({ seatCount: 2 })).status).toBe(403)
  })
})

/** A guest identity bound to `tableId`, minted through the real endpoint. */
async function guestAt(tableId: string): Promise<Client> {
  const invite = await db.invite.create({
    data: {
      tableId,
      code: `G${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
      createdByUserId: hostUserId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })

  const agent = client(app)
  const res = await agent
    .post('/api/v1/auth/guest')
    .send({ inviteCode: invite.code, displayName: 'Sara' })

  expect(res.status).toBe(201)
  return agent
}
