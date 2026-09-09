import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import {
  seatRoom,
  spectatorRoom,
  tableRoom,
  userRoom,
} from '../../../src/application/ports/realtime.js'
import type { SeatChangedPayload, TableSnapshotPayload } from '../../../src/contracts/events.js'
import { resetDb } from '../../helpers/db.js'
import {
  settle,
  startSocketHarness,
  type Session,
  type SocketHarness,
  type TestClient,
} from '../../helpers/socket.js'

/**
 * S24 — the room model, and the live seat map.
 *
 * The headline is *two clients at one table see each other's seat changes
 * live*. The quieter half is the room structure underneath it, asserted **now,
 * while there is no game state to leak**, so the shape is right before it
 * matters (Phase G puts hands in the payloads that travel through these rooms).
 */

let harness: SocketHarness
let host: Session
let friend: Session
let tableId: string

async function makeTable(
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(harness.httpServer)
    .post('/api/v1/tables')
    .set('Cookie', session.cookie)
    .send({ gameSlug: 'fixture', seatCount: 4, options: {}, ...overrides })
    .expect(201)
  return (response.body as { id: string }).id
}

beforeAll(async () => {
  await resetDb()
  harness = await startSocketHarness()
  host = await harness.register('Mehrang')
  friend = await harness.register('Reza')
  tableId = await makeTable(host)
})

afterAll(async () => {
  await harness.close()
})

/** Room membership as the server sees it — the ground truth for every claim below. */
function roomsOf(socketId: string): Set<string> {
  const socket = harness.gateway.io.sockets.sockets.get(socketId)
  return new Set([...(socket?.rooms ?? [])].filter((room) => room !== socketId))
}

describe('S24 · joining and the snapshot', () => {
  let a: TestClient

  beforeEach(async () => {
    a = await harness.open(host)
  })

  it('★ table:snapshot carries the caller’s own seat and role', async () => {
    const ack = await a.emit<{ tableId: string; you: { seat: number | null } }>('table:join', {
      tableId,
    })
    expect(ack.ok).toBe(true)

    const snapshot = await a.next<TableSnapshotPayload>('table:snapshot')
    expect(snapshot.table.id).toBe(tableId)
    expect(snapshot.you).toMatchObject({ seat: null, isHost: true, isSpectator: true })
    // Exactly `seatCount` entries, so the "sit here" buttons have something to
    // bind to and an empty seat is a first-class value rather than a gap.
    expect(snapshot.table.seats).toHaveLength(4)
    expect(snapshot.chat).toEqual([])

    a.close()
  })

  it('a joiner lands in the table room and the spectator room, not a seat room', async () => {
    await a.emit('table:join', { tableId })
    await a.next('table:snapshot')

    expect(roomsOf(a.socket.id!)).toEqual(
      new Set([tableRoom(tableId), spectatorRoom(tableId), userRoom(hostUserId())]),
    )

    a.close()
  })

  it('a table with spectators disabled routes no spectator projection', async () => {
    const closedTable = await makeTable(host, { allowSpectators: false })
    await a.emit('table:join', { tableId: closedTable })
    await a.next('table:snapshot')

    // The lobby is still readable — `GET /tables/:id` already allows anyone who
    // can name the table — but nothing routes them a game view.
    expect(roomsOf(a.socket.id!).has(spectatorRoom(closedTable))).toBe(false)
    expect(roomsOf(a.socket.id!).has(tableRoom(closedTable))).toBe(true)

    a.close()
  })

  it('an unknown table is a 404, not an empty lobby', async () => {
    const ack = await a.emit('table:join', { tableId: 'no-such-table' })
    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.code).toBe('NOT_FOUND')

    a.close()
  })
})

