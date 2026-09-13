import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type {
  GameEjectionWarningPayload,
  GamePlayerEjectedPayload,
  GameReclaimResult,
  GameTurnTimerPayload,
} from '../../../src/contracts/events.js'
import { resetDb } from '../../helpers/db.js'
import {
  settle,
  startSocketHarness,
  type Session,
  type SocketHarness,
  type TestClient,
} from '../../helpers/socket.js'

/**
 * ★ Phase H over a real socket — S31–S34.
 *
 * The service tests prove the rules; this file proves the **wiring**, which is
 * where the privacy lives. Two assertions carry it:
 *
 *   - seat 1's client receives `game:turnTimer` for seat 0 (everyone watches
 *     the same clock — 04 §6.1), and
 *   - seat 1's client receives **nothing at all** when seat 0 is warned (04
 *     §6.2 — the warning is a private nudge).
 *
 * A handler tested in isolation would pass with both events addressed to the
 * wrong room, which is to say it would pass with the distinction erased.
 */

let harness: SocketHarness
let host: Session
let friend: Session

async function seatedGame(options: Record<string, unknown> = {}): Promise<{
  tableId: string
  gameId: string
  a: TestClient
  b: TestClient
}> {
  const response = await request(harness.httpServer)
    .post('/api/v1/tables')
    .set('Cookie', host.cookie)
    .send({ gameSlug: 'fixture', seatCount: 2, options: { target: 10 }, ...options })
    .expect(201)
  const tableId = (response.body as { id: string }).id

  const a = await harness.open(host)
  const b = await harness.open(friend)
  await a.emit('table:join', { tableId })
  await b.emit('table:join', { tableId })
  await a.emit('table:takeSeat', { tableId, seat: 0 })
  await b.emit('table:takeSeat', { tableId, seat: 1 })
  await settle()

  a.clear()
  b.clear()

  const started = await a.emit<{ gameId: string }>('game:start', { tableId })
  if (!started.ok) throw new Error(`game:start refused: ${started.code}`)
  await settle()
  return { tableId, gameId: started.data.gameId, a, b }
}

beforeAll(async () => {
  harness = await startSocketHarness()
  host = await harness.register('Mehrang')
  friend = await harness.register('Sara')
})

beforeEach(async () => {
  await resetDb()
  harness.resetLimits()
  harness.container.turnTimers.stop()
  harness.container.seats.stop()
  host = await harness.register('Mehrang')
  friend = await harness.register('Sara')
})

afterAll(async () => {
  await harness.close()
})

describe('game:turnTimer over the wire', () => {
  it('★ both clients see the deadline, and it is an absolute instant', async () => {
    const { a, b } = await seatedGame()

    const forSeatZero = a.next<GameTurnTimerPayload>('game:turnTimer')
    const alsoAtTheTable = b.next<GameTurnTimerPayload>('game:turnTimer')

    const mine = await forSeatZero
    const theirs = await alsoAtTheTable

    expect(mine.seat).toBe(0)
    // ★ Byte-identical: this is public information, and the other player
    // watching your clock run down is most of what makes a turn limit feel
    // fair rather than arbitrary.
    expect(theirs).toEqual(mine)
    expect(new Date(mine.endsAt).getTime()).toBe(mine.serverTime + 30_000)
    expect(mine.ejectAfterStrikes).toBe(2)
  })
})

describe('game:ejectionWarning over the wire', () => {
  it('★★ reaches the acting seat and NOBODY else', async () => {
    const { a, b } = await seatedGame()
    await a.next('game:turnTimer')
    b.clear()

    harness.clock.advance(20_000)
    const warning = await a.next<GameEjectionWarningPayload>('game:ejectionWarning')
    await settle()

    expect(warning).toMatchObject({
      seat: 0,
      secondsRemaining: 10,
      consequence: 'EJECTION_NO_REWARD',
    })
    // ★ The assertion the manual walk makes with a second terminal: seat 1's
    // transcript holds no warning at all. Broadcasting this would shame
    // somebody in front of the table *and* tell the other player exactly when
    // to expect a free trick.
    expect(b.received.filter((entry) => entry.event === 'game:ejectionWarning')).toHaveLength(0)
  })
})

describe('ejection and reclamation over the wire', () => {
  it('★ one lapse ejects on a strict table, and the whole table is told', async () => {
    const { a, b, gameId } = await seatedGame({ turnEnforcement: { ejectAfterStrikes: 1 } })
    await a.next('game:turnTimer')

    harness.clock.advance(30_000)
    const ejected = await b.next<GamePlayerEjectedPayload>('game:playerEjected')

    expect(ejected).toMatchObject({
      gameId,
      seat: 0,
      reason: 'TURN_TIMEOUT',
      replacedByBot: true,
    })
    expect(ejected.reclaimableUntil).not.toBeNull()

    // ★ And the consequence went to the ejected seat only.
    const preview = await a.next('game:rewardPreview')
    expect(preview).toMatchObject({ seat: 0, estimatedCoins: 0, integrityFactor: 0 })
    expect(b.received.filter((entry) => entry.event === 'game:rewardPreview')).toHaveLength(0)
  })

  it('★ game:reclaimSeat takes the seat back, and the table is told', async () => {
    const { a, b, gameId } = await seatedGame({ turnEnforcement: { ejectAfterStrikes: 1 } })
    await a.next('game:turnTimer')

    harness.clock.advance(30_000)
    await a.next('game:playerEjected')

    const ack = await a.emit<GameReclaimResult>('game:reclaimSeat', { gameId })
    expect(ack.ok).toBe(true)
    if (ack.ok) {
      expect(ack.data).toMatchObject({ seat: 0, applied: true, pendingUntilBoundary: false })
    }

    const returned = await b.next('game:playerReturned')
    expect(returned).toMatchObject({ seat: 0, outcome: 'REPLACED_RETURNED', rewardFactor: 0.5 })
  })

  it('★ reclaiming after the window is refused with SEAT_NOT_RECLAIMABLE', async () => {
    const { a, gameId } = await seatedGame({ turnEnforcement: { ejectAfterStrikes: 1 } })
    await a.next('game:turnTimer')

    harness.clock.advance(30_000)
    await a.next('game:playerEjected')

    harness.clock.advance(121_000)
    const ack = await a.emit('game:reclaimSeat', { gameId })
    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('SEAT_NOT_RECLAIMABLE')
      expect(ack.details).toMatchObject({ reason: 'WINDOW_EXPIRED' })
    }
  })

  it('★ a reclaim payload naming a seat is REJECTED, not merely ignored', async () => {
    // The same rule as `game:move`: there is no field with which to take
    // somebody else's seat back from a bot, and `.strict()` refuses the attempt
    // rather than quietly dropping it.
    const { a, gameId } = await seatedGame()

    const ack = await a.emit('game:reclaimSeat', { gameId, seat: 1 })
    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('VALIDATION_FAILED')
      expect(ack.fieldErrors).toMatchObject({ seat: ['errors.field.unknownKey'] })
    }
  })
})
