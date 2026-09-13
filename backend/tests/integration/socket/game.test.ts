import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type {
  GameFinishedPayload,
  GameMoveRejectedPayload,
  GameStartedPayload,
  GameStatePayload,
  GameSyncResult,
} from '../../../src/contracts/events.js'
import type { FixtureView } from '../../../src/domain/games/_fixture/engine.js'
import { commitSeed } from '../../../src/domain/games/shared/rng.js'
import { isTimerEvent } from '../../../src/application/ports/turns.js'
import { resetDb } from '../../helpers/db.js'
import {
  settle,
  startSocketHarness,
  type Session,
  type SocketHarness,
  type TestClient,
} from '../../helpers/socket.js'

/**
 * ★ S30 — the whole move pipeline, end to end over a real socket.
 *
 * The one assertion this file exists for is in
 * *"the two clients' projections differ"*: seat 0's `game:state` contains its
 * own secret and seat 1's does not, from **one** server-side state. That single
 * difference is the entire anti-cheat architecture, visible — and it is the
 * property every game from M1 onward inherits for free.
 *
 * Everything here runs across the transport on purpose. A handler tested in
 * isolation would pass with the rooms wired to the wrong names, with the
 * payload schemas bypassed, and with the seat read from the payload — which is
 * to say it would pass while every property Phase G exists to establish was
 * broken.
 */

let harness: SocketHarness
let host: Session
let friend: Session

async function makeTable(session: Session, options: Record<string, unknown> = {}): Promise<string> {
  const response = await request(harness.httpServer)
    .post('/api/v1/tables')
    .set('Cookie', session.cookie)
    .send({ gameSlug: 'fixture', seatCount: 2, options: { target: 3 }, ...options })
    .expect(201)
  return (response.body as { id: string }).id
}

/** A table with both sessions seated and both clients watching. */
async function seatedTable(options: Record<string, unknown> = {}): Promise<{
  tableId: string
  a: TestClient
  b: TestClient
}> {
  const tableId = await makeTable(host, options)
  const a = await harness.open(host)
  const b = await harness.open(friend)

  await a.emit('table:join', { tableId })
  await b.emit('table:join', { tableId })
  await a.emit('table:takeSeat', { tableId, seat: 0 })
  await b.emit('table:takeSeat', { tableId, seat: 1 })
  await settle()

  a.clear()
  b.clear()
  return { tableId, a, b }
}

beforeAll(async () => {
  await resetDb()
  harness = await startSocketHarness()
  host = await harness.register('Mehrang')
  friend = await harness.register('Sara')
})

beforeEach(() => {
  harness.resetLimits()
})

afterAll(async () => {
  await harness.close()
})

describe('game:start', () => {
  it('★ deals, and publishes the commit to the whole table before any state', async () => {
    const { tableId, a, b } = await seatedTable()

    const ack = await a.emit<{ gameId: string; seedCommit: string }>('game:start', { tableId })
    expect(ack.ok).toBe(true)

    const started = await b.next<GameStartedPayload>('game:started')
    expect(started).toMatchObject({
      tableId,
      gameSlug: 'fixture',
      seedCommit: ack.ok ? ack.data.seedCommit : '',
    })
    expect(started.seating).toHaveLength(2)
    expect(started.seating[0]).toMatchObject({ seat: 0, displayName: 'Mehrang', isBot: false })

    // ★ Ordering, as the *client* observes it — not as the server intended it.
    // A commit that arrives after the cards proves nothing.
    await settle()
    const order = b.received.map((entry) => entry.event)
    expect(order.indexOf('game:started')).toBeLessThan(order.indexOf('game:state'))

    // The commit is 64 hex characters and carries no seed with it.
    expect(started.seedCommit).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(started)).not.toContain('rngSeed')

    a.close()
    b.close()
  })

  it('refuses a caller who is not the host', async () => {
    const { tableId, a, b } = await seatedTable()

    const ack = await b.emit('game:start', { tableId })
    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('FORBIDDEN')
      expect(ack.details).toMatchObject({ reason: 'HOST_REQUIRED' })
    }

    a.close()
    b.close()
  })

  it('refuses a table the socket has not joined', async () => {
    const tableId = await makeTable(host)
    const a = await harness.open(host)

    const ack = await a.emit('game:start', { tableId })
    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.details).toMatchObject({ reason: 'NOT_AT_TABLE' })

    a.close()
  })
})

