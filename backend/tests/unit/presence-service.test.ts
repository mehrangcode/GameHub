import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { PRESENCE_AWAY_AFTER_MS } from '../../src/config/socketLimits.js'
import { MetricsRegistry } from '../../src/application/services/MetricsRegistry.js'
import {
  PresenceService,
  type GraceExpired,
} from '../../src/application/services/PresenceService.js'
import { tableRoom } from '../../src/application/ports/realtime.js'
import { buildGameRegistry } from '../../src/domain/games/registry.js'
import type { TableMember } from '../../src/domain/entities/table.js'
import type { Repositories } from '../../src/domain/repositories/Repositories.js'
import { userRef } from '../../src/domain/value-objects/identity.js'
import { FakeClock } from '../fakes/clock.js'
import { RecordingPublisher } from '../fakes/realtime.js'
import { buildInMemoryRepositories } from '../fakes/index.js'

/**
 * S25 — the presence service on its own, with no transport and no database.
 *
 * The integration suite proves the *wiring*; this proves the **arithmetic**, and
 * it is where the awkward cases live: two tabs, a reconnect one millisecond
 * inside the window, a grace timer that must fire exactly once however many
 * times the clock is wound forward. Those are all cheap here and expensive over
 * a socket.
 *
 * This is what the `IRealtimePublisher` port and the `Clock` port are *for*.
 */

const silent = pino({ level: 'silent' })
const GRACE_MS = 5_000

interface Rig {
  service: PresenceService
  clock: FakeClock
  realtime: RecordingPublisher
  repos: Repositories
  expired: GraceExpired[]
  member: TableMember
}

async function rig(): Promise<Rig> {
  const clock = new FakeClock()
  const realtime = new RecordingPublisher()
  const repos = buildInMemoryRepositories()

  const table = await repos.tables.create({
    hostUserId: null,
    gameSlug: 'fixture',
    options: {},
    seatCount: 4,
  })
  const member = await repos.tables.claimSeat(table.id, 1 as never, userRef('u1'), null)
  if (member === null) throw new Error('fixture seat claim failed')

  const service = new PresenceService({
    repos,
    registry: buildGameRegistry({ includeDevGames: true }),
    realtime,
    metrics: new MetricsRegistry(),
    logger: silent,
    clock,
    graceMsOverride: GRACE_MS,
  })

  const expired: GraceExpired[] = []
  service.onGraceExpired((event) => {
    expired.push(event)
  })

  return { service, clock, realtime, repos, expired, member: { ...member, tableId: table.id } }
}

let r: Rig

beforeEach(async () => {
  r = await rig()
})

const states = () =>
  r.realtime.of('table:presence').map((entry) => (entry.payload as { state: string }).state)

describe('S25 · the grace timer', () => {
  it('★ arming records an absolute deadline and firing is exactly once', async () => {
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    r.realtime.clear()

    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')

    const announced = r.realtime.last('table:presence')?.payload as {
      state: string
      graceEndsAt: string
    }
    expect(announced.state).toBe('disconnected')
    expect(new Date(announced.graceEndsAt).getTime()).toBe(r.clock.now() + GRACE_MS)

    // The deadline is absolute so that a restart re-arms it from where it stood
    // rather than gifting the absent player a fresh window (04 §5.4).
    r.clock.advance(GRACE_MS - 1)
    expect(r.expired).toHaveLength(0)

    r.clock.advance(1)
    await settle()
    expect(r.expired).toHaveLength(1)

    // However far the clock is wound on, one absence is one ejection.
    r.clock.advance(GRACE_MS * 10)
    await settle()
    expect(r.expired).toHaveLength(1)
  })

  it('★ reconnecting cancels the timer, not merely its effect', async () => {
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')

    expect(r.clock.armed).toBeGreaterThan(0)
    const armedWhileAway = r.clock.armed

    r.clock.advance(GRACE_MS - 1)
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-b')

    // Cancelled, not left to fire and be ignored. A timer that survives is a
    // timer that fires against a rebuilt state later.
    expect(r.clock.armed).toBeLessThan(armedWhileAway)

    r.clock.advance(GRACE_MS * 5)
    await settle()
    expect(r.expired).toHaveLength(0)
    expect(states().at(-1)).toBe('online')
  })

  it('the member row is stamped and cleared, because the row survives a restart', async () => {
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')

    const away = await r.repos.tables.findMemberByIdentity(TABLE_ID(), userRef('u1'))
    expect(away?.disconnectedAt).not.toBeNull()

    await r.service.attach(TABLE_ID(), userRef('u1'), away!, 'sock-b')
    const back = await r.repos.tables.findMemberByIdentity(TABLE_ID(), userRef('u1'))
    expect(back?.disconnectedAt).toBeNull()
  })

  it('a member who has left the table starts no timer at all', async () => {
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    await r.repos.tables.updateMember(r.member.id, { leftAt: new Date() })

    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')
    r.clock.advance(GRACE_MS * 5)
    await settle()

    expect(r.expired).toHaveLength(0)
  })
})

