import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import { ADMIN_ADJUST_REASON_MIN } from '../../src/application/services/WalletService.js'
import { guestRef, userRef, type IdentityRef } from '../../src/domain/value-objects/identity.js'

/**
 * ★ S38 — the debit path. 10 §2.5, and the one place money leaves a wallet.
 *
 * Three properties, in order of how expensive getting them wrong would be:
 *
 *   1. **Two concurrent debits with one item's worth of coins produce exactly
 *      one debit.** This is the real double-spend, and it is why
 *      `balanceForUpdate` exists. It is also the only test in the file that
 *      genuinely needs a database — an in-memory fake has no second writer to
 *      race, so the property cannot be asserted against one.
 *   2. **Insufficient funds leaves no partial debit.** Not "rolls back" — there
 *      is nothing to roll back, because the check happens before the write.
 *   3. **Guests cannot spend.** The refusal that stops a farmed provisional
 *      balance from being converted into anything before signup.
 */

const { container } = buildTestApp()

beforeEach(async () => {
  await resetDb()
  await seedCaps()
})

afterAll(async () => {
  await container.shutdown()
})

async function seedCaps(): Promise<void> {
  await db.rewardRule.create({
    data: {
      id: '_global',
      gameSlug: null,
      assetCode: 'COIN',
      baseAmount: 0,
      placementJson: JSON.stringify({ draw: 1, bySeatCount: {} }),
      expectedMinMs: 0,
      repeatDecayJson: JSON.stringify([1]),
      capPerHour: 100_000,
      capPerDay: 100_000,
      capPerDayGuest: 100_000,
      capMatchesPerDay: 1_000,
      guestVestCap: 500,
    },
  })
}

let seq = 0
async function fundedUser(balance: number): Promise<IdentityRef> {
  seq += 1
  const user = await db.user.create({
    data: {
      email: `spender-${String(seq)}-${String(Date.now())}@test.dev`,
      passwordHash: 'x',
      displayName: `S${String(seq)}`,
    },
  })
  const holder = userRef(user.id)

  if (balance > 0) {
    await container.wallets.credit({
      holder,
      asset: 'COIN',
      amount: balance,
      kind: 'ADMIN_ADJUST',
      idempotencyKey: `admin:seed-${String(seq)}`,
      reason: 'ADMIN_ADJUST:test setup',
    })
  }
  return holder
}

async function balanceOf(holder: IdentityRef): Promise<number> {
  return (await container.repos.wallets.findByHolder(holder, 'COIN'))?.balance ?? 0
}

async function ledgerSum(holder: IdentityRef): Promise<number> {
  const wallet = await container.repos.wallets.findByHolder(holder, 'COIN')
  if (wallet === null) return 0
  return container.repos.wallets.sumTransactions(wallet.id)
}

describe('★ the double-spend', () => {
  it('★★ two concurrent debits, one item’s worth of coins ⇒ exactly one succeeds', async () => {
    const holder = await fundedUser(500)

    const outcomes = await Promise.allSettled([
      container.wallets.debit({
        holder,
        asset: 'COIN',
        amount: 500,
        kind: 'PURCHASE',
        idempotencyKey: 'buy:item-a',
      }),
      container.wallets.debit({
        holder,
        asset: 'COIN',
        amount: 500,
        kind: 'PURCHASE',
        idempotencyKey: 'buy:item-b',
      }),
    ])

    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    expect(won).toHaveLength(1)

    // ★ And the balance proves it: 500 in, 500 out, nothing over-spent.
    expect(await balanceOf(holder)).toBe(0)
    expect(await ledgerSum(holder)).toBe(0)
  })

  it('ten concurrent debits against a balance for three: three succeed, seven refuse', async () => {
    const holder = await fundedUser(300)

    const attempts = Array.from({ length: 10 }, (_, index) =>
      container.wallets.debit({
        holder,
        asset: 'COIN',
        amount: 100,
        kind: 'PURCHASE',
        idempotencyKey: `buy:many-${String(index)}`,
      }),
    )
    const outcomes = await Promise.allSettled(attempts)

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(3)
    expect(await balanceOf(holder)).toBe(0)
    // E1 holds throughout: the cached column and the ledger agree.
    expect(await ledgerSum(holder)).toBe(0)
  })
})

