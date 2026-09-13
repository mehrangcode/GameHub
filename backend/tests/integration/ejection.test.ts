import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import { dealGame, pressTurns, seatMember, waitFor } from '../helpers/game.js'
import { FakeClock } from '../fakes/clock.js'
import { RecordingPublisher } from '../fakes/realtime.js'
import { seatRoom, tableRoom } from '../../src/application/ports/realtime.js'
import { seatOutcomeOf } from '../../src/application/mappers/outcomes.js'
import { BOT_MOVE_DELAY_MS } from '../../src/application/services/SeatEnforcementService.js'
import type { GamePlayerEjectedPayload } from '../../src/contracts/events.js'
import { seatId } from '../../src/domain/value-objects/seat.js'
import type { IdentityRef } from '../../src/domain/value-objects/identity.js'

/**
 * ★ S33 and S34 — the M0 exit criterion, and the way back from it.
 *
 * > *An idle player is warned, struck twice, ejected, and replaced by a bot —
 * > and the table plays on.*
 *
 * The first test in this file is that sentence, end to end: nobody touches seat
 * 0 again after the deal, and the match still reaches a terminal state with a
 * winner. Everything after it is the fairness around that: the reason is
 * recorded truthfully, the consequence is explained, coming back inside the
 * window works and outside it does not, and a restart gifts nobody time.
 */

const clock = new FakeClock()
const { container } = buildTestApp({ clock })
const published = new RecordingPublisher()
container.realtime.attach(published)

beforeEach(async () => {
  await resetDb()
  published.sent.length = 0
  container.turnTimers.stop()
  container.seats.stop()
})

afterAll(async () => {
  await container.shutdown()
})

/**
 * Lets the current deadline expire, and waits for whatever it caused.
 *
 * ★ It lapses **whoever is on the clock**, which in a two-seat game is not the
 * same seat twice running: seat 0's default action is a `pass`, so the turn
 * moves to seat 1. Ejecting one player over two strikes therefore needs the
 * other player to actually play in between — which is exactly the scenario the
 * strike ladder is designed for, and is what the headline test below walks.
 */
async function lapse(gameId: string, times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    const before = container.turnTimers.deadlineOf(gameId)
    if (before === null) return

    clock.advance(30_000)
    await waitFor(() => container.turnTimers.deadlineOf(gameId) !== before)
  }
}

/**
 * Plays the match out: the remaining human presses on their turn, and the bot's
 * turns are let through by advancing the clock past its thinking delay.
 *
 * ★ The human half matters. "The table plays on" means the *other* player keeps
 * having a game to play — a loop that only released bot moves would prove the
 * bot works and say nothing about whether the match is still playable, which is
 * the half of the M0 criterion that is actually about people.
 */
