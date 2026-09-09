import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { GameCatalogService } from '../../src/application/services/GameCatalogService.js'
import { TableService } from '../../src/application/services/TableService.js'
import { fixtureMeta } from '../../src/domain/games/_fixture/meta.js'
import type { GameMeta } from '../../src/domain/games/GameEngine.js'
import type { GameRegistry } from '../../src/domain/games/registry.js'
import { SeatTakenError } from '../../src/domain/errors/errors.js'
import type { IdentityRef, OccupantRef } from '../../src/domain/value-objects/identity.js'
import { buildTestApp, client, registerUser, type Client } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'

/**
 * S20 — the seat race, at the level where it is actually decided.
 *
 * ★ Two friends clicking seat 2 in the same millisecond is a real event, not a
 * theoretical one, and it is the reason there is **no `SELECT` in the claim
 * path**: the insert goes in and the `(tableId, seat)` unique constraint picks
 * the winner (03 §6.3). A read-then-write would let both callers see an empty
 * seat and one silently overwrite the other.
 *
 * The concurrency cases go through the service against the real database,
 * because the constraint is the mechanism under test — a fake cannot prove it.
 * The authorization cases go over HTTP, because that is where the guest binding
 * lives.
 */
const { app, container, resetLimits } = buildTestApp()
const tables = container.tables

let host: Client
let hostUserId: string
let tableId: string

const userRef = (userId: string): IdentityRef => ({ kind: 'user', userId })
const actorFor = (userId: string, isHost = false) => ({ identity: userRef(userId), isHost })

beforeEach(async () => {
  await resetDb()
  resetLimits()

  const registered = await registerUser(app, { displayName: 'TheHost' })
  host = registered.agent
  hostUserId = registered.response.body.identity.userId

  tableId = (
    await host.post('/api/v1/tables').send({ gameSlug: 'fixture', seatCount: 4, options: {} })
  ).body.id
})