describe('S25 · multi-tab', () => {
  it('★ the clock starts only when the last socket goes', async () => {
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-b')
    r.realtime.clear()

    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')
    expect(states()).not.toContain('disconnected')

    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-b')
    expect(states()).toContain('disconnected')
  })

  it('a second tab is not announced as an arrival', async () => {
    const first = await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    const second = await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-b')

    expect(first.firstSocket).toBe(true)
    // Otherwise a lobby fills with "Sara joined" from somebody who never left.
    expect(second.firstSocket).toBe(false)
  })

  it('reconnecting on a second tab still counts as a reconnection', async () => {
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')

    const back = await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-b')
    expect(back.reconnected).toBe(true)
  })
})

describe('S25 · away', () => {
  it('goes away on silence and comes straight back on a heartbeat', async () => {
    r.service.start()
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    r.realtime.clear()

    r.clock.advance(PRESENCE_AWAY_AFTER_MS + 10_000)
    expect(states()).toContain('away')

    r.realtime.clear()
    r.service.touch(TABLE_ID(), userRef('u1'))
    expect(states()).toEqual(['online'])

    r.service.stop()
  })

  it('a disconnected member is never downgraded to away', async () => {
    r.service.start()
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')
    r.realtime.clear()

    // `away` is a softer state than `disconnected`; a sweeper that overwrote one
    // with the other would silently cancel the countdown other players can see.
    r.clock.advance(PRESENCE_AWAY_AFTER_MS + 10_000)
    expect(states()).not.toContain('away')

    r.service.stop()
  })
})

describe('S25 · reads', () => {
  it('every announcement goes to the table room, never to a seat', async () => {
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')

    // Presence is public information — everyone at the table needs the badge.
    // The seat room is for private projections only (04 §2).
    for (const entry of r.realtime.of('table:presence')) {
      expect(entry.room).toBe(tableRoom(TABLE_ID()))
    }
  })

  it('an untracked member reads as disconnected, not optimistically online', async () => {
    // Exactly how a seat claimed over REST looks. Reporting it as `online`
    // would put a badge on somebody who has never opened a socket.
    expect(r.service.stateOf(TABLE_ID(), r.member)).toEqual({
      state: 'disconnected',
      graceEndsAt: null,
    })
  })

  it('a bot is always online — it has no transport to lose', async () => {
    const bot: TableMember = { ...r.member, userId: null, isBot: true }
    expect(r.service.stateOf(TABLE_ID(), bot).state).toBe('online')
  })

  it('stop() disarms everything, so a shutdown cannot hang or fire late', async () => {
    r.service.start()
    await r.service.attach(TABLE_ID(), userRef('u1'), r.member, 'sock-a')
    await r.service.detach(TABLE_ID(), userRef('u1'), 'sock-a')

    r.service.stop()
    expect(r.clock.armed).toBe(0)

    r.clock.advance(GRACE_MS * 10)
    await settle()
    expect(r.expired).toHaveLength(0)
  })
})

/** The fake repository mints its own table id; every call needs the same one. */
function TABLE_ID(): string {
  return r.member.tableId
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