describe('refusals', () => {
  it('★ insufficient funds throws INSUFFICIENT_FUNDS and leaves NO partial debit', async () => {
    const holder = await fundedUser(40)

    await expect(
      container.wallets.debit({
        holder,
        asset: 'COIN',
        amount: 100,
        kind: 'PURCHASE',
        idempotencyKey: 'buy:too-dear',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' })

    expect(await balanceOf(holder)).toBe(40)
    // One row: the seeding credit. The refused purchase wrote nothing at all.
    const wallet = await container.repos.wallets.findByHolder(holder, 'COIN')
    expect(await container.repos.wallets.listTransactions(wallet!.id)).toHaveLength(1)
  })

  it('★ a guest cannot spend — 403, not a balance problem (10 §2.2)', async () => {
    const table = await db.table.create({
      data: { gameSlug: 'fixture', optionsJson: '{}', seatCount: 2 },
    })
    const guest = await db.guestSession.create({
      data: {
        tokenHash: `hash-spend-${String(Date.now())}`,
        displayName: 'Sara',
        tableId: table.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const holder = guestRef(guest.id)

    await container.wallets.credit({
      holder,
      asset: 'COIN',
      amount: 400,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'match:guest:0',
    })

    await expect(
      container.wallets.debit({
        holder,
        asset: 'COIN',
        amount: 100,
        kind: 'PURCHASE',
        idempotencyKey: 'buy:guest-attempt',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // ★ The coins are untouched. There is no way to convert a farmed
    // provisional balance into anything before signing up.
    expect(await balanceOf(holder)).toBe(400)
  })

  it('a fractional or negative amount is a ValidationError, never a coercion', async () => {
    const holder = await fundedUser(500)

    for (const amount of [0, -10, 12.5]) {
      await expect(
        container.wallets.debit({
          holder,
          asset: 'COIN',
          amount,
          kind: 'PURCHASE',
          idempotencyKey: `buy:bad-${String(amount)}`,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    expect(await balanceOf(holder)).toBe(500)
  })
})

describe('idempotency, on the way out as well as in', () => {
  it('the same purchase key charges once and returns the original row', async () => {
    const holder = await fundedUser(500)

    const first = await container.wallets.debit({
      holder,
      asset: 'COIN',
      amount: 200,
      kind: 'PURCHASE',
      idempotencyKey: 'buy:felt-marble',
    })
    const second = await container.wallets.debit({
      holder,
      asset: 'COIN',
      amount: 200,
      kind: 'PURCHASE',
      idempotencyKey: 'buy:felt-marble',
    })

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.transaction.id).toBe(first.transaction.id)
    expect(await balanceOf(holder)).toBe(300)
  })
})

describe('ADMIN_ADJUST — 12 §7.2', () => {
  it('★ refuses without a written reason: the reason is a rule, not a placeholder', async () => {
    const holder = await fundedUser(0)

    for (const reason of ['', '   ', 'x'.repeat(ADMIN_ADJUST_REASON_MIN - 1)]) {
      await expect(
        container.wallets.adminAdjust({
          holder,
          asset: 'COIN',
          amount: 100,
          reason,
          auditLogId: `audit-${String(Date.now())}`,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    expect(await balanceOf(holder)).toBe(0)
  })

  it('credits with the reason on the row, keyed by the audit entry that authorised it', async () => {
    const holder = await fundedUser(0)

    const result = await container.wallets.adminAdjust({
      holder,
      asset: 'COIN',
      amount: 250,
      reason: 'refund for the 12 Sep outage',
      auditLogId: 'audit-42',
    })

    expect(result.transaction).toMatchObject({
      kind: 'ADMIN_ADJUST',
      amount: 250,
      // ★ `admin:{auditLogId}` (10 §2.4): the money and the accountability for
      // it cannot exist apart.
      idempotencyKey: 'admin:audit-42',
      reason: 'ADMIN_ADJUST:refund for the 12 Sep outage',
    })
    expect(await balanceOf(holder)).toBe(250)
  })

  it('retrying one audit entry adjusts once', async () => {
    const holder = await fundedUser(0)
    const input = {
      holder,
      asset: 'COIN' as const,
      amount: 250,
      reason: 'one correction',
      auditLogId: 'audit-once',
    }

    await container.wallets.adminAdjust(input)
    await container.wallets.adminAdjust(input)

    expect(await balanceOf(holder)).toBe(250)
  })

  it('★ claws back past zero when it must — the ledger stays true, the balance goes negative', async () => {
    const holder = await fundedUser(100)

    await container.wallets.adminAdjust({
      holder,
      asset: 'COIN',
      amount: -300,
      reason: 'reversing an erroneous grant',
      auditLogId: 'audit-clawback',
    })

    // Overdrawn and *visible* as such. Refusing would have left the erroneous
    // coins in place because the holder had already spent some of them.
    expect(await balanceOf(holder)).toBe(-200)
    expect(await ledgerSum(holder)).toBe(-200)
  })
})
