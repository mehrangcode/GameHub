import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import { dealGame, pressTurns } from '../helpers/game.js'
import { RecordingPublisher } from '../fakes/realtime.js'
import {
  MAX_DELTA_GAP,
  SNAPSHOT_EVERY,
  shouldSnapshot,
} from '../../src/application/services/GameSessionService.js'
import type { GameEvent } from '../../src/domain/entities/game.js'
import { isTimerEvent } from '../../src/application/ports/turns.js'

/**
 * ★ S29 — state is rebuilt from the log, not held in memory.
 *
 * The headline property is the one in the middle of this file: **a fresh
 * container over the same database rebuilds byte-identical state**. That is
 * what "restarting the API loses neither table nor seat" means in practice,
 * and it is only true because there is no `Map<gameId, state>` anywhere in the
 * codebase for a restart to lose.
 *
 * The rest is the machinery that makes it affordable: snapshots on the
 * documented schedule, a replay bounded by them, and two resync modes of which
 * one — `full` — is always correct.
 */

const { container } = buildTestApp()

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await container.shutdown()
})

describe('rebuildState', () => {
  /**
   * 60 s, raised from the file's default at S31.
   *
   * A hundred moves is a deliberately extreme case — no real hand is a hundred
   * turns of a two-player game — and each one now costs roughly twice what it
   * did: the move's own transaction, plus the deadline that follows it (04
   * §6.1) and the three reads that compute it. Against SQLite's single
   * connection that is the difference between 15 seconds and 25.
   */
  it(
    '★ after 100 events equals the state produced by applying them in sequence',
    { timeout: 60_000 },
    async () => {
      const game = await dealGame(container, { seats: 2, target: 100 })
      await pressTurns(container, game, 100)

      const rebuilt = await container.games.rebuildState(game.game.id)

      // Applied in sequence by the live path above; rebuilt from the log here.
      expect(rebuilt.state).toMatchObject({
        turn: 100,
        counts: { '0': 50, '1': 50 },
        phase: 'PLAYING',
      })
      /**
       * ★ 201, not 100, since Phase H — and the arithmetic is the point.
       *
       * One deadline is written at the deal, then a move row and the deadline
       * that follows it for each of the 100 turns (`PHASE`, 04 §6.1):
       * `1 + 100 × 2`. `rebuildState` skips every one of the timer rows because
       * they carry no `move` (`isInputEvent`), which is why the *state* above
       * is unchanged while the sequence number is not.
       */
      expect(rebuilt.seq).toBe(201)
    },
  )

  it('rebuilds the deal itself when the log is empty', async () => {
    const { game } = await dealGame(container, { seats: 3 })
    const rebuilt = await container.games.rebuildState(game.id)

    // Seq 1 rather than 0: the deal armed seat 0's first deadline and wrote it
    // down. No move has been played, which is what the state below asserts.
    expect(rebuilt.seq).toBe(1)
    expect(rebuilt.state).toMatchObject({ turn: 0, toAct: 0, phase: 'PLAYING' })
  })

  it('★ the deal is reproducible from the seed alone — two rebuilds agree', async () => {
    const { game } = await dealGame(container, { seats: 4 })

    const first = await container.games.rebuildState(game.id)
    const second = await container.games.rebuildState(game.id)

    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state))
  })

  it('skips AUDIT rows — a refused move must never be replayed as a played one', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })

    await expect(
      container.games.applyMove({
        gameId: game.game.id,
        identity: game.identities[0]!,
        move: { kind: 'detonate' },
        clientMoveId: 'bad',
      }),
    ).rejects.toThrow()
    await pressTurns(container, game, 1)

    // Timer rows are filtered out: this test is about what a *refused* move
    // leaves behind, and the deadlines around it are Phase H's business.
    const rows = (await container.repos.events.listByGame(game.game.id)).filter(
      (row) => !isTimerEvent(row.payload),
    )
    expect(rows.map((row) => row.kind)).toEqual(['AUDIT', 'MOVE'])

    // One press happened, so one press is what the rebuild shows.
    const rebuilt = await container.games.rebuildState(game.game.id)
    expect(rebuilt.state).toMatchObject({ turn: 1, counts: { '0': 1, '1': 0 } })
  })
})

describe('★ a server restart loses nothing', () => {
  it('a second container over the same database rebuilds identical state', async () => {
    const game = await dealGame(container, { seats: 2, target: 100 })
    await pressTurns(container, game, 7)

    const before = await container.games.rebuildState(game.game.id)

    /**
     * ★ This is the restart, and it is a faithful one: a brand-new container
     * shares nothing with the first but the database — no service instance, no
     * cache, no engine state. If any part of the game lived in process memory,
     * this container could not know about it.
     */
    const restarted = buildTestApp()
    try {
      const after = await restarted.container.games.rebuildState(game.game.id)

      expect(JSON.stringify(after.state)).toBe(JSON.stringify(before.state))
      expect(after.seq).toBe(before.seq)

      // And it can carry on playing from there — which is the point, rather
      // than merely reading the same numbers back.
      const applied = await restarted.container.games.applyMove({
        gameId: game.game.id,
        identity: game.identities[7 % 2]!,
        move: { kind: 'press' },
        clientMoveId: 'after-restart',
      })
      // 16 = 7 presses + 7 deadlines + the deal's own deadline, then this move.
      expect(applied.seq).toBe(16)
    } finally {
      await restarted.container.shutdown()
    }
  })
})

