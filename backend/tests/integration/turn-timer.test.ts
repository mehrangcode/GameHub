import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.js'
import { resetDb } from '../helpers/db.js'
import { dealGame, pressTurns, seatMember, waitFor } from '../helpers/game.js'
import { FakeClock } from '../fakes/clock.js'
import { RecordingPublisher } from '../fakes/realtime.js'
import { isTimerEvent } from '../../src/application/ports/turns.js'
import { seatRoom, tableRoom } from '../../src/application/ports/realtime.js'
import type { GameTurnTimerPayload } from '../../src/contracts/events.js'

/**
 * ★ S31 and S32 — the deadline, and what happens when it passes.
 *
 * ### How these tests run a 30-second timeout in a millisecond
 *
 * The clock is injected (`application/ports/clock.ts`), so `clock.advance(...)`
 * fires a deadline without waiting for one. Vitest's own fake timers were
 * rejected for this: they replace the global for Prisma and Socket.IO too, and
 * the failures then read as race conditions rather than as a stubbed clock.
 *
 * The cost of that choice is `waitFor`: a timer callback starts a *detached*
 * chain of real database awaits, so an assertion placed straight after
 * `advance` reads the state from before the strike. Every assertion about a
 * consequence goes through `waitFor`.
 */

const clock = new FakeClock()
const { container } = buildTestApp({ clock })
const published = new RecordingPublisher()
container.realtime.attach(published)

beforeEach(async () => {
  await resetDb()
  published.sent.length = 0
  /**
   * ★ Disarm what earlier tests left running.
   *
   * The container is built once per file, so a deadline armed by the previous
   * test is still in the map — and `clock.advance` fires *every* due timer, not
   * only this test's. Without this, the warning assertion below sees five
   * warnings for four dead games and reads as a broadcast leak.
   */
  container.turnTimers.stop()
  container.seats.stop()
})

afterAll(async () => {
  await container.shutdown()
})

const timerPayloads = (): GameTurnTimerPayload[] =>
  published.of('game:turnTimer').map((entry) => entry.payload as GameTurnTimerPayload)

describe('S31 — arming a deadline', () => {
  it('★ the deal arms seat 0, and the deadline is absolute', async () => {
    const armedAt = clock.now()
    const { game, tableId } = await dealGame(container, { seats: 2 })

    await waitFor(() => container.games !== undefined && timerPayloads().length > 0)
    const timer = timerPayloads().at(-1)!

    expect(timer.seat).toBe(0)
    expect(timer.strikes).toBe(0)
    // `fixtureMeta.turnTimeoutMs` is 30 s. Asserted as an instant, not a
    // duration: a duration is what a client with a wrong clock renders wrongly.
    expect(new Date(timer.endsAt).getTime()).toBe(armedAt + 30_000)
    expect(timer.serverTime).toBe(armedAt)
    expect(timer.gameId).toBe(game.id)

    // ★ To the whole table: the other three watching the clock tick is most of
    // what makes a turn limit feel fair rather than arbitrary.
    expect(published.of('game:turnTimer').at(-1)!.room).toBe(tableRoom(tableId))
  })

  it('★ the deadline is written to the log as a PHASE event, not only to memory', async () => {
    // This is what makes S34's restart re-arming possible at all. Redis is a
    // mirror; the event is the record, and it is the only one that exists on a
    // laptop with no Redis.
    const { game } = await dealGame(container, { seats: 2 })
    await waitFor(async () =>
      (await container.repos.events.listByGame(game.id)).some((event) =>
        isTimerEvent(event.payload),
      ),
    )

    const events = await container.repos.events.listByGame(game.id)
    const timerEvent = events.find((event) => isTimerEvent(event.payload))!
    const timer = timerEvent.payload['turnTimer'] as { seat: number; endsAt: string }

    expect(timerEvent.kind).toBe('PHASE')
    expect(timer.seat).toBe(0)
    expect(new Date(timer.endsAt).getTime()).toBe(clock.now() + 30_000)
    // ★ And it is not an input event: replaying the log must not apply a
    // deadline as though it were a move.
    expect(timerEvent.payload['move']).toBeUndefined()
  })

  it('★ acting cancels the deadline and the next turn re-arms for the next seat', async () => {
    const game = await dealGame(container, { seats: 2, target: 10 })
    await waitFor(() => timerPayloads().length > 0)

    const before = container.turnTimers.deadlineOf(game.game.id)
    expect(before?.seat).toBe(0)

    clock.advance(5_000)
    await pressTurns(container, game, 1)
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 1)

    const after = container.turnTimers.deadlineOf(game.game.id)!
    expect(after.seat).toBe(1)
    // A fresh 30 s from the moment the turn began — not the remainder of seat
    // 0's window, which would punish seat 1 for somebody else's thinking.
    expect(after.endsAt.getTime()).toBe(clock.now() + 30_000)
  })

  it('★ a finished game arms nothing', async () => {
    const game = await dealGame(container, { seats: 2, target: 1 })
    await pressTurns(container, game, 1)

    await waitFor(() => container.turnTimers.deadlineOf(game.game.id) === null)
    expect(container.turnTimers.deadlineOf(game.game.id)).toBeNull()
  })
})