describe('S24 · two clients, one table', () => {
  let a: TestClient
  let b: TestClient
  let live: string

  beforeEach(async () => {
    live = await makeTable(host)
    a = await harness.open(host)
    b = await harness.open(friend)

    await a.emit('table:join', { tableId: live })
    await b.emit('table:join', { tableId: live })
    await a.next('table:snapshot')
    await b.next('table:snapshot')
    a.clear()
    b.clear()
  })

  it('★ A takes seat 1 → B receives table:seatChanged', async () => {
    const ack = await a.emit<{ seat: number | null }>('table:takeSeat', { tableId: live, seat: 1 })
    expect(ack.ok).toBe(true)
    if (ack.ok) expect(ack.data.seat).toBe(1)

    const seen = await b.next<SeatChangedPayload>('table:seatChanged')
    expect(seen).toMatchObject({ tableId: live, seat: 1 })
    expect(seen.occupant).toMatchObject({ kind: 'user', displayName: 'Mehrang' })

    // The mover's own rooms follow immediately — before the broadcast — so a
    // private projection can never reach a socket still in the seat it left.
    expect(roomsOf(a.socket.id!).has(seatRoom(live, 1))).toBe(true)
    expect(roomsOf(a.socket.id!).has(spectatorRoom(live))).toBe(false)

    a.close()
    b.close()
  })

  it('★ taking an occupied seat is refused with SEAT_TAKEN', async () => {
    await a.emit('table:takeSeat', { tableId: live, seat: 1 })
    await b.next('table:seatChanged')

    const ack = await b.emit('table:takeSeat', { tableId: live, seat: 1 })
    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('SEAT_TAKEN')
      // Which constraint fired matters: "that seat is taken" and "you are
      // already sitting here" are different problems with different buttons.
      expect(ack.details).toMatchObject({ reason: 'SEAT_OCCUPIED', seat: 1 })
    }

    // B then takes 2 and A sees it — the other direction of the same claim.
    b.clear()
    a.clear()
    const second = await b.emit('table:takeSeat', { tableId: live, seat: 2 })
    expect(second.ok).toBe(true)

    const seen = await a.next<SeatChangedPayload>('table:seatChanged')
    expect(seen.seat).toBe(2)
    expect(seen.occupant).toMatchObject({ displayName: 'Reza' })

    a.close()
    b.close()
  })

  it('one identity holds one seat: moving is refused as ALREADY_SEATED', async () => {
    await a.emit('table:takeSeat', { tableId: live, seat: 1 })
    const ack = await a.emit('table:takeSeat', { tableId: live, seat: 3 })

    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.details).toMatchObject({ reason: 'ALREADY_SEATED', yourSeat: 1 })

    a.close()
    b.close()
  })

  it('releasing a seat frees it and everyone is told', async () => {
    await a.emit('table:takeSeat', { tableId: live, seat: 1 })
    await b.next('table:seatChanged')
    b.clear()

    const ack = await a.emit<{ seat: number | null }>('table:releaseSeat', { tableId: live })
    expect(ack.ok).toBe(true)
    if (ack.ok) expect(ack.data.seat).toBeNull()

    const seen = await b.next<SeatChangedPayload>('table:seatChanged')
    expect(seen).toMatchObject({ seat: 1, occupant: null, memberId: null })
    expect(roomsOf(a.socket.id!).has(seatRoom(live, 1))).toBe(false)

    a.close()
    b.close()
  })

  it('releaseSeat from somebody who is not seated is refused', async () => {
    const ack = await b.emit('table:releaseSeat', { tableId: live })
    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.details).toMatchObject({ reason: 'NOT_SEATED' })

    a.close()
    b.close()
  })

  it('★ the seat room and the spectator room are disjoint, both ways', async () => {
    await a.emit('table:takeSeat', { tableId: live, seat: 1 })
    await settle()

    const seated = roomsOf(a.socket.id!)
    const watching = roomsOf(b.socket.id!)

    expect(seated.has(seatRoom(live, 1))).toBe(true)
    expect(seated.has(spectatorRoom(live))).toBe(false)
    expect(watching.has(spectatorRoom(live))).toBe(true)
    expect([...watching].some((room) => room.startsWith(`seat:${live}`))).toBe(false)

    // And the *delivery* matches the membership, which is the claim that will
    // matter from Phase G: a payload sent to the seat room reaches only the
    // seat, and one sent to the spectator room reaches only the spectators.
    a.clear()
    b.clear()

    harness.container.realtime.publish(seatRoom(live, 1), 'table:presence', {
      tableId: live,
      memberId: 'probe-seat',
      seat: 1,
      state: 'online',
      graceEndsAt: null,
    })
    harness.container.realtime.publish(spectatorRoom(live), 'table:presence', {
      tableId: live,
      memberId: 'probe-spectator',
      seat: null,
      state: 'online',
      graceEndsAt: null,
    })
    await settle()

    const idsSeenBy = (client: TestClient) =>
      client.of('table:presence').map((payload) => (payload as { memberId: string }).memberId)

    expect(idsSeenBy(a)).toEqual(['probe-seat'])
    expect(idsSeenBy(b)).toEqual(['probe-spectator'])

    a.close()
    b.close()
  })
})