describe('★ the projection boundary, as two clients actually see it', () => {
  it('seat 0 receives its own secret; seat 1 receives a different payload without it', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })

    const stateA = await a.next<GameStatePayload>('game:state')
    const stateB = await b.next<GameStatePayload>('game:state')

    const viewA = stateA.view as FixtureView
    const viewB = stateB.view as FixtureView

    expect(typeof viewA.secret).toBe('number')
    expect(typeof viewB.secret).toBe('number')
    expect(viewA.secret).not.toBe(viewB.secret)

    /**
     * ★ The assertion the whole architecture is for, in the strongest form
     * available: a *substring search* over the serialized payload. Seat 1's
     * secret must not appear anywhere in what seat 0 received — not in a nested
     * field, not in a debug key, not by accident.
     */
    expect(JSON.stringify(stateA)).not.toContain(String(viewB.secret))
    expect(JSON.stringify(stateB)).not.toContain(String(viewA.secret))

    // And the two payloads are genuinely different objects, which is what
    // proves projection ran per viewer rather than once per broadcast.
    expect(JSON.stringify(stateA.view)).not.toBe(JSON.stringify(stateB.view))

    a.close()
    b.close()
  })

  it('★ legalMoves reaches only the seat that is to act', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })

    const stateA = await a.next<GameStatePayload>('game:state')
    const stateB = await b.next<GameStatePayload>('game:state')

    expect(stateA.toAct).toBe(0)
    expect(stateA.legalMoves).toEqual([{ kind: 'press' }, { kind: 'pass' }])
    // Harmless here and a hand leak in Poker, where "can you raise?" answers
    // "how much is in front of you?". Consistency costs nothing.
    expect(stateB.legalMoves).toBeNull()

    a.close()
    b.close()
  })

  it('a spectator sees the public game and no secret at all', async () => {
    const watcher = await harness.register('Watcher')
    const { tableId, a, b } = await seatedTable()

    const c = await harness.open(watcher)
    await c.emit('table:join', { tableId, asSpectator: true })
    c.clear()

    await a.emit('game:start', { tableId })
    const spectated = await c.next<GameStatePayload>('game:state')

    expect((spectated.view as FixtureView).secret).toBeNull()
    expect((spectated.view as FixtureView).toAct).toBe(0)

    a.close()
    b.close()
    c.close()
  })
})

