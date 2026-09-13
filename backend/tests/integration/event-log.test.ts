import { createHash } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import { dealGame, pressTurns, seatTable } from '../helpers/game.js'
import { userRef } from '../../src/domain/value-objects/identity.js'
import { seatId } from '../../src/domain/value-objects/seat.js'
import { commitSeed } from '../../src/domain/games/shared/rng.js'
import {
  ForbiddenError,
  IllegalMoveError,
  IllegalPhaseTransitionError,
  NotYourTurnError,
  ValidationError,
} from '../../src/domain/errors/errors.js'
import { RecordingPublisher } from '../fakes/realtime.js'
import { isTimerEvent } from '../../src/application/ports/turns.js'
import type { GameEvent } from '../../src/domain/entities/game.js'

/**
 * ★ S28 — the append-only log, the ordering the database enforces, and the
 * commitment that has to be published before a single card exists.
 *
 * Four properties are proved here, and each of them fails silently if it is
 * only *intended*:
 *
 *   1. `seq` is monotonic and gapless **under concurrency** — because it is
 *      allocated by `MAX(seq) + 1` and only a unique constraint makes that safe.
 *   2. A retried `clientMoveId` appends **once** and returns the original ack.
 *   3. `seedCommit == sha256(rngSeed + gameId)`, recomputed here independently
 *      of the code that produced it.
 *   4. **`rngSeed` appears in no client-facing payload while the game is live**,
 *      asserted by serializing every broadcast and searching for it.
 */

const { container } = buildTestApp()

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await container.shutdown()
})

/**
 * The log minus its turn deadlines.
 *
 * Since Phase H every turn also appends the `endsAt` it was given (04 §6.1), so
 * a game's log is roughly twice as long as its move count. Tests about *moves*
 * filter those rows out rather than counting around them, which keeps each
 * assertion about the thing it is named after.
 */
async function moveRows(gameId: string): Promise<GameEvent[]> {
  const rows = await container.repos.events.listByGame(gameId)
  return rows.filter((row) => !isTimerEvent(row.payload))
}

describe('creating an instance', () => {
  it('★ seedCommit is sha256(rngSeed + gameId), recomputed here by hand', async () => {
    const { game } = await dealGame(container, { seats: 2 })

    // Deliberately not calling `commitSeed` for the expectation — the point is
    // to check the *published algorithm*, which anybody holding the revealed
    // seed can run in a browser console (04 §7).
    const byHand = createHash('sha256')
      .update(game.rngSeed + game.id)
      .digest('hex')

    expect(game.seedCommit).toBe(byHand)
    expect(game.seedCommit).toBe(commitSeed(game.rngSeed, game.id))
    expect(game.seedCommit).toHaveLength(64)
  })

  it('draws a 256-bit seed and does not reveal it yet', async () => {
    const { game } = await dealGame(container)

    expect(game.rngSeed).toMatch(/^[0-9a-f]{64}$/)
    expect(game.seedRevealedAt).toBeNull()
    expect(game.status).toBe('ACTIVE')
    expect(game.seq).toBe(0)
  })

  it('★ snapshots the seating, so history survives every later seat change', async () => {
    const { game, tableId, identities } = await dealGame(container, { seats: 2 })

    expect(game.seating).toHaveLength(2)
    expect(game.seating[0]).toMatchObject({ seat: 0, isBot: false, displayName: 'Host' })

    // The player leaves. The frozen record must not follow them out.
    await container.repos.tables.releaseSeat(tableId, seatId(1))
    const reread = await container.repos.games.findById(game.id)

    expect(reread?.seating).toEqual(game.seating)
    expect(identities).toHaveLength(2)
  })

  it('moves the table to IN_PROGRESS and announces the commit before anything is dealt', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const { game } = await dealGame(container, { seats: 2 })

      const started = publisher.sent.filter((entry) => entry.event === 'game:started')
      const states = publisher.sent.filter((entry) => entry.event === 'game:state')

      expect(started).toHaveLength(1)
      expect(started[0]?.payload).toMatchObject({
        gameId: game.id,
        gameSlug: 'fixture',
        seedCommit: game.seedCommit,
      })

      // ★ The ordering *is* the guarantee: a commit published after the deal
      // proves nothing at all.
      const firstStarted = publisher.sent.findIndex((entry) => entry.event === 'game:started')
      const firstState = publisher.sent.findIndex((entry) => entry.event === 'game:state')
      expect(firstStarted).toBeLessThan(firstState)
      expect(states.length).toBeGreaterThan(0)

      const table = await container.repos.tables.findById(game.tableId)
      expect(table?.status).toBe('IN_PROGRESS')
    } finally {
      container.realtime.detach()
    }
  })

  it('refuses a second active game at the same table', async () => {
    const { tableId, hostUserId, game } = await dealGame(container)

    await expect(
      container.games.createInstance(tableId, { identity: userRef(hostUserId), isHost: true }),
    ).rejects.toThrow(IllegalPhaseTransitionError)
    expect(game.status).toBe('ACTIVE')
  })

  it('refuses a caller who is not the host', async () => {
    const { tableId, identities } = await seatTable(container, { seats: 2 })

    await expect(
      container.games.createInstance(tableId, {
        identity: identities[1] as ReturnType<typeof userRef>,
        isHost: false,
      }),
    ).rejects.toThrow(ForbiddenError)
  })

  it('refuses a table whose *occupied* seats are not a playable count', async () => {
    const { tableId, hostUserId } = await seatTable(container, { seats: 2 })

    // `fixture` declares playableCounts [2, 3, 4]. The table still has two
    // seats; only one of them is now filled — and it is the filled count that
    // decides, because an empty seat cannot press a button.
    await container.repos.tables.releaseSeat(tableId, seatId(1))

    await expect(
      container.games.createInstance(tableId, { identity: userRef(hostUserId), isHost: true }),
    ).rejects.toThrow(ValidationError)
  })
})