describe('S24 · guests', () => {
  it('★ a guest joining a table it is not bound to is FORBIDDEN, and audited', async () => {
    const bound = await makeTable(host)
    const other = await makeTable(host)

    const invite = await request(harness.httpServer)
      .post(`/api/v1/tables/${bound}/invites`)
      .set('Cookie', host.cookie)
      .send({})
      .expect(201)

    const guest = await harness.guest((invite.body as { code: string }).code, 'Sara')
    const client = await harness.open(guest)

    const since = new Date(Date.now() - 60_000)
    const before = await harness.container.repos.securityEvents.countSince(
      'SEAT_IMPERSONATION',
      since,
    )

    const ack = await client.emit('table:join', { tableId: other })
    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('FORBIDDEN')
      expect(ack.details).toMatchObject({ reason: 'GUEST_TABLE_BINDING' })
    }

    // The refusal is not enough on its own: a guest reaching for another table
    // is the shape of a privilege-escalation attempt, so it is an ALERT row.
    await expect
      .poll(() => harness.container.repos.securityEvents.countSince('SEAT_IMPERSONATION', since))
      .toBeGreaterThan(before)

    // And the socket never entered the room, even momentarily.
    expect(roomsOf(client.socket.id!).has(tableRoom(other))).toBe(false)

    // Its own table works.
    const own = await client.emit('table:join', { tableId: bound })
    expect(own.ok).toBe(true)

    client.close()
  })

  it('a guest can take a seat and the host sees it', async () => {
    const live = await makeTable(host)
    const invite = await request(harness.httpServer)
      .post(`/api/v1/tables/${live}/invites`)
      .set('Cookie', host.cookie)
      .send({})
      .expect(201)

    const guest = await harness.guest((invite.body as { code: string }).code, 'Nadia')
    const watcher = await harness.open(host)
    const client = await harness.open(guest)

    await watcher.emit('table:join', { tableId: live })
    await client.emit('table:join', { tableId: live })
    watcher.clear()

    const ack = await client.emit('table:takeSeat', { tableId: live, seat: 2 })
    expect(ack.ok).toBe(true)

    const seen = await watcher.next<SeatChangedPayload>('table:seatChanged')
    expect(seen.occupant).toMatchObject({ kind: 'guest', displayName: 'Nadia' })

    watcher.close()
    client.close()
  })
})