describe('game:move', () => {
  it('★ applies, narrates to the table, and re-projects to every viewer', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })
    await settle()
    a.clear()
    b.clear()

    const ack = await a.emit<{ seq: number; replayed: boolean }>('game:move', {
      gameId: (await gameIdOf(tableId)) ?? '',
      move: { kind: 'press' },
      clientMoveId: 'm1',
    })

    expect(ack.ok).toBe(true)
    // Seq 2: the deal armed seat 0's deadline at seq 1 (Phase H, 04 §6.1).
    if (ack.ok) expect(ack.data).toMatchObject({ seq: 2, replayed: false })

    // Public narration goes to the table room, as an i18n key and never prose.
    const narration = await b.next<{ seq: number; descriptor: { key: string } }>('game:event')
    expect(narration.seq).toBe(2)
    expect(narration.descriptor.key).toBe('games.fixture.move.press')
    expect(narration.descriptor.key).not.toMatch(/\s/)

    // And both seats get a fresh, individually projected state.
    const stateA = await a.next<GameStatePayload>('game:state')
    const stateB = await b.next<GameStatePayload>('game:state')
    expect(stateA.seq).toBe(2)
    expect(stateA.toAct).toBe(1)
    expect((stateB.view as FixtureView).counts).toEqual({ '0': 1, '1': 0 })

    a.close()
    b.close()
  })

  it('★ moving out of turn is refused — in the ack and on the socket', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })
    await settle()
    b.clear()

    const gameId = (await gameIdOf(tableId)) ?? ''
    const ack = await b.emit('game:move', {
      gameId,
      move: { kind: 'press' },
      clientMoveId: 'early',
    })

    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.code).toBe('NOT_YOUR_TURN')

    const rejected = await b.next<GameMoveRejectedPayload>('game:moveRejected')
    expect(rejected).toMatchObject({ gameId, clientMoveId: 'early', code: 'NOT_YOUR_TURN' })
    // An i18n key, not a rendered sentence — the same contract as REST.
    expect(rejected.i18nKey).toBe('errors.notYourTurn')

    a.close()
    b.close()
  })

  it('an illegal move is ILLEGAL_MOVE and changes nothing', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })
    await settle()

    const gameId = (await gameIdOf(tableId)) ?? ''
    const ack = await a.emit('game:move', {
      gameId,
      move: { kind: 'detonate' },
      clientMoveId: 'bad',
    })

    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.code).toBe('ILLEGAL_MOVE')

    a.clear()
    await a.emit('game:move', { gameId, move: { kind: 'press' }, clientMoveId: 'good' })
    const state = await a.next<GameStatePayload>('game:state')

    /**
     * ★ The press is event **2**, and that is the design rather than a
     * concession: the rejection is an `AUDIT` row in the *same ordered stream*
     * (03 §4.2), so "what did this player try, and when" reads off one log in
     * one order. It cost a seq; it did not cost a turn.
     */
    expect(state.seq).toBe(3)
    expect((state.view as FixtureView).counts).toEqual({ '0': 1, '1': 0 })

    // Deadlines filtered out: this assertion is about what a *refused* move
    // leaves in the stream, and it still sits before the move that followed it.
    const rows = (await harness.container.repos.events.listByGame(gameId)).filter(
      (row) => !isTimerEvent(row.payload),
    )
    expect(rows.map((row) => row.kind)).toEqual(['AUDIT', 'MOVE'])

    a.close()
    b.close()
  })

  it('★ a payload that names a seat is REJECTED, not merely ignored', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })
    await settle()

    const gameId = (await gameIdOf(tableId)) ?? ''

    /**
     * There is no `seat` field on `game:move`, and every inbound schema is
     * `.strict()` — so the attempt does not reach a handler that has to
     * remember to ignore it. The defence is a property of the schema.
     */
    const ack = await b.emit('game:move', {
      gameId,
      move: { kind: 'press' },
      clientMoveId: 'spoof',
      seat: 0,
    })

    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('VALIDATION_FAILED')
      expect(ack.fieldErrors).toMatchObject({ seat: ['errors.field.unknownKey'] })
    }

    a.close()
    b.close()
  })

  it('★ a move claiming another seat inside the move body still plays from the socket’s seat', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })
    await settle()
    a.clear()

    const gameId = (await gameIdOf(tableId)) ?? ''

    // `move` is opaque to the transport, so this *is* accepted as a payload —
    // and the seat inside it is simply data the engine does not read. The
    // acting seat came from the socket, so this is seat 0 pressing.
    const ack = await a.emit<{ seq: number }>('game:move', {
      gameId,
      move: { kind: 'press', seat: 1 },
      clientMoveId: 'sneaky',
    })

    expect(ack.ok).toBe(true)
    const state = await a.next<GameStatePayload>('game:state')
    expect((state.view as FixtureView).counts).toEqual({ '0': 1, '1': 0 })

    a.close()
    b.close()
  })

  it('a retried clientMoveId answers from the log', async () => {
    const { tableId, a, b } = await seatedTable()
    await a.emit('game:start', { tableId })
    await settle()

    const gameId = (await gameIdOf(tableId)) ?? ''
    const payload = { gameId, move: { kind: 'press' }, clientMoveId: 'once' }

    const first = await a.emit<{ replayed: boolean; seq: number }>('game:move', payload)
    const second = await a.emit<{ replayed: boolean; seq: number }>('game:move', payload)

    expect(first.ok && first.data.replayed).toBe(false)
    expect(second.ok && second.data.replayed).toBe(true)
    expect(first.ok && second.ok && first.data.seq === second.data.seq).toBe(true)

    a.close()
    b.close()
  })
})

