import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { PRESENCE_AWAY_AFTER_MS } from '../../../src/config/socketLimits.js'
import type { GraceExpired } from '../../../src/application/services/PresenceService.js'
import type { PresencePayload, TableSnapshotPayload } from '../../../src/contracts/events.js'
import { resetDb } from '../../helpers/db.js'
import {
  settle,
  startSocketHarness,
  type Session,
  type SocketHarness,
  type TestClient,
} from '../../helpers/socket.js'

/**
 * S25 — presence, heartbeat and the disconnect grace timer.
 *
 * The product statement: when somebody's phone drops, everyone else sees
 * *"Sara reconnecting… 0:58"* instead of a table that has silently frozen.
 *
 * Time is the one thing faked here (`FakeClock`, injected through
 * `application/ports/clock.ts`) — a suite that sat through a 15-second grace
 * window would be a suite nobody runs. Everything else is a real socket over a
 * real port.
 */

const GRACE_MS = 10_000

let harness: SocketHarness
let host: Session
let friend: Session

async function makeTable(): Promise<string> {
  const response = await request(harness.httpServer)
    .post('/api/v1/tables')
    .set('Cookie', host.cookie)
    .send({ gameSlug: 'fixture', seatCount: 4, options: {} })
    .expect(201)
  return (response.body as { id: string }).id
}

/** Joins and sits down, which is the ordinary order and the one presence follows. */
async function seat(client: TestClient, tableId: string, index: number): Promise<void> {
  await client.emit('table:join', { tableId })
  await client.next('table:snapshot')
  const ack = await client.emit('table:takeSeat', { tableId, seat: index })
  expect(ack.ok).toBe(true)
  await settle()
}

beforeAll(async () => {
  await resetDb()
  harness = await startSocketHarness({ graceMs: GRACE_MS })
  host = await harness.register('Mehrang')
  friend = await harness.register('Reza')
})

afterAll(async () => {
  await harness.close()
})

describe('S25 · disconnect and grace', () => {
  let tableId: string
  let stays: TestClient
  let drops: TestClient

  beforeEach(async () => {
    tableId = await makeTable()
    stays = await harness.open(host)
    drops = await harness.open(friend)
    await seat(stays, tableId, 1)
    await seat(drops, tableId, 2)
    stays.clear()
  })

  it('★ a disconnect broadcasts state:disconnected with a graceEndsAt', async () => {
    drops.close()

    const presence = await stays.next<PresencePayload>('table:presence')
    expect(presence).toMatchObject({ tableId, seat: 2, state: 'disconnected' })

    // ★ Absolute, never a duration. The client renders the countdown from this
    // minus the clock offset it measured at handshake, so a device with a wrong
    // system clock still shows the true deadline — and that deadline can cost
    // somebody their seat (04 §5.4).
    expect(presence.graceEndsAt).not.toBeNull()
    expect(new Date(presence.graceEndsAt!).getTime()).toBe(harness.clock.now() + GRACE_MS)

    // And it is persisted, which is what lets an API restart re-arm the timer
    // from where it actually stood rather than gifting a fresh window.
    const member = await harness.container.repos.tables.findMemberBySeat(tableId, 2 as never)
    expect(member?.disconnectedAt).not.toBeNull()

    stays.close()
  })

  it('★ reconnecting inside grace restores online and resends the snapshot', async () => {
    drops.close()
    await stays.next('table:presence')
    stays.clear()

    // Half the window: still inside it.
    harness.clock.advance(GRACE_MS / 2)

    const back = await harness.open(friend)
    await back.emit('table:join', { tableId })

    // A full snapshot, not a delta — `full` is always correct, and is the
    // fallback whenever anything is ambiguous (04 §5.3).
    const snapshot = await back.next<TableSnapshotPayload>('table:snapshot')
    expect(snapshot.you.seat).toBe(2)

    const presence = await stays.next<PresencePayload>('table:presence')
    expect(presence).toMatchObject({ seat: 2, state: 'online', graceEndsAt: null })

    const member = await harness.container.repos.tables.findMemberBySeat(tableId, 2 as never)
    expect(member?.disconnectedAt).toBeNull()

    // The timer is genuinely cancelled, not merely ignored when it fires.
    harness.clock.advance(GRACE_MS * 2)
    expect(fired.filter((event) => event.tableId === tableId)).toHaveLength(0)

    back.close()
    stays.close()
  })

  const fired: GraceExpired[] = []

  it('★ grace expiry fires the ejection hook exactly once', async () => {
    fired.length = 0
    harness.container.presence.onGraceExpired((event) => {
      fired.push(event)
    })

    drops.close()
    await stays.next('table:presence')

    harness.clock.advance(GRACE_MS - 1)
    expect(fired).toHaveLength(0)

    harness.clock.advance(2)
    await settle()

    const mine = fired.filter((event) => event.tableId === tableId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ seat: 2, gameSlug: 'fixture' })
    expect(mine[0]?.identity.kind).toBe('user')

    // The mechanism ships now; S33 turns it into a bot substitution. Advancing
    // further must not produce a second ejection for one absence.
    harness.clock.advance(GRACE_MS * 3)
    await settle()
    expect(fired.filter((event) => event.tableId === tableId)).toHaveLength(1)

    stays.close()
  })

  it('a hook that throws does not stop the others, or the process', async () => {
    const survived: string[] = []
    harness.container.presence.onGraceExpired(() => {
      throw new Error('deliberate')
    })
    // Scoped to this table: advancing the clock also expires whatever earlier
    // tests in this file left disconnected, and a bare count would measure the
    // suite rather than the claim.
    harness.container.presence.onGraceExpired((event) => {
      if (event.tableId === tableId) survived.push(event.memberId)
    })

    drops.close()
    await stays.next('table:presence')
    harness.clock.advance(GRACE_MS + 1)
    await settle()

    expect(survived).toHaveLength(1)
    stays.close()
  })
})