describe('★ the seed never leaks while the game is live', () => {
  it('appears in no broadcast payload, no event row and no projection', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const game = await dealGame(container, { seats: 2, target: 50 })
      await pressTurns(container, game, 6)

      const seed = game.game.rngSeed
      // A serialize-and-substring-search, which is the only form of this check
      // that survives somebody adding a field: it catches the seed wherever it
      // hides, including inside a nested debug object.
      const wire = JSON.stringify(publisher.sent)
      expect(wire.includes(seed)).toBe(false)

      const events = await container.repos.events.listByGame(game.game.id)
      expect(JSON.stringify(events).includes(seed)).toBe(false)

      // And the instance still has not revealed it.
      const reread = await container.repos.games.findById(game.game.id)
      expect(reread?.seedRevealedAt).toBeNull()
      expect(reread?.rngSeed).toBe(seed)
    } finally {
      container.realtime.detach()
    }
  })

  it('is revealed — once — in game:finished, with the commit beside it', async () => {
    const publisher = new RecordingPublisher()
    container.realtime.attach(publisher)

    try {
      const game = await dealGame(container, { seats: 2, target: 1 })
      await pressTurns(container, game, 1)

      const finished = publisher.sent.filter((entry) => entry.event === 'game:finished')
      expect(finished).toHaveLength(1)
      expect(finished[0]?.payload).toMatchObject({
        seedRevealed: game.game.rngSeed,
        seedCommit: game.game.seedCommit,
        reason: 'NORMAL',
      })

      const reread = await container.repos.games.findById(game.game.id)
      expect(reread?.status).toBe('FINISHED')
      expect(reread?.seedRevealedAt).not.toBeNull()
    } finally {
      container.realtime.detach()
    }
  })
})