async function playOut(
  game: { game: { id: string }; identities: readonly IdentityRef[] },
  humanSeat: number,
  maxSteps = 60,
): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    const rebuilt = await container.games.rebuildState(game.game.id)
    if (rebuilt.engine.isTerminal(rebuilt.state)) return

    const toAct = (rebuilt.state as { toAct: number | null }).toAct
    if (toAct === humanSeat) {
      await container.games.applyMove({
        gameId: game.game.id,
        identity: game.identities[humanSeat]!,
        move: { kind: 'press' },
        clientMoveId: `human-${step}`,
      })
      continue
    }

    clock.advance(BOT_MOVE_DELAY_MS)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('S33 — ejection and bot substitution', () => {
  it('★★ two strikes eject seat 0, a bot takes over, and the table plays on to a finish', async () => {
    // THE M0 exit criterion. Seat 0 is never touched again after the deal.
    const game = await dealGame(container, { seats: 2, target: 3 })
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 0)

    // Strike 1: seat 0 does nothing, and the safest default action (`pass`)
    // keeps the table moving rather than stalling it.
    await lapse(game.game.id)
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 1)
    expect((await seatMember(container, game.tableId, 0)).timeoutStrikes).toBe(1)

    // Seat 1 plays normally, and the clock comes back round to seat 0.
    await pressTurns(container, game, 1, 1)
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 0)

    // Strike 2: the limit. This is the ejection.
    await lapse(game.game.id)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).ejectedAt !== null)

    const member = await seatMember(container, game.tableId, 0)
    expect(member.ejectionReason).toBe('TURN_TIMEOUT')
    expect(member.botSubstituted).toBe(true)
    expect(member.timeoutStrikes).toBe(2)
    expect(member.reclaimableUntil).not.toBeNull()

    // ★ And now nobody plays seat 0 but the bot — while seat 1 plays on.
    await playOut(game, 1)

    const finished = await container.games.rebuildState(game.game.id)
    expect(finished.engine.isTerminal(finished.state)).toBe(true)

    const instance = await container.repos.games.findById(game.game.id)
    expect(instance?.status).toBe('FINISHED')
    // The bot's moves are in the log, attributed to nobody — the absent human
    // did not play them.
    const events = await container.repos.events.listByGame(game.game.id)
    const botMoves = events.filter(
      (event) => event.kind === 'MOVE' && event.clientMoveId?.startsWith('bot:') === true,
    )
    expect(botMoves.length).toBeGreaterThan(0)
    expect(botMoves.every((event) => event.actorUserId === null)).toBe(true)
  })

  it('★ the table is told, and the ejected seat alone is told what it costs', async () => {
    const game = await dealGame(container, {
      seats: 2,
      target: 10,
      turnEnforcement: { ejectAfterStrikes: 1 },
    })
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id) !== null)

    await lapse(game.game.id, 1)
    await waitFor(() => published.of('game:playerEjected').length > 0)

    const ejected = published.of('game:playerEjected').at(-1)!
    expect(ejected.room).toBe(tableRoom(game.tableId))
    expect(ejected.payload).toMatchObject({
      seat: 0,
      reason: 'TURN_TIMEOUT',
      replacedByBot: true,
      strikes: 1,
    })
    expect((ejected.payload as GamePlayerEjectedPayload).reclaimableUntil).not.toBeNull()

    // ★ 04 §6.6 — the forfeit is stated at the moment it happens, to that seat
    // alone, never inferred later from a wallet that did not move.
    const preview = published.of('game:rewardPreview')
    expect(preview).toHaveLength(1)
    expect(preview[0]!.room).toBe(seatRoom(game.tableId, 0))
    expect(preview[0]!.payload).toMatchObject({
      seat: 0,
      estimatedCoins: 0,
      integrityFactor: 0,
      reasonKey: 'games.reward.forfeitedTimeout',
    })
  })

  it('★ a disconnect ejects as ABANDON — never conflated with a turn timeout', async () => {
    // 04 §5.2's explicit warning, and 10 §5.1 pays the two differently.
    const game = await dealGame(container, { seats: 2, target: 10 })
    const instance = (await container.repos.games.findById(game.game.id))!

    await container.seats.onGraceExpired({
      tableId: game.tableId,
      memberId: (await seatMember(container, game.tableId, 1)).id,
      seat: 1,
      identity: game.identities[1]!,
      gameSlug: instance.gameSlug,
      disconnectedAt: new Date(clock.now()),
    })

    const member = await seatMember(container, game.tableId, 1)
    expect(member.ejectionReason).toBe('ABANDON')
    expect(seatOutcomeOf(member)).toBe('EJECTED_ABANDON')
    expect(published.of('game:rewardPreview').at(-1)!.payload).toMatchObject({
      reasonKey: 'games.reward.forfeitedAbandon',
    })
  })

  it('★ ejection is idempotent — a second expiry does not double-eject', async () => {
    // Both timers point here and can genuinely both fire: the turn deadline and
    // the disconnect grace. Double-ejecting would reset the reclaim window and
    // hand the player a "second" ejection that makes their own seat final.
    const game = await dealGame(container, {
      seats: 2,
      target: 10,
      turnEnforcement: { ejectAfterStrikes: 1 },
    })
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id) !== null)
    await lapse(game.game.id, 1)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).ejectedAt !== null)

    const first = await seatMember(container, game.tableId, 0)
    const instance = (await container.repos.games.findById(game.game.id))!

    clock.advance(5_000)
    await container.seats.eject(instance, seatId(0), 'ABANDON', 9)

    const second = await seatMember(container, game.tableId, 0)
    expect(second.ejectedAt?.getTime()).toBe(first.ejectedAt?.getTime())
    expect(second.ejectionReason).toBe('TURN_TIMEOUT')
    expect(published.of('game:playerEjected')).toHaveLength(1)
  })

  it('★ the bot never plays an illegal move — 300 seeds', async () => {
    // A bot is *our* code and gets no more trust than a client: it chooses from
    // `legalMoves` and `applyMove` re-checks it anyway. A strategy with a bug
    // must produce a rejected move and a log line, never an illegal card.
    const engine = container.registry.requireEngine('fixture')
    const { gameRng } = await import('../../src/domain/games/shared/rng.js')

    for (let seed = 0; seed < 300; seed += 1) {
      const rng = gameRng(`seed-${seed}`, 1)
      let state: unknown = engine.createInitialState(
        { seats: [seatId(0), seatId(1)], options: { target: 5 } },
        rng,
      )

      for (let turn = 0; turn < 20 && !engine.isTerminal(state); turn += 1) {
        const seat = seatId((state as { toAct: number }).toAct)
        const legal = engine.legalMoves(state, seat)
        if (legal.length === 0) break

        const move = engine.bot!.chooseMove(state, seat, legal, rng)
        expect(legal).toContainEqual(move)
        // The enforcement point, exercised: this throws for anything illegal.
        state = engine.applyMove(state, seat, move, rng).state
        state = engine.advance?.(state, rng)?.state ?? state
      }
    }
  })
})