describe('S25 · multi-tab', () => {
  it('★ closing one of two tabs leaves the seat online', async () => {
    const tableId = await makeTable()
    const watcher = await harness.open(host)
    await seat(watcher, tableId, 0)

    const tabOne = await harness.open(friend)
    const tabTwo = await harness.open(friend)
    await seat(tabOne, tableId, 1)
    // The second tab joins the same seat room — correct, it is the same person,
    // and from Phase G both get the same private projection.
    await tabTwo.emit('table:join', { tableId })
    await tabTwo.next('table:snapshot')
    await settle()
    watcher.clear()

    tabOne.close()
    await settle(150)

    // The most annoying possible bug this prevents: a permanent "reconnecting…"
    // badge on somebody who is sitting there playing in another window.
    const disconnects = watcher
      .of('table:presence')
      .filter((payload) => (payload as PresencePayload).state === 'disconnected')
    expect(disconnects).toHaveLength(0)

    const member = await harness.container.repos.tables.findMemberBySeat(tableId, 1 as never)
    expect(member?.disconnectedAt).toBeNull()

    // Closing the *last* one does start the clock.
    tabTwo.close()
    const presence = await watcher.next<PresencePayload>('table:presence')
    expect(presence).toMatchObject({ seat: 1, state: 'disconnected' })

    watcher.close()
  })
})

describe('S25 · heartbeat and away', () => {
  it('★ missing heartbeats produce away before disconnected', async () => {
    const tableId = await makeTable()
    const watcher = await harness.open(host)
    const quiet = await harness.open(friend)
    await seat(watcher, tableId, 0)
    await seat(quiet, tableId, 1)
    watcher.clear()

    // `away` is the soft middle ground the transport ping cannot see: the TCP
    // connection is answered by the browser's networking stack even when the
    // tab is backgrounded with the screen off.
    harness.clock.advance(PRESENCE_AWAY_AFTER_MS + 20_000)
    await settle()

    const states = watcher.of('table:presence').map((p) => (p as PresencePayload).state)
    expect(states).toContain('away')
    expect(states).not.toContain('disconnected')

    // Nothing is at stake: no grace timer, and the member row is untouched.
    const member = await harness.container.repos.tables.findMemberBySeat(tableId, 1 as never)
    expect(member?.disconnectedAt).toBeNull()

    // A heartbeat brings them straight back.
    watcher.clear()
    const ack = await quiet.emit('presence:heartbeat', { tableId })
    expect(ack.ok).toBe(true)

    const back = await watcher.next<PresencePayload>('table:presence')
    expect(back.state).toBe('online')

    watcher.close()
    quiet.close()
  })

  it('a guest heartbeat slides its session TTL', async () => {
    const tableId = await makeTable()
    const invite = await request(harness.httpServer)
      .post(`/api/v1/tables/${tableId}/invites`)
      .set('Cookie', host.cookie)
      .send({})
      .expect(201)

    const guest = await harness.guest((invite.body as { code: string }).code, 'Sara')
    const client = await harness.open(guest)
    await client.emit('table:join', { tableId })
    await client.next('table:snapshot')

    const guestSessionId = (guest.body as { identity: { guestSessionId: string } }).identity
      .guestSessionId
    const before = await harness.container.repos.guests.findById(guestSessionId)

    await new Promise((resolve) => setTimeout(resolve, 20))
    await client.emit('presence:heartbeat', { tableId })

    // A game night runs longer than twelve hours only if the twelve hours are
    // counted from the last thing you did (07 §5.1).
    await expect
      .poll(async () => {
        const after = await harness.container.repos.guests.findById(guestSessionId)
        return after?.lastSeenAt?.getTime() ?? 0
      })
      .toBeGreaterThan(before?.lastSeenAt?.getTime() ?? 0)

    client.close()
  })
})

describe('S25 · leaving on purpose', () => {
  it('table:leave frees the seat and starts no grace timer', async () => {
    const tableId = await makeTable()
    const watcher = await harness.open(host)
    const leaver = await harness.open(friend)
    await seat(watcher, tableId, 0)
    await seat(leaver, tableId, 1)
    watcher.clear()

    const ack = await leaver.emit('table:leave', { tableId })
    expect(ack.ok).toBe(true)
    await settle()

    // Saying goodbye is not a disconnect. Showing "reconnecting…" for somebody
    // who left would keep three people waiting on a fourth who is gone.
    const states = watcher.of('table:presence').map((p) => (p as PresencePayload).state)
    expect(states).not.toContain('disconnected')

    expect(watcher.of('table:memberLeft')).toHaveLength(1)
    const vacated = watcher.of('table:seatChanged').at(-1) as { occupant: unknown }
    expect(vacated.occupant).toBeNull()

    watcher.close()
    leaver.close()
  })
})
