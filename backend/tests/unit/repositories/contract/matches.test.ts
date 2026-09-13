import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { REPO_HARNESSES } from '../../../harnesses.js'
import type { Repositories } from '../../../../src/domain/repositories/Repositories.js'
import type { NewMatchResult } from '../../../../src/domain/repositories/matches.js'
import { guestRef, userRef } from '../../../../src/domain/value-objects/identity.js'
import { seatId } from '../../../../src/domain/value-objects/seat.js'
import { makeGame, makeGuest, makeTable, makeUser } from '../fixtures.js'

/**
 * ★ S36's repositories, held to one contract by both implementations.
 *
 * Two properties matter more than the rest and are asserted first:
 *
 *   1. **`gameId` is unique and a duplicate `create` throws.** That is the
 *      match-level half of settlement idempotency. A fake that quietly accepted
 *      a second result would let a double-settlement bug pass every unit test
 *      and surface only against the database, which is the worst possible place
 *      to find it.
 *   2. **`listRecentHolderSetsFor` answers §3.5's question identically** in
 *      memory and in SQL. The in-memory version walks two collections; the
 *      Prisma one joins two tables. Getting the same answer out of both is what
 *      makes the repeat-decay behaviour trustworthy.
 */

const HALF_HOUR = 30 * 60 * 1000

function result(gameId: string, overrides: Partial<NewMatchResult> = {}): NewMatchResult {
  return {
    gameId,
    gameSlug: 'fixture',
    reason: 'NORMAL',
    winningTeam: null,
    summary: { note: 'contract' },
    durationMs: 60_000,
    finishedAt: new Date('2026-09-13T12:00:00.000Z'),
    ...overrides,
  }
}

/** A finished match with the given human holders seated 0..n. */
async function settle(
  repos: Repositories,
  gameId: string,
  holders: readonly { userId?: string; guestSessionId?: string }[],
  finishedAt: Date,
): Promise<string> {
  const match = await repos.matchResults.create(result(gameId, { finishedAt }))
  for (const [index, holder] of holders.entries()) {
    await repos.participants.create({
      matchResultId: match.id,
      userId: holder.userId ?? null,
      guestSessionId: holder.guestSessionId ?? null,
      isBot: false,
      seat: seatId(index),
      team: null,
      rank: index + 1,
      score: 0,
    })
  }
  return match.id
}