describe('S32 — the warning', () => {
  it('★ reaches the acting seat’s room ALONE, never the table', async () => {
    // 04 §6.2. Broadcasting this would shame somebody in front of the table and
    // tell the other three exactly when to expect a free trick.
    const { tableId } = await dealGame(container, { seats: 2 })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(20_000)
    await waitFor(() => published.of('game:ejectionWarning').length > 0)

    const warning = published.of('game:ejectionWarning').at(-1)!
    expect(warning.room).toBe(seatRoom(tableId, 0))
    expect(warning.room).not.toBe(tableRoom(tableId))
    expect(warning.payload).toMatchObject({
      seat: 0,
      secondsRemaining: 10,
      consequence: 'EJECTION_NO_REWARD',
    })

    // Nothing about the warning went anywhere else — the assertion a second
    // client makes in the manual walk.
    expect(published.sent.filter((e) => e.event === 'game:ejectionWarning')).toHaveLength(1)
  })

  it('fires at exactly warningSeconds before the deadline, and not before', async () => {
    const { game } = await dealGame(container, { seats: 2 })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(19_999)
    expect(published.of('game:ejectionWarning')).toHaveLength(0)

    clock.advance(1)
    await waitFor(() => published.of('game:ejectionWarning').length === 1)
    expect(game.id).toBeTruthy()
  })

  it('warningSeconds: 0 disables it — the strike simply arrives', async () => {
    const game = await dealGame(container, {
      seats: 2,
      target: 10,
      turnEnforcement: { warningSeconds: 0 },
    })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(30_000)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).timeoutStrikes === 1)

    expect(published.of('game:ejectionWarning')).toHaveLength(0)
  })
})

describe('S32 — the strike ladder', () => {
  it('★ expiry strikes the seat, applies the safest default action, and play moves on', async () => {
    const game = await dealGame(container, { seats: 2, target: 10 })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(30_000)
    // ★ Waits for the *turn* to move rather than for the strike to be written.
    // The strike lands one await before the default action does, so waiting on
    // the count alone races the very event this test goes on to read.
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 1)

    const events = await container.repos.events.listByGame(game.game.id)
    const timeout = events.find((event) => event.kind === 'TIMEOUT')!

    // ★ `pass`, never `press`: 04 §6.5's rule is that a default action never
    // spends a resource the player did not authorise, and a press is the only
    // move in this game that can win it.
    expect(timeout.payload['move']).toEqual({ kind: 'pass' })
    expect(timeout.payload['strikes']).toBe(1)
    expect(timeout.seat).toBe(0)
    // It carries a server-generated idempotency key, so two expiries racing for
    // one deadline cannot play the seat twice.
    expect(timeout.clientMoveId).toMatch(/^timeout:/)

    // The table kept playing: seat 1 is now on the clock.
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 1)
    expect(await seatMember(container, game.tableId, 0)).toMatchObject({ ejectedAt: null })
  })

  it('★ the timeout is narrated as TURN_TIMEOUT with the strike count', async () => {
    const game = await dealGame(container, { seats: 2, target: 10 })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(30_000)
    await waitFor(() =>
      published
        .of('game:event')
        .some((entry) => (entry.payload as { kind: string }).kind === 'TURN_TIMEOUT'),
    )

    const narration = published
      .of('game:event')
      .map((entry) => entry.payload as { kind: string; seat: number | null; strikes?: number })
      .find((payload) => payload.kind === 'TURN_TIMEOUT')!

    // Stored as TIMEOUT (03 §4's six kinds), narrated as TURN_TIMEOUT (04 §6.2).
    expect(narration).toMatchObject({ seat: 0, strikes: 1 })
    expect(game.tableId).toBeTruthy()
  })

  it('★ strikesResetOnAction: true — a real move clears the count', async () => {
    // The property: strikes measure *current* absence, not a lifetime record.
    // One lapse now and one twenty minutes later must not combine into an
    // ejection in a 45-minute match.
    const game = await dealGame(container, { seats: 2, target: 20 })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(30_000) // seat 0 lapses → strike 1, passes, seat 1 to act
    // ★ Waits for the *turn* to move, not merely for the strike to be written.
    // The strike lands one await before the default action does, so a test that
    // waited on the count alone would race the pass it triggers.
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 1)

    await pressTurns(container, game, 1, 1) // seat 1 plays
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 0)
    await pressTurns(container, game, 1, 0) // ★ seat 0 plays normally

    await waitFor(async () => (await seatMember(container, game.tableId, 0)).timeoutStrikes === 0)
    expect((await seatMember(container, game.tableId, 0)).timeoutStrikes).toBe(0)
  })

  it('★ strikesResetOnAction: false — strikes accumulate across the match', async () => {
    const game = await dealGame(container, {
      seats: 2,
      target: 20,
      turnEnforcement: { strikesResetOnAction: false, ejectAfterStrikes: 5 },
    })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(30_000)
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 1)

    await pressTurns(container, game, 1, 1)
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 0)
    await pressTurns(container, game, 1, 0)

    // The move did not clear it, because this table asked for a lifetime count.
    expect((await seatMember(container, game.tableId, 0)).timeoutStrikes).toBe(1)
  })

  it('★ ejectAfterStrikes: 1 — one lapse is enough, which is the literal rule', async () => {
    const game = await dealGame(container, {
      seats: 2,
      target: 20,
      turnEnforcement: { ejectAfterStrikes: 1 },
    })
    await waitFor(() => timerPayloads().length > 0)

    clock.advance(30_000)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).ejectedAt !== null)

    const member = await seatMember(container, game.tableId, 0)
    expect(member.ejectionReason).toBe('TURN_TIMEOUT')
    expect(member.botSubstituted).toBe(true)
    // No default action was applied on the way out: an ejection is not a strike
    // with an extra step, and the seat did not get to play a pass.
    const events = await container.repos.events.listByGame(game.game.id)
    expect(events.filter((event) => event.kind === 'TIMEOUT')).toHaveLength(0)
  })

  it('the deadline carries the limit it is counting towards', async () => {
    await dealGame(container, { seats: 2, turnEnforcement: { ejectAfterStrikes: 1 } })
    await waitFor(() => timerPayloads().length > 0)

    expect(timerPayloads().at(-1)!.ejectAfterStrikes).toBe(1)
  })
})
