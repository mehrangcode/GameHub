import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { MetricsRegistry } from '../../../src/application/services/MetricsRegistry.js'
import { WalletService } from '../../../src/application/services/WalletService.js'
import { DAY_MS, HOUR_MS } from '../../../src/domain/economy/caps.js'
import { matchRewardKey } from '../../../src/domain/economy/idempotency.js'
import { buildRepositories, UnitOfWork } from '../../../src/infrastructure/prisma/UnitOfWork.js'
import { guestRef, userRef } from '../../../src/domain/value-objects/identity.js'
import { db, makeGuest, makeTable, makeUser, resetDb } from '../../helpers/db.js'

/**
 * The credit path against real SQLite — S21.
 *
 * What only a database can prove, and therefore what lives here rather than in
 * `tests/unit/wallet/`:
 *
 *   - two credits racing on one derived key pay **once**, because the unique
 *     constraint decides rather than a `SELECT`
 *   - a throw anywhere in the crediting transaction leaves no ledger row *and*
 *     no balance change
 *   - the rolling cap windows really are windows: a row backdated past the
 *     boundary stops counting
 *
 * The last one is the reason this file writes `createdAt` directly through
 * Prisma. There is deliberately no way for a caller to set a ledger row's
 * timestamp — a caller that could state when a credit happened could place it
 * outside its own cap window — so "yesterday" is manufactured after the fact,
 * by the test, at the database.
 */

const silent = pino({ level: 'silent' })
const uow = new UnitOfWork(db)
const repos = buildRepositories(db)

const GLOBAL_CAPS = {
  gameSlug: null,
  assetCode: 'COIN',
  baseAmount: 0,
  placementJson: JSON.stringify({ draw: 1, bySeatCount: {} }),
  expectedMinMs: 0,
  repeatDecayJson: JSON.stringify([1, 1, 0.6, 0.3, 0.1]),
  capPerHour: 400,
  capPerDay: 2_000,
  capPerDayGuest: 500,
  capMatchesPerDay: 30,
  guestVestCap: 500,
  active: true,
}

async function seedCaps(overrides: Partial<typeof GLOBAL_CAPS> = {}) {
  const data = { ...GLOBAL_CAPS, ...overrides }
  await db.rewardRule.upsert({
    where: { id: '_global' },
    create: { id: '_global', ...data },
    update: data,
  })
}

function service(now: () => Date = () => new Date()) {
  return new WalletService({ uow, repos, metrics: new MetricsRegistry(), logger: silent, now })
}

/** Moves a row back in time, which no production code path can do. */
async function backdate(idempotencyKey: string, ms: number) {
  const row = await db.walletTransaction.findFirst({ where: { idempotencyKey } })
  await db.walletTransaction.update({
    where: { id: row!.id },
    data: { createdAt: new Date(Date.now() - ms) },
  })
}