describe('finishing', () => {
  it('★ reveals the seed, and the commit verifies against it', async () => {
    const { tableId, a, b } = await seatedTable({ options: { target: 1 } })
    const start = await a.emit<{ gameId: string; seedCommit: string }>('game:start', { tableId })
    await settle()

    const gameId = start.ok ? start.data.gameId : ''
    await a.emit('game:move', { gameId, move: { kind: 'press' }, clientMoveId: 'win' })

    const finished = await b.next<GameFinishedPayload>('game:finished')
    expect(finished.reason).toBe('NORMAL')
    expect(finished.standings[0]).toMatchObject({ seat: 0, rank: 1, outcome: 'COMPLETED' })

    // ★ What a client actually does with the two values it was given: the
    // commit it stored before the deal, checked against the seed it has now.
    expect(commitSeed(finished.seedRevealed, gameId)).toBe(finished.seedCommit)
    expect(finished.seedCommit).toBe(start.ok ? start.data.seedCommit : 'x')

    a.close()
    b.close()
  })
})

describe('game:requestSync over the socket', () => {
  it('delta replays the missed events and ends with one state', async () => {
    const { tableId, a, b } = await seatedTable({ options: { target: 50 } })
    const start = await a.emit<{ gameId: string }>('game:start', { tableId })
    const gameId = start.ok ? start.data.gameId : ''

    await a.emit('game:move', { gameId, move: { kind: 'press' }, clientMoveId: 's1' })
    await b.emit('game:move', { gameId, move: { kind: 'press' }, clientMoveId: 's2' })
    await settle()
    b.clear()

    // Two presses → five rows: the deal's deadline, then a move and a deadline
    // each. Catching up from seq 1 replays 2..5.
    const ack = await b.emit<GameSyncResult>('game:requestSync', { gameId, lastSeq: 1 })
    expect(ack.ok && ack.data).toMatchObject({ mode: 'delta', fromSeq: 2, toSeq: 5 })

    await settle()
    // ★ Two narrated events, not four: the deadlines are skipped, or a
    // reconnecting client's move log would carry one phase change per turn.
    expect(b.of('game:event')).toHaveLength(2)
    expect(b.of('game:state')).toHaveLength(1)

    a.close()
    b.close()
  })

  it('★ full works with no lastSeq at all, which is the always-correct fallback', async () => {
    const { tableId, a, b } = await seatedTable({ options: { target: 50 } })
    const start = await a.emit<{ gameId: string }>('game:start', { tableId })
    const gameId = start.ok ? start.data.gameId : ''

    await a.emit('game:move', { gameId, move: { kind: 'press' }, clientMoveId: 'f1' })
    await settle()
    b.clear()

    const ack = await b.emit<GameSyncResult>('game:requestSync', { gameId })
    expect(ack.ok && ack.data.mode).toBe('full')

    await settle()
    expect(b.of('game:started')).toHaveLength(1)
    const state = b.of('game:state')[0] as GameStatePayload
    // Still seat 1's own projection — a resync is not a reason to hand out a
    // different viewer's view.
    expect(typeof (state.view as FixtureView).secret).toBe('number')

    a.close()
    b.close()
  })
})

/** The active game at a table, read the way a test may but a client may not. */
async function gameIdOf(tableId: string): Promise<string | null> {
  const instance = await harness.container.repos.games.findActiveByTable(tableId)
  return instance?.id ?? null
}