describe('S34 — taking the seat back', () => {
  async function ejectSeatZero(target = 10) {
    const game = await dealGame(container, {
      seats: 2,
      target,
      turnEnforcement: { ejectAfterStrikes: 1 },
    })
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id) !== null)
    await lapse(game.game.id, 1)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).ejectedAt !== null)
    return game
  }

  it('★ reclaiming inside the window restores human control and pays half', async () => {
    const game = await ejectSeatZero()

    clock.advance(30_000) // well inside the 120 s window
    const outcome = await container.seats.reclaim(game.game.id, game.identities[0]!)

    expect(outcome).toMatchObject({ seat: 0, applied: true, pendingUntilBoundary: false })

    const member = await seatMember(container, game.tableId, 0)
    expect(member.ejectedAt).toBeNull()
    expect(member.botSubstituted).toBe(false)
    expect(member.timeoutStrikes).toBe(0)

    const returned = published.of('game:playerReturned').at(-1)!
    expect(returned.room).toBe(tableRoom(game.tableId))
    // ★ 0.5×, which is the whole incentive: coming back beats staying away and
    // never leaving beats both.
    expect(returned.payload).toMatchObject({ outcome: 'REPLACED_RETURNED', rewardFactor: 0.5 })

    // ★ And the log still remembers, which is what settlement reads — the row
    // was cleared, so `seatOutcomeOf` would otherwise say COMPLETED.
    const events = await container.repos.events.listByGame(game.game.id)
    expect(seatOutcomeOf(member, events)).toBe('REPLACED_RETURNED')
  })

  it('★ reclaiming after the window is refused, and the bot keeps the seat', async () => {
    const game = await ejectSeatZero()

    clock.advance(121_000) // past reclaimWindowSec: 120
    await expect(container.seats.reclaim(game.game.id, game.identities[0]!)).rejects.toMatchObject({
      code: 'SEAT_NOT_RECLAIMABLE',
      details: expect.objectContaining({ reason: 'WINDOW_EXPIRED' }),
    })

    expect((await seatMember(container, game.tableId, 0)).botSubstituted).toBe(true)
  })

  it('★ ejected twice in one match — the seat is final', async () => {
    const game = await ejectSeatZero(20)

    clock.advance(10_000)
    await container.seats.reclaim(game.game.id, game.identities[0]!)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).ejectedAt === null)

    // Lapse again. One strike is enough on this table.
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id) !== null)
    await lapse(game.game.id, 1)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).ejectedAt !== null)

    const member = await seatMember(container, game.tableId, 0)
    expect(member.reclaimableUntil).toBeNull()
    await expect(container.seats.reclaim(game.game.id, game.identities[0]!)).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'SEAT_FINAL' }),
    })
  })

  it('a seat that was never ejected cannot be reclaimed', async () => {
    const game = await dealGame(container, { seats: 2, target: 10 })

    await expect(container.seats.reclaim(game.game.id, game.identities[0]!)).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'NOT_EJECTED' }),
    })
  })
})

