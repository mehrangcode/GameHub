import { beforeEach, describe, expect, it } from 'vitest'
import { buildRepositories, UnitOfWork } from '../../src/infrastructure/prisma/UnitOfWork.js'
import { userRef } from '../../src/domain/value-objects/identity.js'
import type { SeatId } from '../../src/domain/value-objects/seat.js'
import { db, resetDb } from '../helpers/db.js'

/**
 * The property everything transactional in M0 rests on: a throw inside
 * `uow.run` must leave **nothing** behind.
 *
 * The guest→user claim (S22) writes to a dozen tables — user, wallet, ledger,
 * seat, event log, preferences, guest session. Half of that applied is worse
 * than none of it: a vested balance with no account, or a seat transferred away
 * from a guest who never became a user. This file is where that guarantee is
 * checked against a real transaction rather than assumed.
 */
const uow = new UnitOfWork(db)
const repos = buildRepositories(db)
const seat = (n: number): SeatId => n as SeatId

const newUser = (email: string) => ({
  email,
  passwordHash: 'argon2id$fixture',
  displayName: 'Tester',
})

describe('UnitOfWork', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('commits every write when the work completes', async () => {
    const result = await uow.run(async (tx) => {
      const user = await tx.users.create(newUser('commit@test.dev'))
      const table = await tx.tables.create({
        gameSlug: 'fixture',
        options: {},
        seatCount: 4,
        hostUserId: user.id,
      })
      return { user, table }
    })

    expect(await repos.users.findById(result.user.id)).not.toBeNull()
    expect(await repos.tables.findById(result.table.id)).not.toBeNull()
  })

  it('★ rolls back BOTH writes when the second one throws', async () => {
    await expect(
      uow.run(async (tx) => {
        await tx.users.create(newUser('rollback@test.dev'))
        await tx.tables.create({ gameSlug: 'fixture', options: {}, seatCount: 4 })
        throw new Error('settlement failed halfway')
      }),
    ).rejects.toThrow('settlement failed halfway')

    expect(await repos.users.findByEmail('rollback@test.dev')).toBeNull()
    expect(await db.table.count()).toBe(0)
  })

  it('rolls back when the database itself rejects a later write', async () => {
    await repos.users.create(newUser('taken@test.dev'))

    await expect(
      uow.run(async (tx) => {
        await tx.tables.create({ gameSlug: 'fixture', options: {}, seatCount: 4 })
        // Duplicate email — the constraint, not our code, aborts the transaction.
        await tx.users.create(newUser('taken@test.dev'))
      }),
    ).rejects.toThrow()

    expect(await db.table.count()).toBe(0)
    expect(await db.user.count()).toBe(1)
  })

  it('sees its own uncommitted writes from earlier in the same run', async () => {
    await uow.run(async (tx) => {
      const user = await tx.users.create(newUser('reads-own@test.dev'))
      // Not yet committed — visible only because it is the same transaction.
      expect(await tx.users.findById(user.id)).not.toBeNull()
      expect(await tx.users.findByEmail('reads-own@test.dev')).not.toBeNull()

      const table = await tx.tables.create({
        gameSlug: 'fixture',
        options: {},
        seatCount: 4,
        hostUserId: user.id,
      })
      await tx.tables.claimSeat(table.id, seat(0), userRef(user.id))
      expect(await tx.tables.countActiveMembers(table.id)).toBe(1)
    })
  })

  it('a write outside the run cannot see it until it commits', async () => {
    let observedDuringRun = -1
    await uow.run(async (tx) => {
      await tx.users.create(newUser('isolated@test.dev'))
      // A *separate* client, so this read is outside the transaction.
      observedDuringRun = await db.user.count()
    })

    expect(observedDuringRun).toBe(0)
    expect(await db.user.count()).toBe(1)
  })

  it('rolls back a wallet credit — the ledger row and the balance together', async () => {
    const user = await repos.users.create(newUser('ledger@test.dev'))
    const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')

    await expect(
      uow.run(async (tx) => {
        await tx.wallets.append({
          walletId: wallet.id,
          amount: 500,
          kind: 'MATCH_REWARD',
          idempotencyKey: 'MATCH_REWARD:doomed',
        })
        throw new Error('audit write failed')
      }),
    ).rejects.toThrow('audit write failed')

    // E1: neither half survived. A credited balance with no ledger row — or a
    // ledger row with no balance — is exactly the drift reconciliation hunts.
    expect((await repos.wallets.findById(wallet.id))?.balance).toBe(0)
    expect(await repos.wallets.sumTransactions(wallet.id)).toBe(0)
    expect(await repos.wallets.findTransactionByKey(wallet.id, 'MATCH_REWARD:doomed')).toBeNull()
  })

  it('appends a game event inside a run without nesting transactions', async () => {
    const table = await repos.tables.create({ gameSlug: 'fixture', options: {}, seatCount: 4 })
    const game = await repos.games.create({
      tableId: table.id,
      gameSlug: 'fixture',
      rngSeed: 's',
      seedCommit: 'c',
      seating: [],
      options: {},
    })

    // `append` opens its own transaction when called standalone; inside a run
    // it must detect the TransactionClient and stay flat, or Prisma throws.
    await uow.run(async (tx) => {
      await tx.events.append({ gameId: game.id, kind: 'DEAL', payload: {} })
      await tx.events.append({ gameId: game.id, kind: 'MOVE', payload: { card: 'AS' } })
    })

    expect(await repos.events.lastSeq(game.id)).toBe(2)
    expect((await repos.games.findById(game.id))?.seq).toBe(2)
  })

  it('rolls the event log back too, leaving seq where it started', async () => {
    const table = await repos.tables.create({ gameSlug: 'fixture', options: {}, seatCount: 4 })
    const game = await repos.games.create({
      tableId: table.id,
      gameSlug: 'fixture',
      rngSeed: 's',
      seedCommit: 'c',
      seating: [],
      options: {},
    })

    await expect(
      uow.run(async (tx) => {
        await tx.events.append({ gameId: game.id, kind: 'MOVE', payload: {} })
        throw new Error('engine rejected the move after the append')
      }),
    ).rejects.toThrow()

    expect(await repos.events.countByGame(game.id)).toBe(0)
    expect((await repos.games.findById(game.id))?.seq).toBe(0)
  })

  it('returns the work’s value', async () => {
    expect(await uow.run(async () => 'done')).toBe('done')
  })
})