describe.each(REPO_HARNESSES)('[$name] match repositories', (harness) => {
  beforeEach(async () => {
    await harness.reset()
  })
  afterAll(async () => {
    await harness.dispose()
  })

  describe('IMatchResultRepository', () => {
    it('creates a result and reads it back by game and by id', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)

      const created = await repos.matchResults.create(result(game.id))

      expect(await repos.matchResults.findByGame(game.id)).toMatchObject({ id: created.id })
      expect(await repos.matchResults.findById(created.id)).toMatchObject({ gameId: game.id })
      // The JSON column round-trips as an object, not as a string.
      expect(created.summary).toEqual({ note: 'contract' })
    })

    it('★ a second result for the same game THROWS — settlement cannot run twice', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)

      await repos.matchResults.create(result(game.id))
      await expect(repos.matchResults.create(result(game.id))).rejects.toThrow()
    })

    it('findByGame returns null for a game that never finished', async () => {
      const repos = harness.repos()
      expect(await repos.matchResults.findByGame('no-such-game')).toBeNull()
    })
  })

  describe('IMatchResultRepository.listRecentHolderSetsFor — 10 §3.5', () => {
    it('returns the human holder set of each recent match this holder played', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const a = await makeUser(repos, { email: 'a@t.dev' })
      const b = await makeUser(repos, { email: 'b@t.dev' })
      const game = await makeGame(repos, table.id)

      const now = new Date('2026-09-13T12:00:00.000Z')
      await settle(repos, game.id, [{ userId: a.id }, { userId: b.id }], now)

      const sets = await repos.matchResults.listRecentHolderSetsFor(
        userRef(a.id),
        new Date(now.getTime() - HALF_HOUR),
      )

      expect(sets).toHaveLength(1)
      expect([...sets[0]!].sort()).toEqual([`user:${a.id}`, `user:${b.id}`].sort())
    })

    it('★ excludes bots — a matchup is a set of people (§3.5)', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const game = await makeGame(repos, table.id)

      const now = new Date('2026-09-13T12:00:00.000Z')
      const match = await repos.matchResults.create(result(game.id, { finishedAt: now }))
      await repos.participants.create({
        matchResultId: match.id,
        userId: user.id,
        guestSessionId: null,
        isBot: false,
        seat: seatId(0),
        team: null,
        rank: 1,
        score: 0,
      })
      await repos.participants.create({
        matchResultId: match.id,
        userId: null,
        guestSessionId: null,
        isBot: true,
        seat: seatId(1),
        team: null,
        rank: 2,
        score: 0,
      })

      const sets = await repos.matchResults.listRecentHolderSetsFor(
        userRef(user.id),
        new Date(now.getTime() - HALF_HOUR),
      )
      expect(sets).toEqual([[`user:${user.id}`]])
    })

    it('guests count as holders — a guest is a first-class identity', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const user = await makeUser(repos)
      const game = await makeGame(repos, table.id)

      const now = new Date('2026-09-13T12:00:00.000Z')
      await settle(repos, game.id, [{ userId: user.id }, { guestSessionId: guest.id }], now)

      const sets = await repos.matchResults.listRecentHolderSetsFor(
        guestRef(guest.id),
        new Date(now.getTime() - HALF_HOUR),
      )
      expect([...sets[0]!].sort()).toEqual([`guest:${guest.id}`, `user:${user.id}`].sort())
    })

    it('★ a match older than `since` is not returned — the window is what decays', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const game = await makeGame(repos, table.id)

      await settle(repos, game.id, [{ userId: user.id }], new Date('2026-09-13T10:00:00.000Z'))

      const sets = await repos.matchResults.listRecentHolderSetsFor(
        userRef(user.id),
        new Date('2026-09-13T11:30:00.000Z'),
      )
      expect(sets).toEqual([])
    })

    it('a holder who played nothing recently gets an empty list, not an error', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      expect(
        await repos.matchResults.listRecentHolderSetsFor(userRef(user.id), new Date(0)),
      ).toEqual([])
    })
  })

  describe('IMatchParticipantRepository', () => {
    it('creates rows with the reward already decided — there is no update path', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const game = await makeGame(repos, table.id)
      const match = await repos.matchResults.create(result(game.id))

      const row = await repos.participants.create({
        matchResultId: match.id,
        userId: user.id,
        guestSessionId: null,
        isBot: false,
        seat: seatId(0),
        team: 0,
        rank: 1,
        score: 120,
        outcome: 'EJECTED_TIMEOUT',
        forfeited: true,
        coinsAwarded: 0,
        rewardForfeited: true,
        rewardTxId: null,
        playedFraction: 0.4,
      })

      expect(row).toMatchObject({
        outcome: 'EJECTED_TIMEOUT',
        coinsAwarded: 0,
        rewardForfeited: true,
        playedFraction: 0.4,
      })
    })

    it('listByMatch returns every seat, ordered by seat', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const game = await makeGame(repos, table.id)
      const match = await repos.matchResults.create(result(game.id))

      for (const seat of [2, 0, 1]) {
        await repos.participants.create({
          matchResultId: match.id,
          userId: null,
          guestSessionId: null,
          isBot: true,
          seat: seatId(seat),
          team: null,
          rank: seat + 1,
          score: 0,
        })
      }

      expect((await repos.participants.listByMatch(match.id)).map((row) => row.seat)).toEqual([
        0, 1, 2,
      ])
    })

    it('defaults are the safe ones: not a bot, not forfeited, nothing awarded', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const user = await makeUser(repos)
      const game = await makeGame(repos, table.id)
      const match = await repos.matchResults.create(result(game.id))

      const row = await repos.participants.create({
        matchResultId: match.id,
        userId: user.id,
        guestSessionId: null,
        seat: seatId(0),
        rank: 1,
        score: 0,
      })

      expect(row).toMatchObject({
        isBot: false,
        outcome: 'COMPLETED',
        forfeited: false,
        coinsAwarded: 0,
        rewardForfeited: false,
        rewardTxId: null,
        playedFraction: 1,
      })
    })

    it('re-attributes a guest to the account that claimed them (03 §6.1 step 7)', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const user = await makeUser(repos)
      const game = await makeGame(repos, table.id)
      const match = await repos.matchResults.create(result(game.id))

      await repos.participants.create({
        matchResultId: match.id,
        userId: null,
        guestSessionId: guest.id,
        seat: seatId(0),
        rank: 1,
        score: 0,
      })

      expect(await repos.participants.reattributeActor(guest.id, user.id)).toBe(1)
      expect(await repos.participants.countByGuest(guest.id)).toBe(0)
      expect(await repos.participants.countByUser(user.id)).toBe(1)
    })
  })
})