describe('★ the concurrent claim', () => {
  it('★ two claims on the same seat: exactly one wins', async () => {
    const rival = await makeSecondUser()

    const results = await Promise.allSettled([
      tables.claimSeat(tableId, 2, userRef(hostUserId), actorFor(hostUserId, true)),
      tables.claimSeat(tableId, 2, userRef(rival), actorFor(rival)),
    ])

    const won = results.filter((result) => result.status === 'fulfilled')
    const lost = results.filter((result) => result.status === 'rejected')

    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)

    // The loser gets a 409 that names the seat, not a 500 and not a success.
    const error = (lost[0] as PromiseRejectedResult).reason
    expect(error).toBeInstanceOf(SeatTakenError)
    expect(error.httpStatus).toBe(409)
    expect(error.code).toBe('SEAT_TAKEN')

    // And the database holds exactly one occupant of seat 2.
    const members = await db.tableMember.findMany({ where: { tableId, seat: 2 } })
    expect(members).toHaveLength(1)
  })

  it('★ four rivals racing for one seat still produce one occupant', async () => {
    const rivals = await Promise.all([
      makeSecondUser(),
      makeSecondUser(),
      makeSecondUser(),
      makeSecondUser(),
    ])

    const results = await Promise.allSettled(
      rivals.map((userId) => tables.claimSeat(tableId, 0, userRef(userId), actorFor(userId))),
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await db.tableMember.count({ where: { tableId, seat: 0 } })).toBe(1)
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(SeatTakenError)
    }
  })

  it('distinguishes "that seat is taken" from "you are already sitting here"', async () => {
    const rival = await makeSecondUser()
    await tables.claimSeat(tableId, 1, userRef(hostUserId), actorFor(hostUserId, true))

    // Two different problems with two different buttons to press.
    await expect(
      tables.claimSeat(tableId, 1, userRef(rival), actorFor(rival)),
    ).rejects.toMatchObject({ details: { reason: 'SEAT_OCCUPIED' } })

    await expect(
      tables.claimSeat(tableId, 3, userRef(hostUserId), actorFor(hostUserId, true)),
    ).rejects.toMatchObject({ details: { reason: 'ALREADY_SEATED', yourSeat: 1 } })
  })

  it('★ one identity cannot hold two seats at one table', async () => {
    await tables.claimSeat(tableId, 0, userRef(hostUserId), actorFor(hostUserId, true))

    await expect(
      tables.claimSeat(tableId, 1, userRef(hostUserId), actorFor(hostUserId, true)),
    ).rejects.toBeInstanceOf(SeatTakenError)

    expect(await db.tableMember.count({ where: { tableId, userId: hostUserId } })).toBe(1)
  })

  it('the same identity may sit at two different tables', async () => {
    const second = (
      await host.post('/api/v1/tables').send({ gameSlug: 'fixture', seatCount: 4, options: {} })
    ).body.id

    await tables.claimSeat(tableId, 0, userRef(hostUserId), actorFor(hostUserId, true))
    await tables.claimSeat(second, 0, userRef(hostUserId), actorFor(hostUserId, true))

    expect(await db.tableMember.count({ where: { userId: hostUserId } })).toBe(2)
  })

  it('a full table refuses the next claim', async () => {
    const players = [
      hostUserId,
      ...(await Promise.all([makeSecondUser(), makeSecondUser(), makeSecondUser()])),
    ]
    for (const [seat, userId] of players.entries()) {
      await tables.claimSeat(tableId, seat, userRef(userId), actorFor(userId))
    }

    const latecomer = await makeSecondUser()
    for (let seat = 0; seat < 4; seat += 1) {
      await expect(
        tables.claimSeat(tableId, seat, userRef(latecomer), actorFor(latecomer)),
      ).rejects.toBeInstanceOf(SeatTakenError)
    }
  })

  it('a seat that does not exist is a 400, not a 409', async () => {
    // "Seat 7 is taken" would be a lie about a four-seat table.
    await expect(
      tables.claimSeat(tableId, 7, userRef(hostUserId), actorFor(hostUserId, true)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('a closed table takes no more players', async () => {
    await tables.close(tableId)

    await expect(
      tables.claimSeat(tableId, 0, userRef(hostUserId), actorFor(hostUserId, true)),
    ).rejects.toMatchObject({ code: 'ILLEGAL_PHASE_TRANSITION' })
  })
})

describe('occupant kinds', () => {
  it('seats a guest at its own table', async () => {
    const guest = await db.guestSession.create({
      data: {
        tokenHash: 'hash-guest-seat',
        displayName: 'Sara',
        tableId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const ref: OccupantRef = { kind: 'guest', guestSessionId: guest.id }

    const detail = await tables.claimSeat(tableId, 1, ref, { identity: ref, isHost: false })

    expect(detail.seats[1]?.occupant).toMatchObject({ kind: 'guest', displayName: 'Sara' })
    expect(detail.seats[1]?.isSelf).toBe(true)
  })

  it('★ only the host may seat a bot', async () => {
    const stranger = await makeSecondUser()

    await expect(
      tables.claimSeat(tableId, 1, { kind: 'bot', difficulty: 'easy' }, actorFor(stranger)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'HOST_REQUIRED' } })

    const detail = await tables.claimSeat(
      tableId,
      1,
      { kind: 'bot', difficulty: 'easy' },
      actorFor(hostUserId, true),
    )
    expect(detail.seats[1]?.occupant).toMatchObject({ kind: 'bot', botDifficulty: 'easy' })
  })

  it('requireApproval refuses a stranger until the host admits them', async () => {
    await db.table.update({ where: { id: tableId }, data: { requireApproval: true } })
    const stranger = await makeSecondUser()

    // A leaked link's defence (03 §3.2). There is no pending-member state yet,
    // so approval is a refusal rather than a queue — the socket flow lands in
    // S24/S43.
    await expect(
      tables.claimSeat(tableId, 1, userRef(stranger), actorFor(stranger)),
    ).rejects.toMatchObject({ details: { reason: 'APPROVAL_REQUIRED' } })

    // The host is never gated on their own approval.
    await expect(
      tables.claimSeat(tableId, 1, userRef(hostUserId), actorFor(hostUserId, true)),
    ).resolves.toBeTruthy()
  })

  it('★ writes the team in the same insert for a partnership game', async () => {
    const teamed = teamedTableService()
    const partners = [
      hostUserId,
      ...(await Promise.all([makeSecondUser(), makeSecondUser(), makeSecondUser()])),
    ]

    for (const [seat, userId] of partners.entries()) {
      await teamed.claimSeat(
        tableId,
        seat,
        userRef(userId),
        actorFor(userId, userId === hostUserId),
      )
    }

    // Shelem's `seat % 2`: partners sit across from each other. A follow-up
    // update could fail and leave a seated player on no team, which is why it
    // is one write.
    const rows = await db.tableMember.findMany({ where: { tableId }, orderBy: { seat: 'asc' } })
    expect(rows.map((row) => row.team)).toEqual([0, 1, 0, 1])
  })

  it('leaves team null for a game without partnerships', async () => {
    await tables.claimSeat(tableId, 0, userRef(hostUserId), actorFor(hostUserId, true))

    expect((await db.tableMember.findFirstOrThrow()).team).toBeNull()
  })
})

describe('spectators', () => {
  it('★ many spectators coexist — the seat = null case', async () => {
    const watchers = await Promise.all([makeSecondUser(), makeSecondUser(), makeSecondUser()])

    for (const userId of watchers) {
      await tables.joinAsSpectator(tableId, userRef(userId), userRef(userId))
    }

    // `(tableId, seat)` treats NULLs as distinct on both SQLite and Postgres,
    // which is what lets an unbounded audience share one table.
    const detail = await tables.detail(tableId, userRef(hostUserId))
    expect(detail.spectatorCount).toBe(3)
    expect(detail.seats.every((seat) => seat.occupant === null)).toBe(true)
  })

  it('joining twice is the outcome the caller wanted, not a 500', async () => {
    const watcher = await makeSecondUser()

    await tables.joinAsSpectator(tableId, userRef(watcher), userRef(watcher))
    await expect(
      tables.joinAsSpectator(tableId, userRef(watcher), userRef(watcher)),
    ).resolves.toBeTruthy()

    expect(await db.tableMember.count({ where: { tableId, userId: watcher } })).toBe(1)
  })

  it('is refused when the table disallows them', async () => {
    await db.table.update({ where: { id: tableId }, data: { allowSpectators: false } })
    const watcher = await makeSecondUser()

    await expect(
      tables.joinAsSpectator(tableId, userRef(watcher), userRef(watcher)),
    ).rejects.toMatchObject({ details: { reason: 'SPECTATORS_NOT_ALLOWED' } })
  })
})

describe('★ release behaves differently either side of the deal', () => {
  it('WAITING frees the seat, and someone else may take it', async () => {
    const rival = await makeSecondUser()
    await tables.claimSeat(tableId, 2, userRef(hostUserId), actorFor(hostUserId, true))

    await tables.releaseSeat(tableId, 2, actorFor(hostUserId, true))

    expect(await db.tableMember.count({ where: { tableId, seat: 2 } })).toBe(0)
    await expect(
      tables.claimSeat(tableId, 2, userRef(rival), actorFor(rival)),
    ).resolves.toBeTruthy()
  })

  it('★ IN_PROGRESS keeps the row and stamps disconnectedAt — the seat belongs to the match', async () => {
    await tables.claimSeat(tableId, 2, userRef(hostUserId), actorFor(hostUserId, true))
    await db.table.update({ where: { id: tableId }, data: { status: 'IN_PROGRESS' } })

    await tables.releaseSeat(tableId, 2, actorFor(hostUserId, true))

    // Vacating it would delete a hand mid-play: the row holds the player's
    // cards, their chips and their reward eligibility (04 §5.2).
    const member = await db.tableMember.findFirstOrThrow({ where: { tableId, seat: 2 } })
    expect(member.disconnectedAt).not.toBeNull()
    expect(member.leftAt).toBeNull()
  })

  it('★ unseating someone else is a host act — and an audited refusal otherwise', async () => {
    const rival = await makeSecondUser()
    await tables.claimSeat(tableId, 1, userRef(rival), actorFor(rival))

    await expect(
      tables.releaseSeat(tableId, 1, actorFor(await makeSecondUser())),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'NOT_YOUR_SEAT' } })

    const events = await eventually(
      () => db.securityEvent.findMany({ where: { kind: 'SEAT_IMPERSONATION' } }),
      (rows) => rows.length > 0,
    )
    expect(events[0]?.detailsJson).toContain('RELEASE_OTHER_SEAT')

    // The host may remove a player — that is a kick, and it is host authority.
    await expect(tables.releaseSeat(tableId, 1, actorFor(hostUserId, true))).resolves.toBeTruthy()
  })

  it('releasing an empty seat is a 404', async () => {
    await expect(tables.releaseSeat(tableId, 0, actorFor(hostUserId, true))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('the seat routes over HTTP (dev stand-in for S24)', () => {
  it('claims and releases through the same service', async () => {
    const claim = await host.post(`/api/v1/_probe/tables/${tableId}/seats`).send({ seat: 1 })

    expect(claim.status).toBe(201)
    expect(claim.body.seats[1].isSelf).toBe(true)

    expect((await host.delete(`/api/v1/_probe/tables/${tableId}/seats/1`)).status).toBe(200)
  })

  it('a taken seat is a 409 over HTTP too', async () => {
    const stranger = (await registerUser(app, { displayName: 'Stranger' })).agent
    await host.post(`/api/v1/_probe/tables/${tableId}/seats`).send({ seat: 1 })

    const res = await stranger.post(`/api/v1/_probe/tables/${tableId}/seats`).send({ seat: 1 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SEAT_TAKEN')
  })

  it('★ seat identity comes from the socket/cookie, never from the payload', async () => {
    const stranger = (await registerUser(app, { displayName: 'Stranger' })).agent

    // There is no field in `ClaimSeatRequest` that names an occupant, and
    // sending one is a 400 rather than an impersonation.
    const res = await stranger
      .post(`/api/v1/_probe/tables/${tableId}/seats`)
      .send({ seat: 1, userId: hostUserId })

    expect(res.status).toBe(400)
    expect(await db.tableMember.count()).toBe(0)
  })

  it('★ a guest cannot claim a seat at a table it is not bound to — 403 plus an audit row', async () => {
    const other = (
      await host.post('/api/v1/tables').send({ gameSlug: 'fixture', seatCount: 4, options: {} })
    ).body.id
    const guest = await guestAt(tableId)

    const res = await guest.post(`/api/v1/_probe/tables/${other}/seats`).send({ seat: 0 })

    expect(res.status).toBe(403)
    expect(res.body.details.reason).toBe('GUEST_TABLE_BINDING')

    const events = await eventually(
      () => db.securityEvent.findMany({ where: { kind: 'SEAT_IMPERSONATION' } }),
      (rows) => rows.length > 0,
    )
    expect(events[0]?.severity).toBe('ALERT')
    expect(await db.tableMember.count({ where: { tableId: other } })).toBe(0)
  })
})

/**
 * A `TableService` whose catalog reports `fixture` as a 2×2 partnership game.
 *
 * Every teamed game in the catalog is `comingSoon` at M0, so no teamed table
 * can legitimately exist yet — and team assignment still has to be proven
 * against the real column before Shelem arrives in M4.
 */
function teamedTableService(): TableService {
  const meta: GameMeta = { ...fixtureMeta, playableCounts: [4], teams: { size: 2, count: 2 } }
  const registry: GameRegistry = {
    meta: () => meta,
    list: () => [meta],
    has: () => true,
    engine: () => undefined,
    requireEngine: () => {
      throw new Error('not needed')
    },
  }

  return new TableService({
    repos: container.repos,
    catalog: new GameCatalogService(registry),
    security: container.security,
    metrics: container.metrics,
    logger: pino({ level: 'silent' }),
  })
}

async function makeSecondUser(): Promise<string> {
  return (await registerUser(app)).response.body.identity.userId
}

async function guestAt(boundTableId: string): Promise<Client> {
  const invite = await db.invite.create({
    data: {
      tableId: boundTableId,
      code: `S${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
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