describe('★ seq ordering', () => {
  it('is strictly monotonic and gapless under 100 contended appends', async () => {
    const { game } = await dealGame(container)

    /**
     * Appended directly rather than through `applyMove`, because the property
     * under test is the *repository's*: `MAX(seq) + 1` is a read-modify-write,
     * and only the `(gameId, seq)` unique constraint plus the retry loop makes
     * it safe. A turn-based caller would serialize these and prove nothing.
     *
     * ★ 100 appends, ten genuinely simultaneous at a time, rather than 100 at
     * once — and the reason is the harness, not the code. Prisma's SQLite
     * datasource holds **one** connection, so a hundred interactive
     * transactions queue behind it and the later ones exceed the 5-second
     * acquisition timeout: the test would fail on pool starvation while saying
     * nothing about ordering. Ten-wide is already far past the real ceiling —
     * a table seats at most ten, and moves are turn-based — and it is what the
     * `SEQ_RETRIES` budget is sized for.
     */
    const WAVE = 10
    for (let wave = 0; wave < 10; wave += 1) {
      await Promise.all(
        Array.from({ length: WAVE }, (_, index) =>
          container.repos.events.append({
            gameId: game.id,
            kind: 'SYSTEM',
            payload: { index: wave * WAVE + index },
          }),
        ),
      )
    }

    const rows = await container.repos.events.listByGame(game.id)
    const seqs = rows.map((row) => row.seq)

    // ★ Seq 1 is the deal's own turn deadline (Phase H, 04 §6.1), so the
    // hundred contended appends occupy 2..101. The property under test is
    // unchanged: gapless, duplicate-free, and in order.
    expect(seqs).toHaveLength(101)
    expect(seqs).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
    expect(new Set(seqs).size).toBe(101)

    const reread = await container.repos.games.findById(game.id)
    expect(reread?.seq).toBe(101)
  })

  it('the instance seq never lags the newest event', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })
    await pressTurns(container, game, 5)

    const rows = await container.repos.events.listByGame(game.game.id)
    const reread = await container.repos.games.findById(game.game.id)

    expect(reread?.seq).toBe(rows.at(-1)?.seq)
  })
})

describe('★ move idempotency, enforced by the database', () => {
  it('the same clientMoveId twice → one event, and the second call returns the first', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })

    const first = await container.games.applyMove({
      gameId: game.game.id,
      identity: game.identities[0]!,
      move: { kind: 'press' },
      clientMoveId: 'retry-me',
    })
    const second = await container.games.applyMove({
      gameId: game.game.id,
      identity: game.identities[0]!,
      move: { kind: 'press' },
      clientMoveId: 'retry-me',
    })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.seq).toBe(first.seq)

    // Timer rows excluded: the question is how many *moves* the retry produced.
    const rows = (await db.gameEvent.findMany({ where: { gameId: game.game.id } })).filter(
      (row) => !isTimerEvent(JSON.parse(row.payloadJson) as Record<string, unknown>),
    )
    expect(rows).toHaveLength(1)

    // ★ And the game did not advance twice: the state is one press in, and it
    // is still seat 1's turn.
    const rebuilt = await container.games.rebuildState(game.game.id)
    expect(rebuilt.state).toMatchObject({ turn: 1, toAct: 1 })
  })

  it('a retry from the wrong seat still returns the original, never a second move', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })

    await container.games.applyMove({
      gameId: game.game.id,
      identity: game.identities[0]!,
      move: { kind: 'press' },
      clientMoveId: 'shared-key',
    })

    // Seat 1 replaying seat 0's key: the log already holds that id, so the
    // answer comes from the log. It is *not* a second press by seat 1 — which
    // would otherwise be a way to play out of turn by guessing a key.
    const replay = await container.games.applyMove({
      gameId: game.game.id,
      identity: game.identities[1]!,
      move: { kind: 'press' },
      clientMoveId: 'shared-key',
    })

    expect(replay.replayed).toBe(true)
    const rebuilt = await container.games.rebuildState(game.game.id)
    expect(rebuilt.state).toMatchObject({ turn: 1, counts: { '0': 1, '1': 0 } })
  })

  it('the unique constraint is the mechanism, not a cache a restart could lose', async () => {
    const { game } = await dealGame(container)
    await container.repos.events.append({
      gameId: game.id,
      kind: 'MOVE',
      seat: seatId(0),
      clientMoveId: 'k',
      payload: { move: { kind: 'press' } },
    })

    const again = await container.repos.events.append({
      gameId: game.id,
      kind: 'MOVE',
      seat: seatId(0),
      clientMoveId: 'k',
      payload: { move: { kind: 'press' } },
    })

    expect(await moveRows(game.id)).toHaveLength(1)
    // Seq 2, because the deal's deadline took seq 1 — and the *point* stands:
    // the second append with the same key returned the first row rather than
    // writing a new one.
    expect(again.seq).toBe(2)
  })
})