describe('S34 — a restart gifts nobody time', () => {
  it('★★ re-arms the IDENTICAL absolute deadline after a fresh container', async () => {
    // The headline of S34. If this ever asserts "roughly 30 seconds" instead of
    // "the same instant", a deploy becomes a way to buy thinking time.
    const game = await dealGame(container, { seats: 2, target: 10 })
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id) !== null)

    const before = container.turnTimers.deadlineOf(game.game.id)!
    clock.advance(10_000) // 20 s left on the clock

    // A second container over the same database — the restart, simulated.
    const restarted = buildTestApp({ clock, prisma: db })
    try {
      const rearmed = await restarted.container.turnTimers.resume()
      expect(rearmed).toBe(1)

      const after = restarted.container.turnTimers.deadlineOf(game.game.id)!
      expect(after.endsAt.getTime()).toBe(before.endsAt.getTime())
      expect(after.seat).toBe(before.seat)
      // 20 s remaining, not a fresh 30.
      expect(after.endsAt.getTime() - clock.now()).toBe(20_000)
    } finally {
      restarted.container.turnTimers.stop()
      restarted.container.seats.stop()
    }
  })

  it('★ a deadline that passed during the downtime fires immediately', async () => {
    const game = await dealGame(container, { seats: 2, target: 10 })
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id) !== null)
    container.turnTimers.stop() // the process "dies" mid-turn

    clock.advance(90_000) // three deadlines' worth of downtime

    const restarted = buildTestApp({ clock, prisma: db })
    restarted.container.realtime.attach(published)
    try {
      await restarted.container.turnTimers.resume()
      // Resuming schedules a zero-delay timer; advancing by nothing fires it.
      clock.advance(0)
      await waitFor(async () => (await seatMember(container, game.tableId, 0)).timeoutStrikes === 1)

      expect((await seatMember(container, game.tableId, 0)).timeoutStrikes).toBe(1)
    } finally {
      restarted.container.turnTimers.stop()
      restarted.container.seats.stop()
    }
  })

  it('★ a game that ended during the downtime is settled on startup', async () => {
    const game = await dealGame(container, { seats: 2, target: 10 })
    await pressTurns(container, game, 2)

    // Force the divergence this guard exists for: terminal state, ACTIVE row.
    // The ordinary path cannot produce it (the finish commits in the move's own
    // transaction) — a restored backup or an older build can.
    const rebuilt = await container.games.rebuildState(game.game.id)
    await container.repos.snapshots.save({
      gameId: game.game.id,
      seq: rebuilt.seq,
      state: { ...(rebuilt.state as Record<string, unknown>), phase: 'FINISHED', toAct: null },
    })

    const settled = await container.games.reconcileActive()
    expect(settled).toBe(1)
    expect((await container.repos.games.findById(game.game.id))?.status).toBe('FINISHED')
    // The seed is published only now, and never earlier.
    expect(published.of('game:finished').at(-1)!.payload).toMatchObject({ gameId: game.game.id })
  })
})
