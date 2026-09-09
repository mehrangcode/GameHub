import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { REPO_HARNESSES } from '../../../harnesses.js'
import { seat, makeGame, makeGuest, makeTable, makeUser } from '../fixtures.js'

describe.each(REPO_HARNESSES)('[$name] game repositories', (harness) => {
  beforeEach(async () => {
    await harness.reset()
  })
  afterAll(async () => {
    await harness.dispose()
  })

  describe('IGameInstanceRepository', () => {
    it('starts ACTIVE at seq 0 with the seed committed but not revealed', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)

      expect(game.status).toBe('ACTIVE')
      expect(game.seq).toBe(0)
      expect(game.seedCommit).toBe('commit-1')
      expect(game.seedRevealedAt).toBeNull()
      expect(game.finishedAt).toBeNull()
    })

    it('round-trips the seating array through the JSON column', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const seating = [
        {
          seat: seat(0),
          userId: user.id,
          guestSessionId: null,
          isBot: false,
          displayName: 'A',
          team: 0,
        },
        {
          seat: seat(1),
          userId: null,
          guestSessionId: null,
          isBot: true,
          displayName: 'Bot',
          team: 1,
        },
      ]
      const game = await repos.games.create({
        tableId: table.id,
        gameSlug: 'fixture',
        rngSeed: 's',
        seedCommit: 'c',
        seating,
        options: { variant: 'race' },
      })

      expect((await repos.games.findById(game.id))?.seating).toEqual(seating)
      expect((await repos.games.findById(game.id))?.options).toEqual({ variant: 'race' })
    })

    it('finds the one active game of a table', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const finished = await makeGame(repos, table.id)
      await repos.games.finish(finished.id, 'FINISHED', new Date())
      const active = await makeGame(repos, table.id)

      expect((await repos.games.findActiveByTable(table.id))?.id).toBe(active.id)
    })

    it('lists a table’s games oldest first', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const first = await makeGame(repos, table.id)
      const second = await makeGame(repos, table.id)

      expect((await repos.games.listByTable(table.id)).map((g) => g.id)).toEqual([
        first.id,
        second.id,
      ])
    })

    it('finishes and reveals the seed only afterwards (05 §3)', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      const at = new Date('2026-04-01T12:00:00.000Z')

      const done = await repos.games.finish(game.id, 'FINISHED', at)
      expect(done.status).toBe('FINISHED')
      expect(done.finishedAt?.toISOString()).toBe(at.toISOString())

      const revealed = await repos.games.revealSeed(game.id, at)
      expect(revealed.seedRevealedAt?.toISOString()).toBe(at.toISOString())
      expect(revealed.rngSeed).toBe('seed-1')
    })
  })

  describe('IGameEventRepository — the append-only log (P4)', () => {
    it('assigns seq 1, 2, 3… and bumps GameInstance.seq with it', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)

      for (const n of [1, 2, 3]) {
        const event = await repos.events.append({
          gameId: game.id,
          kind: 'MOVE',
          payload: { n },
        })
        expect(event.seq).toBe(n)
      }

      expect(await repos.events.lastSeq(game.id)).toBe(3)
      expect((await repos.games.findById(game.id))?.seq).toBe(3)
    })

    it('counts seq per game, not globally', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const [a, b] = [await makeGame(repos, table.id), await makeGame(repos, table.id)]

      await repos.events.append({ gameId: a.id, kind: 'DEAL', payload: {} })
      await repos.events.append({ gameId: a.id, kind: 'MOVE', payload: {} })
      const firstOfB = await repos.events.append({ gameId: b.id, kind: 'DEAL', payload: {} })

      expect(firstOfB.seq).toBe(1)
      expect(await repos.events.countByGame(a.id)).toBe(2)
      expect(await repos.events.countByGame(b.id)).toBe(1)
    })

    it('★ a retried move with the same clientMoveId returns the original event', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)

      const first = await repos.events.append({
        gameId: game.id,
        kind: 'MOVE',
        seat: seat(0),
        payload: { card: 'AS' },
        clientMoveId: 'move-42',
      })
      const retry = await repos.events.append({
        gameId: game.id,
        kind: 'MOVE',
        seat: seat(0),
        payload: { card: 'AS' },
        clientMoveId: 'move-42',
      })

      expect(retry.id).toBe(first.id)
      expect(retry.seq).toBe(first.seq)
      // One card on the table, not two.
      expect(await repos.events.countByGame(game.id)).toBe(1)
    })

    it('scopes clientMoveId to its game, so two tables may reuse an id', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const [a, b] = [await makeGame(repos, table.id), await makeGame(repos, table.id)]

      await repos.events.append({ gameId: a.id, kind: 'MOVE', payload: {}, clientMoveId: 'm1' })
      await repos.events.append({ gameId: b.id, kind: 'MOVE', payload: {}, clientMoveId: 'm1' })

      expect(await repos.events.countByGame(b.id)).toBe(1)
      expect((await repos.events.findByClientMoveId(a.id, 'm1'))?.gameId).toBe(a.id)
      expect(await repos.events.findByClientMoveId(a.id, 'never')).toBeNull()
    })

    it('several events without a clientMoveId all persist', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)

      await repos.events.append({ gameId: game.id, kind: 'SYSTEM', payload: {} })
      await repos.events.append({ gameId: game.id, kind: 'SYSTEM', payload: {} })

      expect(await repos.events.countByGame(game.id)).toBe(2)
    })

    it('reads a delta range in seq order — the reconnection path', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      for (let n = 0; n < 5; n++) {
        await repos.events.append({ gameId: game.id, kind: 'MOVE', payload: { n } })
      }

      expect((await repos.events.listByGame(game.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
      expect((await repos.events.listByGame(game.id, 3)).map((e) => e.seq)).toEqual([3, 4, 5])
      expect((await repos.events.listByGame(game.id, 2, 4)).map((e) => e.seq)).toEqual([2, 3, 4])
    })

    it('lastSeq is 0 for a game with no events', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      expect(await repos.events.lastSeq(game.id)).toBe(0)
    })

    it('round-trips the payload as an object', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      const payload = { card: 'TD', trick: 3, nested: { ok: true } }

      const event = await repos.events.append({ gameId: game.id, kind: 'MOVE', payload })
      expect((await repos.events.findById(event.id))?.payload).toEqual(payload)
    })

    it('reattributes a guest’s moves to their new account', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      const guest = await makeGuest(repos, table.id)
      const user = await makeUser(repos)

      await repos.events.append({
        gameId: game.id,
        kind: 'MOVE',
        seat: seat(1),
        actorGuestId: guest.id,
        payload: {},
      })
      await repos.events.append({ gameId: game.id, kind: 'SYSTEM', payload: {} })

      expect(await repos.events.reattributeActor(guest.id, user.id)).toBe(1)
      const events = await repos.events.listByGame(game.id)
      expect(events[0]?.actorUserId).toBe(user.id)
      expect(events[0]?.actorGuestId).toBeNull()
      // The system event was nobody's and stays nobody's.
      expect(events[1]?.actorUserId).toBeNull()
    })
  })

  describe('IGameSnapshotRepository — a cache in front of the log', () => {
    it('saves and reads back the state object', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      const state = { phase: 'PLAYING', deckCount: 40 }

      const snapshot = await repos.snapshots.save({ gameId: game.id, seq: 10, state })
      expect((await repos.snapshots.findById(snapshot.id))?.state).toEqual(state)
    })

    it('is idempotent per (gameId, seq)', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)

      const first = await repos.snapshots.save({ gameId: game.id, seq: 5, state: { v: 1 } })
      const second = await repos.snapshots.save({ gameId: game.id, seq: 5, state: { v: 2 } })

      expect(second.id).toBe(first.id)
      expect(second.state).toEqual({ v: 2 })
    })

    it('finds the newest snapshot at or before a seq — the rebuild anchor', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      await repos.snapshots.save({ gameId: game.id, seq: 10, state: { at: 10 } })
      await repos.snapshots.save({ gameId: game.id, seq: 20, state: { at: 20 } })

      expect((await repos.snapshots.findLatest(game.id))?.seq).toBe(20)
      expect((await repos.snapshots.findLatest(game.id, 15))?.seq).toBe(10)
      expect(await repos.snapshots.findLatest(game.id, 5)).toBeNull()
    })

    it('prunes older snapshots without touching the log', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      await repos.events.append({ gameId: game.id, kind: 'MOVE', payload: {} })
      for (const seq of [10, 20, 30]) {
        await repos.snapshots.save({ gameId: game.id, seq, state: {} })
      }

      expect(await repos.snapshots.deleteOlderThan(game.id, 30)).toBe(2)
      expect((await repos.snapshots.findLatest(game.id))?.seq).toBe(30)
      expect(await repos.events.countByGame(game.id)).toBe(1)
    })
  })

  describe('IStatsRepository', () => {
    it('creates on first upsert with zeroed counters', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const stats = await repos.stats.upsert(user.id, 'shelem', {})

      expect(stats.played).toBe(0)
      expect(stats.bestStreak).toBe(0)
      expect(stats.extra).toBeNull()
    })

    it('keys on (userId, gameSlug)', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await repos.stats.upsert(user.id, 'shelem', { played: 3 })
      await repos.stats.upsert(user.id, 'sudoku', { played: 7 })

      expect((await repos.stats.findByUserAndGame(user.id, 'shelem'))?.played).toBe(3)
      expect((await repos.stats.findByUserAndGame(user.id, 'sudoku'))?.played).toBe(7)
      expect(await repos.stats.listByUser(user.id)).toHaveLength(2)
      expect(await repos.stats.findByUserAndGame(user.id, 'chess')).toBeNull()
    })

    it('increment adds instead of replacing — the post-match path', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await repos.stats.upsert(user.id, 'shelem', { played: 5, won: 2, totalMs: 1000 })

      const after = await repos.stats.increment(user.id, 'shelem', {
        played: 1,
        won: 1,
        totalMs: 500,
      })
      expect(after.played).toBe(6)
      expect(after.won).toBe(3)
      expect(after.totalMs).toBe(1500)
      expect(after.lost).toBe(0)
    })

    it('increment creates the row when there is nothing to add to yet', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const stats = await repos.stats.increment(user.id, 'chess', { played: 1 })
      expect(stats.played).toBe(1)
    })

    it('round-trips the game-specific extra object', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const stats = await repos.stats.upsert(user.id, 'sudoku', { extra: { bestMs: 91_000 } })
      expect(stats.extra).toEqual({ bestMs: 91_000 })
    })
  })
})