describe('WalletService.credit — against the database', () => {
  beforeEach(async () => {
    await resetDb()
    await seedCaps()
  })

  it('★ two simultaneous credits with the same derived key pay exactly once', async () => {
    const user = await makeUser()
    const wallets = service()
    const input = {
      holder: userRef(user.id),
      asset: 'COIN' as const,
      amount: 75,
      kind: 'MATCH_REWARD' as const,
      idempotencyKey: matchRewardKey('mr_race', 1),
    }

    // Sequential rather than `Promise.all`: SQLite serialises writers, so
    // parallel calls here would deadlock rather than race. The property under
    // test is the same one either way — the second call sees a row it did not
    // write and must not pay. `tests/integration/unit-of-work.test.ts` proves
    // the genuinely concurrent case at the repository level.
    const first = await wallets.credit(input)
    const second = await wallets.credit(input)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(
      await db.walletTransaction.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(1)
    expect(await wallets.balanceFor(userRef(user.id), 'COIN')).toBe(75)
  })

  it('★ a throw mid-transaction leaves no row and no balance change', async () => {
    const user = await makeUser()
    const wallets = service()
    await wallets.credit({
      holder: userRef(user.id),
      asset: 'COIN',
      amount: 100,
      kind: 'ADMIN_ADJUST',
      idempotencyKey: 'before',
    })

    await expect(
      uow.run(async (tx) => {
        await wallets.creditWithin(tx, {
          holder: userRef(user.id),
          asset: 'COIN',
          amount: 250,
          kind: 'ADMIN_ADJUST',
          idempotencyKey: 'doomed',
        })
        throw new Error('settlement failed after the credit')
      }),
    ).rejects.toThrow('settlement failed after the credit')

    // This is the property S22 and S36 are built on: the credit is not a
    // separate commit, it is part of the caller's.
    expect(await db.walletTransaction.count({ where: { idempotencyKey: 'doomed' } })).toBe(0)
    expect(await wallets.balanceFor(userRef(user.id), 'COIN')).toBe(100)
    const report = await wallets.recompute(userRef(user.id), 'COIN')
    expect(report?.drift).toBe(0)
  })

  /**
   * The plan's E1 case is "500 credits"; that count runs in
   * `tests/unit/wallet/credit.test.ts`, where 500 credits cost milliseconds.
   * Here every credit is a real transaction against a real file — ~100 ms
   * each on SQLite — so this runs a shorter sequence. The property is
   * identical and what the database adds is the part the fakes cannot: the
   * cached column and the row sum are written by one commit each.
   */
  it('★ balance == Σ transactions after a long sequence, checked against the database', async () => {
    const user = await makeUser()
    const wallets = service()
    const holder = userRef(user.id)
    let expected = 0

    for (let i = 0; i < 120; i += 1) {
      const amount = 1 + ((i * 37) % 23)
      expected += amount
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount,
        kind: 'ADMIN_ADJUST',
        idempotencyKey: `bulk:${i}`,
      })
    }

    const wallet = await db.wallet.findFirstOrThrow({
      where: { userId: user.id, assetCode: 'COIN' },
    })
    const sum = await db.walletTransaction.aggregate({
      where: { walletId: wallet.id },
      _sum: { amount: true },
    })

    expect(wallet.balance).toBe(expected)
    expect(sum._sum.amount).toBe(expected)
    expect((await wallets.recompute(holder, 'COIN'))?.drift).toBe(0)
    // `balanceAfter` is a running total, so the newest row restates the balance.
    const newest = await db.walletTransaction.findFirstOrThrow({
      where: { walletId: wallet.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    expect(newest.balanceAfter).toBe(expected)
  }, 60_000)

  it('★ the same key twice in ONE transaction still pays once', async () => {
    const user = await makeUser()
    const wallets = service()
    const key = matchRewardKey('mr_double', 0)

    // The shape of a settlement bug: one seat credited twice inside the same
    // commit, where a "check the database first" defence looks like it works
    // because both reads see the pre-transaction state.
    const [first, second] = await uow.run(async (tx) => [
      await wallets.creditWithin(tx, {
        holder: userRef(user.id),
        asset: 'COIN',
        amount: 60,
        kind: 'MATCH_REWARD',
        idempotencyKey: key,
      }),
      await wallets.creditWithin(tx, {
        holder: userRef(user.id),
        asset: 'COIN',
        amount: 60,
        kind: 'MATCH_REWARD',
        idempotencyKey: key,
      }),
    ])

    expect(first?.applied).toBe(true)
    expect(second?.applied).toBe(false)
    expect(await wallets.balanceFor(userRef(user.id), 'COIN')).toBe(60)
    expect(await db.walletTransaction.count({ where: { idempotencyKey: key } })).toBe(1)
  })

  it('★ the hourly window rolls: a backdated credit stops counting against it', async () => {
    const user = await makeUser()
    const wallets = service()
    const holder = userRef(user.id)

    await wallets.credit({
      holder,
      asset: 'COIN',
      amount: 400,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'yesterday-hour',
    })

    // Immediately after, the hour is full.
    const blocked = await wallets.credit({
      holder,
      asset: 'COIN',
      amount: 50,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'blocked',
    })
    expect(blocked.capCode).toBe('CAP_PER_HOUR')

    // Move the first credit 61 minutes into the past and the hour is free —
    // but the *day* still remembers it.
    await backdate('yesterday-hour', HOUR_MS + 60_000)
    const allowed = await wallets.credit({
      holder,
      asset: 'COIN',
      amount: 50,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'allowed',
    })
    expect(allowed.credited).toBe(50)
    expect(allowed.capCode).toBeNull()
  })

  it('the daily window rolls too, independently of the hourly one', async () => {
    const user = await makeUser()
    const wallets = service()
    const holder = userRef(user.id)
    await seedCaps({ capPerHour: 100_000, capPerDay: 500 })

    await wallets.credit({
      holder,
      asset: 'COIN',
      amount: 500,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'day-full',
    })
    expect(
      (
        await wallets.credit({
          holder,
          asset: 'COIN',
          amount: 100,
          kind: 'MATCH_REWARD',
          idempotencyKey: 'day-blocked',
        })
      ).capCode,
    ).toBe('CAP_PER_DAY')

    await backdate('day-full', DAY_MS + 60_000)
    expect(
      (
        await wallets.credit({
          holder,
          asset: 'COIN',
          amount: 100,
          kind: 'MATCH_REWARD',
          idempotencyKey: 'day-allowed',
        })
      ).credited,
    ).toBe(100)
  })

  it('★ a guest credit lands on a PROVISIONAL wallet the guest cannot spend', async () => {
    const table = await makeTable()
    const guest = await makeGuest(table.id)
    const wallets = service()

    const result = await wallets.credit({
      holder: guestRef(guest.id),
      asset: 'COIN',
      amount: 120,
      kind: 'MATCH_REWARD',
      idempotencyKey: matchRewardKey('mr_guest', 0),
    })

    expect(result.credited).toBe(120)
    const row = await db.wallet.findFirstOrThrow({ where: { guestSessionId: guest.id } })
    expect(row.status).toBe('PROVISIONAL')
    expect(row.balance).toBe(120)
    // No user wallet was invented on the way: a guest holds COIN only, and it
    // belongs to the session (10 §2.2).
    expect(row.userId).toBeNull()
    expect(await db.wallet.count({ where: { guestSessionId: guest.id } })).toBe(1)
  })

  it('a CAP_REJECTED row survives in the statement as the audit of a lost reward', async () => {
    const user = await makeUser()
    const wallets = service()
    const holder = userRef(user.id)
    await seedCaps({ capPerHour: 10 })

    await wallets.credit({
      holder,
      asset: 'COIN',
      amount: 10,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'paid',
    })
    await wallets.credit({
      holder,
      asset: 'COIN',
      amount: 90,
      kind: 'MATCH_REWARD',
      idempotencyKey: matchRewardKey('mr_lost', 3),
    })

    const rejected = await db.walletTransaction.findFirstOrThrow({
      where: { kind: 'CAP_REJECTED' },
    })
    expect(rejected.amount).toBe(0)
    expect(rejected.reason).toBe('CAP_PER_HOUR:90')
    expect(rejected.balanceAfter).toBe(10)
    // The reason is a machine code, not a sentence: it renders in fa without a
    // round-trip through the server (02 §8.1).
    expect(rejected.reason).not.toMatch(/[a-z]{3} /)
  })
})