describe('★ rejected moves land as AUDIT events in the same ordered stream', () => {
  it('an illegal move is refused, audited, and changes nothing', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })

    await expect(
      container.games.applyMove({
        gameId: game.game.id,
        identity: game.identities[0]!,
        move: { kind: 'detonate' },
        clientMoveId: 'bad-1',
      }),
    ).rejects.toThrow(IllegalMoveError)

    const rows = await moveRows(game.game.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'AUDIT', seat: 0 })
    expect(rows[0]?.payload).toMatchObject({
      rejected: true,
      code: 'ILLEGAL_MOVE',
      clientMoveId: 'bad-1',
    })

    // The state is untouched — the transaction rolled back and only the audit
    // row, written in its own, survives.
    const rebuilt = await container.games.rebuildState(game.game.id)
    expect(rebuilt.state).toMatchObject({ turn: 0, toAct: 0 })
  })

  it('moving out of turn is NOT_YOUR_TURN, and also audited', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })

    await expect(
      container.games.applyMove({
        gameId: game.game.id,
        identity: game.identities[1]!,
        move: { kind: 'press' },
        clientMoveId: 'early',
      }),
    ).rejects.toThrow(NotYourTurnError)

    const rows = await moveRows(game.game.id)
    expect(rows[0]?.payload).toMatchObject({ code: 'NOT_YOUR_TURN' })
  })

  it('★ the rejected key is in the payload, never in the clientMoveId column', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })

    await expect(
      container.games.applyMove({
        gameId: game.game.id,
        identity: game.identities[0]!,
        move: { kind: 'nonsense' },
        clientMoveId: 'same-key',
      }),
    ).rejects.toThrow(IllegalMoveError)

    const audit = await db.gameEvent.findFirst({ where: { gameId: game.game.id } })
    expect(audit?.clientMoveId).toBeNull()

    // ★ Which is what lets the corrected retry under the same key actually
    // play. Had the AUDIT row taken the unique slot, this would have come back
    // "already applied" and the player would be stuck.
    const applied = await container.games.applyMove({
      gameId: game.game.id,
      identity: game.identities[0]!,
      move: { kind: 'press' },
      clientMoveId: 'same-key',
    })

    expect(applied.replayed).toBe(false)
    // The AUDIT row for the refusal, then the MOVE that corrected it.
    expect(await moveRows(game.game.id)).toHaveLength(2)
  })

  it('records a SecurityEvent, escalating to ALERT after five in the window', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(
        container.games.applyMove({
          gameId: game.game.id,
          identity: game.identities[0]!,
          move: { kind: 'nope' },
          clientMoveId: `probe-${attempt}`,
        }),
      ).rejects.toThrow(IllegalMoveError)
    }

    // `record` is fire-and-forget, so let the writes land.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const rows = await db.securityEvent.findMany({ where: { kind: 'ILLEGAL_MOVE' } })
    expect(rows.length).toBeGreaterThanOrEqual(6)
    // One rejection is a mis-click; the sixth in thirty seconds is a probe.
    expect(rows.some((row) => row.severity === 'ALERT')).toBe(true)
  })
})

describe('who acted, for the guest claim', () => {
  it('stamps the actor from the frozen seating, not from the live member row', async () => {
    const game = await dealGame(container, { seats: 2, target: 50 })
    await pressTurns(container, game, 1)

    const row = await db.gameEvent.findFirst({
      where: { gameId: game.game.id, kind: 'MOVE' },
    })

    expect(row?.actorUserId).toBe(game.game.seating[0]?.userId)
    expect(row?.actorGuestId).toBeNull()
  })
})