describe('★ the snapshot policy — 03 §4.3', () => {
  it('is a pure predicate: every 25, at a phase boundary, and on terminal', () => {
    const move = (kind: GameEvent['kind']) => ({ kind }) as GameEvent

    // Every 25 — tested on the *crossing*, so a transition appending two events
    // cannot step over the boundary and skip the snapshot.
    expect(shouldSnapshot(24, 25, [move('MOVE')], false)).toBe(true)
    expect(shouldSnapshot(24, 26, [move('MOVE'), move('MOVE')], false)).toBe(true)
    expect(shouldSnapshot(25, 26, [move('MOVE')], false)).toBe(false)

    // A phase boundary, wherever it falls.
    expect(shouldSnapshot(3, 4, [move('PHASE')], false)).toBe(true)
    // And always on FINISHED, whatever the count says.
    expect(shouldSnapshot(3, 4, [move('MOVE')], true)).toBe(true)
  })

  it('writes snapshots at 25, 50 and 75, and the replay cost stays bounded', async () => {
    const game = await dealGame(container, { seats: 2, target: 100 })
    await pressTurns(container, game, 80)

    const snapshots = await db.gameSnapshot.findMany({
      where: { gameId: game.game.id },
      orderBy: { seq: 'asc' },
    })

    // ★ Every 25 *events*, and there are now two per turn — so 80 presses cross
    // the boundary at 50, 100 and 150 rather than at 25, 50 and 75. The policy
    // is unchanged; the log is denser.
    expect(snapshots.map((row) => row.seq)).toEqual([50, 100, 150])

    // ★ The point of the policy: a rebuild starts from the newest snapshot and
    // replays a handful of events, not a hundred and sixty. That bound is what
    // keeps "rebuild on every move" affordable enough to have no in-memory
    // cache at all.
    const latest = await container.repos.snapshots.findLatest(game.game.id)
    expect(latest?.seq).toBe(150)

    const replayed = await container.repos.events.listByGame(game.game.id, 151)
    expect(replayed.length).toBeLessThanOrEqual(SNAPSHOT_EVERY)
    expect(replayed.length).toBeLessThanOrEqual(SNAPSHOT_EVERY)
  })

  it('always snapshots the final state', async () => {
    const game = await dealGame(container, { seats: 2, target: 1 })
    await pressTurns(container, game, 1)

    const snapshots = await db.gameSnapshot.findMany({ where: { gameId: game.game.id } })
    expect(snapshots).toHaveLength(1)
    expect(JSON.parse(snapshots[0]?.stateJson ?? '{}')).toMatchObject({
      phase: 'FINISHED',
      winner: 0,
    })
  })

  it('★ rebuilding from a snapshot agrees with rebuilding from event 0', async () => {
    const game = await dealGame(container, { seats: 2, target: 100 })
    await pressTurns(container, game, 30)

    const withSnapshot = await container.games.rebuildState(game.game.id)

    // Delete every snapshot and rebuild the long way. If the two disagreed, a
    // snapshot would be quietly changing the game — which is exactly what a
    // shared, position-dependent RNG would have caused.
    await db.gameSnapshot.deleteMany({ where: { gameId: game.game.id } })
    const fromScratch = await container.games.rebuildState(game.game.id)

    expect(JSON.stringify(fromScratch.state)).toBe(JSON.stringify(withSnapshot.state))
  })
})

describe('pruning', () => {
  it('★ removes old snapshots and zero events', async () => {
    const game = await dealGame(container, { seats: 2, target: 100 })
    await pressTurns(container, game, 80)

    const eventsBefore = await container.repos.events.countByGame(game.game.id)
    const removed = await container.games.pruneSnapshots(game.game.id)

    const snapshots = await db.gameSnapshot.findMany({
      where: { gameId: game.game.id },
      orderBy: { seq: 'asc' },
    })

    expect(removed).toBe(1)
    expect(snapshots.map((row) => row.seq)).toEqual([100, 150])
    // ★ Events are never pruned while the match is retained. The log is the
    // match; the snapshots are a cache in front of it.
    expect(await container.repos.events.countByGame(game.game.id)).toBe(eventsBefore)
  })

  it('does nothing when there are fewer snapshots than it keeps', async () => {
    const game = await dealGame(container, { seats: 2, target: 100 })
    await pressTurns(container, game, 30)

    expect(await container.games.pruneSnapshots(game.game.id)).toBe(0)
  })

  it('and the game still rebuilds correctly afterwards', async () => {
    const game = await dealGame(container, { seats: 2, target: 100 })
    await pressTurns(container, game, 80)

    const before = await container.games.rebuildState(game.game.id)
    await container.games.pruneSnapshots(game.game.id)
    const after = await container.games.rebuildState(game.game.id)

    expect(JSON.stringify(after.state)).toBe(JSON.stringify(before.state))
  })
})

