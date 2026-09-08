import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isUniqueViolation } from '../../src/infrastructure/prisma/errors.js'
import { db, makeGame, makeGuest, makeTable, makeUser, makeWallet, resetDb } from '../helpers/db.js'

/**
 * The load-bearing constraints, proven by a failing insert rather than by
 * reading the schema. Every one of these is a correctness mechanism the
 * application code is allowed to *rely* on:
 *
 *   (tableId, seat)              the seat race (03 §3.2, §6.3)
 *   (gameId, seq)                event-log ordering
 *   (gameId, clientMoveId)       move idempotency (03 §4.4)
 *   (walletId, idempotencyKey)   the economy's E2 (03 §3.9)
 *   providerEventId              webhook redelivery is a no-op
 */
describe('schema constraints', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  async function expectUniqueViolation(work: () => Promise<unknown>, target?: string) {
    let caught: unknown
    try {
      await work()
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected a unique constraint violation').toBeDefined()
    expect(isUniqueViolation(caught, target)).toBe(true)
  }

  describe('TableMember — 03 §3.2', () => {
    it('rejects two members on the same (tableId, seat) — the seat race fix', async () => {
      const table = await makeTable()
      const a = await makeUser()
      const b = await makeUser()

      await db.tableMember.create({ data: { tableId: table.id, userId: a.id, seat: 1 } })
      await expectUniqueViolation(() =>
        db.tableMember.create({ data: { tableId: table.id, userId: b.id, seat: 1 } }),
      )
    })

    it('rejects one user holding two seats at the same table', async () => {
      const table = await makeTable()
      const user = await makeUser()

      await db.tableMember.create({ data: { tableId: table.id, userId: user.id, seat: 0 } })
      await expectUniqueViolation(() =>
        db.tableMember.create({ data: { tableId: table.id, userId: user.id, seat: 1 } }),
      )
    })

    it('rejects one guest holding two seats at the same table', async () => {
      const table = await makeTable()
      const guest = await makeGuest(table.id)

      await db.tableMember.create({
        data: { tableId: table.id, guestSessionId: guest.id, seat: 0 },
      })
      await expectUniqueViolation(() =>
        db.tableMember.create({ data: { tableId: table.id, guestSessionId: guest.id, seat: 1 } }),
      )
    })

    it('lets two spectators coexist — NULL seats stay distinct on both engines', async () => {
      const table = await makeTable()
      const a = await makeUser()
      const b = await makeUser()

      await db.tableMember.create({
        data: { tableId: table.id, userId: a.id, seat: null, role: 'SPECTATOR' },
      })
      await db.tableMember.create({
        data: { tableId: table.id, userId: b.id, seat: null, role: 'SPECTATOR' },
      })

      expect(await db.tableMember.count({ where: { tableId: table.id, seat: null } })).toBe(2)
    })

    it('lets two bots coexist — both identity columns are NULL', async () => {
      const table = await makeTable()
      await db.tableMember.create({ data: { tableId: table.id, isBot: true, seat: 2 } })
      await db.tableMember.create({ data: { tableId: table.id, isBot: true, seat: 3 } })
      expect(await db.tableMember.count({ where: { isBot: true } })).toBe(2)
    })
  })

  describe('GuestSession — the privilege-escalation guard', () => {
    it('cannot be created without a tableId', async () => {
      await expect(
        db.guestSession.create({
          // A guest identity that worked on any table would be a wildcard
          // credential — 07 §3. The column is non-nullable on purpose.
          data: {
            tokenHash: 'no-table',
            displayName: 'Nobody',
            expiresAt: new Date(),
          } as never,
        }),
      ).rejects.toThrow()
    })
  })

  describe('GameEvent — the append-only log', () => {
    it('rejects a duplicate (gameId, seq)', async () => {
      const table = await makeTable()
      const game = await makeGame(table.id)

      await db.gameEvent.create({
        data: { gameId: game.id, seq: 1, kind: 'MOVE', payloadJson: '{}' },
      })
      await expectUniqueViolation(() =>
        db.gameEvent.create({ data: { gameId: game.id, seq: 1, kind: 'MOVE', payloadJson: '{}' } }),
      )
    })

    it('rejects a duplicate (gameId, clientMoveId) — move idempotency', async () => {
      const table = await makeTable()
      const game = await makeGame(table.id)

      await db.gameEvent.create({
        data: { gameId: game.id, seq: 1, kind: 'MOVE', payloadJson: '{}', clientMoveId: 'm-1' },
      })
      await expectUniqueViolation(() =>
        db.gameEvent.create({
          data: { gameId: game.id, seq: 2, kind: 'MOVE', payloadJson: '{}', clientMoveId: 'm-1' },
        }),
      )
    })

    it('allows many events with a null clientMoveId (dealer and system events)', async () => {
      const table = await makeTable()
      const game = await makeGame(table.id)

      await db.gameEvent.create({
        data: { gameId: game.id, seq: 1, kind: 'DEAL', payloadJson: '{}' },
      })
      await db.gameEvent.create({
        data: { gameId: game.id, seq: 2, kind: 'PHASE', payloadJson: '{}' },
      })
      expect(await db.gameEvent.count({ where: { gameId: game.id } })).toBe(2)
    })

    it('rejects a duplicate GameSnapshot (gameId, seq)', async () => {
      const table = await makeTable()
      const game = await makeGame(table.id)

      await db.gameSnapshot.create({ data: { gameId: game.id, seq: 25, stateJson: '{}' } })
      await expectUniqueViolation(() =>
        db.gameSnapshot.create({ data: { gameId: game.id, seq: 25, stateJson: '{}' } }),
      )
    })
  })

  describe('Wallet & ledger — E1/E2', () => {
    it('rejects a duplicate (walletId, idempotencyKey) — the constraint the economy rests on', async () => {
      const user = await makeUser()
      const wallet = await makeWallet(user.id)

      const row = {
        walletId: wallet.id,
        assetCode: 'COIN',
        amount: 120,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'match:abc:1',
        balanceAfter: 120,
      }
      await db.walletTransaction.create({ data: row })
      await expectUniqueViolation(() => db.walletTransaction.create({ data: row }))
    })

    it('allows the same idempotency key on a different wallet', async () => {
      const a = await makeUser()
      const b = await makeUser()
      const wa = await makeWallet(a.id)
      const wb = await makeWallet(b.id)

      for (const walletId of [wa.id, wb.id]) {
        await db.walletTransaction.create({
          data: {
            walletId,
            assetCode: 'COIN',
            amount: 80,
            kind: 'MATCH_REWARD',
            idempotencyKey: 'match:same:1',
            balanceAfter: 80,
          },
        })
      }
      expect(await db.walletTransaction.count()).toBe(2)
    })

    it('rejects a second COIN wallet for the same user', async () => {
      const user = await makeUser()
      await makeWallet(user.id, 'COIN')
      await expectUniqueViolation(() => makeWallet(user.id, 'COIN'))
    })

    it('allows one wallet per asset for the same user', async () => {
      const user = await makeUser()
      await makeWallet(user.id, 'COIN')
      await makeWallet(user.id, 'GEM')
      expect(await db.wallet.count({ where: { userId: user.id } })).toBe(2)
    })

    it('rejects a second COIN wallet for the same guest session', async () => {
      const table = await makeTable()
      const guest = await makeGuest(table.id)

      await db.wallet.create({
        data: { guestSessionId: guest.id, assetCode: 'COIN', status: 'PROVISIONAL' },
      })
      await expectUniqueViolation(() =>
        db.wallet.create({
          data: { guestSessionId: guest.id, assetCode: 'COIN', status: 'PROVISIONAL' },
        }),
      )
    })
  })

  describe('SubscriptionEvent — at-least-once webhook delivery', () => {
    it('rejects a duplicate providerEventId', async () => {
      const user = await makeUser()
      const sub = await db.subscription.create({ data: { userId: user.id, status: 'ACTIVE' } })

      const row = {
        subscriptionId: sub.id,
        providerEventId: 'evt_123',
        kind: 'renewed',
        payloadJson: '{}',
      }
      await db.subscriptionEvent.create({ data: row })
      await expectUniqueViolation(() => db.subscriptionEvent.create({ data: row }))
    })
  })

  describe('Invite', () => {
    it('rejects a duplicate code', async () => {
      const user = await makeUser()
      const table = await makeTable(user.id)
      const row = {
        tableId: table.id,
        code: 'SEEDDEMO',
        createdByUserId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      }
      await db.invite.create({ data: row })
      await expectUniqueViolation(() => db.invite.create({ data: row }))
    })
  })
})