describe('S24 · host-only events', () => {
  let live: string
  let hostClient: TestClient
  let guestClient: TestClient

  beforeEach(async () => {
    live = await makeTable(host)
    hostClient = await harness.open(host)
    guestClient = await harness.open(friend)
    await hostClient.emit('table:join', { tableId: live })
    await guestClient.emit('table:join', { tableId: live })
    hostClient.clear()
    guestClient.clear()
  })

  it('★ a non-host is refused every host-only event', async () => {
    for (const [event, payload] of [
      ['table:addBot', { tableId: live, seat: 3, difficulty: 'easy' }],
      ['table:removeBot', { tableId: live, seat: 3 }],
      ['table:kick', { tableId: live, seat: 0 }],
      ['table:updateOptions', { tableId: live, options: { target: 3 } }],
    ] as const) {
      const ack = await guestClient.emit(event, payload)
      expect(ack.ok, `${event} must be host-only`).toBe(false)
      if (!ack.ok) {
        expect(ack.code).toBe('FORBIDDEN')
        expect(ack.details).toMatchObject({ reason: 'HOST_REQUIRED' })
      }
    }

    hostClient.close()
    guestClient.close()
  })

  it('the host seats and removes a bot, and everyone sees both', async () => {
    const added = await hostClient.emit('table:addBot', {
      tableId: live,
      seat: 3,
      difficulty: 'hard',
    })
    expect(added.ok).toBe(true)

    const seated = await guestClient.next<SeatChangedPayload>('table:seatChanged')
    expect(seated.occupant).toMatchObject({ kind: 'bot', botDifficulty: 'hard' })

    guestClient.clear()
    const removed = await hostClient.emit('table:removeBot', { tableId: live, seat: 3 })
    expect(removed.ok).toBe(true)

    const vacated = await guestClient.next<SeatChangedPayload>('table:seatChanged')
    expect(vacated.occupant).toBeNull()

    hostClient.close()
    guestClient.close()
  })

  it('removeBot refuses a seat held by a human — that would be a kick', async () => {
    await guestClient.emit('table:takeSeat', { tableId: live, seat: 2 })

    const ack = await hostClient.emit('table:removeBot', { tableId: live, seat: 2 })
    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('VALIDATION_FAILED')
      expect(ack.fieldErrors?.['seat']).toEqual(['errors.seatNotBot'])
    }

    hostClient.close()
    guestClient.close()
  })

  it('★ a kicked player is told, and leaves the seat room synchronously', async () => {
    await guestClient.emit('table:takeSeat', { tableId: live, seat: 2 })
    await settle()
    expect(roomsOf(guestClient.socket.id!).has(seatRoom(live, 2))).toBe(true)
    guestClient.clear()

    const ack = await hostClient.emit('table:kick', { tableId: live, seat: 2 })
    expect(ack.ok).toBe(true)

    const told = await guestClient.next<{ i18nKey: string }>('error')
    expect(told.i18nKey).toBe('errors.kickedFromTable')

    // The eviction is the part that matters: from Phase G on, staying in that
    // room means still receiving the seat's hand.
    await settle()
    expect(roomsOf(guestClient.socket.id!).has(seatRoom(live, 2))).toBe(false)

    hostClient.close()
    guestClient.close()
  })

  it('the host cannot kick themselves — that is a release', async () => {
    await hostClient.emit('table:takeSeat', { tableId: live, seat: 0 })
    const ack = await hostClient.emit('table:kick', { tableId: live, seat: 0 })

    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.fieldErrors?.['seat']).toEqual(['errors.cannotKickSelf'])

    hostClient.close()
    guestClient.close()
  })

  it('updateOptions broadcasts the parsed options, defaults filled in', async () => {
    const ack = await hostClient.emit('table:updateOptions', {
      tableId: live,
      options: { target: 7 },
    })
    expect(ack.ok).toBe(true)

    const changed = await guestClient.next<{ options: Record<string, unknown> }>(
      'table:optionsChanged',
    )
    // What plays is what is stored — the *parsed* output, so a default that
    // moves later cannot silently change a table created today.
    expect(changed.options).toEqual({ target: 7, strikesResetOnAction: true })

    hostClient.close()
    guestClient.close()
  })

  it('options the engine refuses come back as fieldErrors, not a 500', async () => {
    const ack = await hostClient.emit('table:updateOptions', {
      tableId: live,
      options: { target: 999 },
    })

    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('VALIDATION_FAILED')
      expect(ack.fieldErrors?.['options.target']).toEqual(['errors.field.tooBig'])
    }

    hostClient.close()
    guestClient.close()
  })
})

describe('S24 · acting without joining', () => {
  it('★ every table event refuses a socket that has not joined', async () => {
    const live = await makeTable(host)
    const client = await harness.open(host)

    for (const [event, payload] of [
      ['table:takeSeat', { tableId: live, seat: 1 }],
      ['table:releaseSeat', { tableId: live }],
      ['table:leave', { tableId: live }],
      ['chat:send', { tableId: live, body: 'hello' }],
      ['presence:heartbeat', { tableId: live }],
    ] as const) {
      const ack = await client.emit(event, payload)
      expect(ack.ok, `${event} must require a join`).toBe(false)
      if (!ack.ok) expect(ack.details).toMatchObject({ reason: 'NOT_AT_TABLE' })
    }

    client.close()
  })
})

function hostUserId(): string {
  return (host.body as { identity: { userId: string } }).identity.userId
}