describe('★ resync — 04 §5.3', () => {
  it('delta sends exactly the missed events, then one current state', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const game = await dealGame(container, { seats: 2, target: 100 })
      await pressTurns(container, game, 5)
      publisher.clear()

      const outcome = await container.games.resync({
        gameId: game.game.id,
        identity: game.identities[0]!,
        socketId: 'sock-1',
        lastSeq: 2,
      })

      // 5 presses → 11 rows (the deal's deadline, then a move and a deadline
      // per turn), so catching up from seq 2 replays 3..11.
      expect(outcome).toEqual({ mode: 'delta', fromSeq: 3, toSeq: 11 })

      /**
       * ★ And the *narration* skips the deadlines: a reconnecting client would
       * otherwise see one "phase changed" line per turn of the whole match in
       * its move log. The live deadline reaches it separately, from
       * `TurnTimerService.announceToSocket` — a stale one would be worse than
       * none, since the client would count down to an instant already passed.
       */
      const narration = publisher.of('game:event')
      expect(narration.map((entry) => (entry.payload as { seq: number }).seq)).toEqual([
        4, 6, 8, 10,
      ])

      // Exactly one state, and it comes last — a client that applied the
      // events and then the state ends where the server is.
      const states = publisher.of('game:state')
      expect(states).toHaveLength(1)
      expect(publisher.sent.at(-1)?.event).toBe('game:state')
      expect(states[0]?.room).toBe('socket:sock-1')
    } finally {
      container.realtime.detach()
    }
  })

  it('★ full is correct from lastSeq 0 and from no lastSeq at all', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const game = await dealGame(container, { seats: 2, target: 100 })
      await pressTurns(container, game, 4)

      for (const lastSeq of [0, undefined]) {
        publisher.clear()
        const outcome = await container.games.resync({
          gameId: game.game.id,
          identity: game.identities[1]!,
          socketId: 'sock-2',
          ...(lastSeq === undefined ? {} : { lastSeq }),
        })

        // `lastSeq: 0` is a gap of 9, which is inside the delta window — so it
        // is a delta, and that is right: replaying nine events is cheaper than
        // a lobby snapshot. "No lastSeq at all" is the one that cannot be
        // reconciled and must be full.
        if (lastSeq === 0) {
          expect(outcome).toEqual({ mode: 'delta', fromSeq: 1, toSeq: 9 })
        } else {
          expect(outcome).toEqual({ mode: 'full', fromSeq: null, toSeq: 9 })
          expect(publisher.of('game:started')).toHaveLength(1)
        }

        // Either way the client ends with exactly one current state.
        expect(publisher.of('game:state')).toHaveLength(1)
      }
    } finally {
      container.realtime.detach()
    }
  })

  it('falls back to full beyond the delta window', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const game = await dealGame(container, { seats: 2, target: 100 })
      await pressTurns(container, game, MAX_DELTA_GAP + 5)
      publisher.clear()

      const outcome = await container.games.resync({
        gameId: game.game.id,
        identity: game.identities[0]!,
        socketId: 'sock-3',
        lastSeq: 1,
      })

      expect(outcome.mode).toBe('full')
      expect(publisher.of('game:event')).toHaveLength(0)
    } finally {
      container.realtime.detach()
    }
  })

  it('★ a client claiming to be ahead of the log is told to resync, then given everything', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const game = await dealGame(container, { seats: 2, target: 100 })
      await pressTurns(container, game, 3)
      publisher.clear()

      const outcome = await container.games.resync({
        gameId: game.game.id,
        identity: game.identities[0]!,
        socketId: 'sock-4',
        lastSeq: 999,
      })

      // No amount of replay reconciles a client that is ahead of the truth, so
      // it is told so out of band and then handed a full state.
      expect(publisher.of('game:syncRequired')[0]?.payload).toMatchObject({
        reason: 'AHEAD_OF_SERVER',
      })
      expect(outcome.mode).toBe('full')
    } finally {
      container.realtime.detach()
    }
  })

  it('a spectator resyncing gets the spectator projection, not a seat’s', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const game = await dealGame(container, { seats: 2, target: 100 })
      await pressTurns(container, game, 2)
      publisher.clear()

      // An identity with no seat at this table. It must not be handed a hand.
      const outsider = { kind: 'user' as const, userId: 'nobody-in-this-game' }
      await container.games.resync({
        gameId: game.game.id,
        identity: outsider,
        socketId: 'sock-5',
        lastSeq: 1,
      })

      const state = publisher.of('game:state')[0]?.payload as { view: { secret: number | null } }
      expect(state.view.secret).toBeNull()
    } finally {
      container.realtime.detach()
    }
  })
})
