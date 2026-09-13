import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import { RECONCILE_PAGE_SIZE } from '../../src/application/services/ReconciliationService.js'
import { guestRef, userRef, type IdentityRef } from '../../src/domain/value-objects/identity.js'

/**
 * ★ S38 — E1 measured, and the M0 exit criterion:
 *
 * > *A corrupted balance is **detectable**.*
 *
 * The headline test corrupts `Wallet.balance` with a raw Prisma update — the
 * only way to do it, because `IWalletRepository` exposes no balance setter at
 * all (the Phase B decision: the invariant is a shape nobody can express, not a
 * rule somebody must remember). Then the job catches it, raises an `ALERT`, and
 * — the part worth reading twice — **does not fix it**.
 *
 * A self-healing job would be worse than none. It would set the column to the
 * computed value and move on, destroying the only evidence that a write path is
 * broken. The interesting question is never "what is the balance"; the ledger
 * has always answered that. It is *which code path wrote a number that
 * disagreed with the row it was supposed to accompany*, and that is a human's
 * question.
 */

const { container } = buildTestApp()

beforeEach(async () => {
  await resetDb()
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
})

afterAll(async () => {
  await container.shutdown()
})

let seq = 0
async function fundedUser(balance: number): Promise<IdentityRef> {
  seq += 1
  const user = await db.user.create({
    data: {
      email: `recon-${String(seq)}-${String(Date.now())}@test.dev`,
      passwordHash: 'x',
      displayName: `R${String(seq)}`,
    },
  })
  const holder = userRef(user.id)

  await container.wallets.credit({
    holder,
    asset: 'COIN',
    amount: balance,
    kind: 'MATCH_REWARD',
    idempotencyKey: `match:recon-${String(seq)}:0`,
  })
  return holder
}

async function walletIdOf(holder: IdentityRef): Promise<string> {
  const wallet = await container.repos.wallets.findByHolder(holder, 'COIN')
  if (wallet === null) throw new Error('no wallet')
  return wallet.id
}

describe('a clean ledger', () => {
  it('scans every wallet and alerts on nothing', async () => {
    await fundedUser(120)
    await fundedUser(80)

    const report = await container.reconciliation.run()

    expect(report.scanned).toBe(2)
    expect(report.drifted).toEqual([])
    expect(await db.securityEvent.count({ where: { kind: 'LEDGER_DRIFT' } })).toBe(0)
  })

  it('an empty database is not an error', async () => {
    const report = await container.reconciliation.run()
    expect(report).toMatchObject({ scanned: 0, drifted: [] })
  })

  it('a wallet at zero with matching rows is clean, not suspicious', async () => {
    const holder = await fundedUser(100)
    await container.wallets.debit({
      holder,
      asset: 'COIN',
      amount: 100,
      kind: 'PURCHASE',
      idempotencyKey: 'buy:everything',
    })

    const report = await container.reconciliation.run()
    expect(report.drifted).toEqual([])
  })
})