describe('concurrency against the real database', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('★ two simultaneous claims for one seat: exactly one wins, the loser gets null', async () => {
    const table = await repos.tables.create({ gameSlug: 'fixture', options: {}, seatCount: 4 })
    const a = await repos.users.create(newUser('race-a@test.dev'))
    const b = await repos.users.create(newUser('race-b@test.dev'))

    const results = await Promise.all([
      repos.tables.claimSeat(table.id, seat(2), userRef(a.id)),
      repos.tables.claimSeat(table.id, seat(2), userRef(b.id)),
    ])

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    // The loser gets null, not an exception — losing a seat race is normal.
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(await db.tableMember.count({ where: { tableId: table.id } })).toBe(1)
  })

  it('★ two simultaneous credits with the same key pay exactly once', async () => {
    const user = await repos.users.create(newUser('double-pay@test.dev'))
    const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')
    const entry = {
      walletId: wallet.id,
      amount: 80,
      kind: 'MATCH_REWARD' as const,
      idempotencyKey: 'MATCH_REWARD:match-1:user:double-pay',
    }

    const results = await Promise.all([repos.wallets.append(entry), repos.wallets.append(entry)])

    expect(results.filter((r) => r.applied)).toHaveLength(1)
    expect(await repos.wallets.sumTransactions(wallet.id)).toBe(80)
    expect((await repos.wallets.findById(wallet.id))?.balance).toBe(80)
  })

  it('concurrent appends to one game produce a gapless seq', async () => {
    const table = await repos.tables.create({ gameSlug: 'fixture', options: {}, seatCount: 4 })
    const game = await repos.games.create({
      tableId: table.id,
      gameSlug: 'fixture',
      rngSeed: 's',
      seedCommit: 'c',
      seating: [],
      options: {},
    })

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        repos.events.append({ gameId: game.id, kind: 'MOVE', payload: { n } }),
      ),
    )

    const events = await repos.events.listByGame(game.id)
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })
})