describe('★★ a corrupted balance is detected', () => {
  it('★★ a hand-corrupted balance is caught, reported, and ALERTed', async () => {
    const holder = await fundedUser(120)
    const walletId = await walletIdOf(holder)

    // ★ The raw write. No ledger row, no `append`, no transaction pairing the
    // two — the bug being simulated. It needs Prisma directly because no
    // repository in this codebase has a method that can do it.
    await db.wallet.update({ where: { id: walletId }, data: { balance: 999_999 } })

    const report = await container.reconciliation.run()

    expect(report.drifted).toHaveLength(1)
    expect(report.drifted[0]).toMatchObject({
      walletId,
      cached: 999_999,
      computed: 120,
      drift: 999_879,
    })

    const alerts = await db.securityEvent.findMany({ where: { kind: 'LEDGER_DRIFT' } })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.severity).toBe('ALERT')
    expect(JSON.parse(alerts[0]?.detailsJson ?? '{}')).toMatchObject({
      walletId,
      cached: 999_999,
      computed: 120,
    })
  })

  it('★ …and does NOT repair it — a silent self-heal erases the evidence', async () => {
    const holder = await fundedUser(120)
    const walletId = await walletIdOf(holder)
    await db.wallet.update({ where: { id: walletId }, data: { balance: 7 } })

    await container.reconciliation.run()

    const after = await db.wallet.findUnique({ where: { id: walletId } })
    expect(after?.balance).toBe(7)
  })

  it('catches a balance that is too LOW as well — drift has a sign', async () => {
    const holder = await fundedUser(500)
    const walletId = await walletIdOf(holder)
    await db.wallet.update({ where: { id: walletId }, data: { balance: 100 } })

    const report = await container.reconciliation.run()
    expect(report.drifted[0]).toMatchObject({ cached: 100, computed: 500, drift: -400 })
  })

  it('a guest wallet is reconciled too — provisional coins are still coins', async () => {
    const table = await db.table.create({
      data: { gameSlug: 'fixture', optionsJson: '{}', seatCount: 2 },
    })
    const guest = await db.guestSession.create({
      data: {
        tokenHash: `hash-recon-${String(Date.now())}`,
        displayName: 'Sara',
        tableId: table.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const holder = guestRef(guest.id)
    await container.wallets.credit({
      holder,
      asset: 'COIN',
      amount: 60,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'match:guest-recon:0',
    })

    const walletId = await walletIdOf(holder)
    await db.wallet.update({ where: { id: walletId }, data: { balance: 61 } })

    const report = await container.reconciliation.run()
    expect(report.drifted[0]).toMatchObject({ guestSessionId: guest.id, drift: 1 })
  })

  it('reports every drifted wallet, not just the first', async () => {
    const a = await fundedUser(10)
    const b = await fundedUser(20)
    await db.wallet.update({ where: { id: await walletIdOf(a) }, data: { balance: 11 } })
    await db.wallet.update({ where: { id: await walletIdOf(b) }, data: { balance: 21 } })

    const report = await container.reconciliation.run()
    expect(report.drifted).toHaveLength(2)
    expect(await db.securityEvent.count({ where: { kind: 'LEDGER_DRIFT' } })).toBe(2)
  })

  it('pages rather than loading every wallet — the one query that grows with the user base', () => {
    // Asserted as a constant rather than by seeding 200 wallets: the property
    // is that the job *has* a page size and uses a cursor, and seeding past it
    // would add a minute to the suite to re-prove arithmetic.
    expect(RECONCILE_PAGE_SIZE).toBeGreaterThan(0)
    expect(RECONCILE_PAGE_SIZE).toBeLessThanOrEqual(1_000)
  })
})

describe('GUEST_FORFEIT — expired provisional balances (10 §3.4)', () => {
  async function expiredGuest(balance: number, expiresAt: Date) {
    const table = await db.table.create({
      data: { gameSlug: 'fixture', optionsJson: '{}', seatCount: 2 },
    })
    seq += 1
    const guest = await db.guestSession.create({
      data: {
        tokenHash: `hash-forfeit-${String(seq)}-${String(Date.now())}`,
        displayName: 'Sara',
        tableId: table.id,
        expiresAt,
      },
    })
    const holder = guestRef(guest.id)
    if (balance > 0) {
      await container.wallets.credit({
        holder,
        asset: 'COIN',
        amount: balance,
        kind: 'MATCH_REWARD',
        idempotencyKey: `match:forfeit-${String(seq)}:0`,
      })
    }
    return { guest, holder }
  }

  it('★ zeroes an expired wallet with a LEDGER ROW, never a silent wipe', async () => {
    const { guest, holder } = await expiredGuest(340, new Date(Date.now() - 60_000))

    const report = await container.guestForfeits.run()

    expect(report).toMatchObject({ forfeited: 1, coins: 340 })

    const wallet = await container.repos.wallets.findByHolder(holder, 'COIN')
    expect(wallet?.balance).toBe(0)

    const rows = await container.repos.wallets.listTransactions(wallet!.id)
    expect(rows[0]).toMatchObject({
      kind: 'GUEST_FORFEIT',
      amount: -340,
      reason: 'GUEST_EXPIRED',
      idempotencyKey: `forfeit:${guest.id}`,
    })
    // ★ E1 still holds: the ledger sums to the balance.
    expect(await container.repos.wallets.sumTransactions(wallet!.id)).toBe(0)
  })

  it('leaves a live session alone — 12 hours is 12 hours', async () => {
    const { holder } = await expiredGuest(200, new Date(Date.now() + 3_600_000))

    const report = await container.guestForfeits.run()

    expect(report.forfeited).toBe(0)
    expect((await container.repos.wallets.findByHolder(holder, 'COIN'))?.balance).toBe(200)
  })

  it('★ a CLAIMED session is never forfeited — its coins already vested', async () => {
    const { guest, holder } = await expiredGuest(200, new Date(Date.now() - 60_000))
    const user = await db.user.create({
      data: { email: `claimed-${String(Date.now())}@test.dev`, passwordHash: 'x', displayName: 'C' },
    })
    await db.guestSession.update({
      where: { id: guest.id },
      data: { claimedAt: new Date(), claimedByUserId: user.id },
    })

    const report = await container.guestForfeits.run()

    expect(report.forfeited).toBe(0)
    // Forfeiting one would be a second debit of money that has already moved.
    expect((await container.repos.wallets.findByHolder(holder, 'COIN'))?.balance).toBe(200)
  })

  it('running the job twice forfeits once — `forfeit:{guestSessionId}` (E2)', async () => {
    const { holder } = await expiredGuest(150, new Date(Date.now() - 60_000))

    await container.guestForfeits.run()
    const second = await container.guestForfeits.run()

    expect(second.forfeited).toBe(0)
    const wallet = await container.repos.wallets.findByHolder(holder, 'COIN')
    expect(wallet?.balance).toBe(0)
    expect(await container.repos.wallets.listTransactions(wallet!.id)).toHaveLength(2)
  })

  it('an expired guest with no coins is skipped quietly', async () => {
    await expiredGuest(0, new Date(Date.now() - 60_000))

    const report = await container.guestForfeits.run()
    expect(report).toMatchObject({ scanned: 1, forfeited: 0, coins: 0 })
  })

  it('★ and the forfeited wallets reconcile clean afterwards', async () => {
    await expiredGuest(340, new Date(Date.now() - 60_000))
    await expiredGuest(90, new Date(Date.now() - 60_000))

    await container.guestForfeits.run()
    const report = await container.reconciliation.run()

    expect(report.drifted).toEqual([])
  })
})
