import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { REPO_HARNESSES } from '../../../harnesses.js'
import type { TransactionKind } from '../../../../src/contracts/enums.js'
import type { RewardRule } from '../../../../src/domain/entities/economy.js'
import type { CosmeticItem } from '../../../../src/domain/entities/user.js'
import type { NewRewardRule } from '../../../../src/domain/repositories/economy.js'
import { guestRef, userRef } from '../../../../src/domain/value-objects/identity.js'
import { makeGuest, makeTable, makeUser } from '../fixtures.js'

/** Every row ever written is inside a window that starts here. */
const EPOCH = new Date(0)

const rule = (overrides: Partial<RewardRule> & { id: string }): NewRewardRule & { id: string } => ({
  gameSlug: overrides.id.split(':')[0] ?? overrides.id,
  assetCode: 'COIN',
  baseAmount: 50,
  placement: { draw: 1, bySeatCount: {} },
  expectedMinMs: 0,
  repeatDecay: [1, 1, 0.6, 0.3, 0.1],
  capPerHour: 400,
  capPerDay: 2_000,
  capPerDayGuest: 500,
  capMatchesPerDay: 30,
  guestVestCap: 500,
  active: true,
  ...overrides,
})

const item = (overrides: Partial<CosmeticItem> & { id: string }): CosmeticItem => ({
  category: 'CARD_BACK',
  nameKey: 'cosmetics.back.default',
  assetRef: 'backs/default.svg',
  unlockKind: 'DEFAULT',
  unlockParams: null,
  gameSlug: null,
  sortOrder: 0,
  active: true,
  externalRef: null,
  transferable: false,
  ...overrides,
})

describe.each(REPO_HARNESSES)('[$name] economy repositories', (harness) => {
  beforeEach(async () => {
    await harness.reset()
  })
  afterAll(async () => {
    await harness.dispose()
  })

  describe('IWalletRepository — E1 and E2', () => {
    it('creates a user wallet VESTED and a guest wallet PROVISIONAL', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)

      expect((await repos.wallets.ensure(userRef(user.id), 'COIN')).status).toBe('VESTED')
      expect((await repos.wallets.ensure(guestRef(guest.id), 'COIN')).status).toBe('PROVISIONAL')
    })

    it('ensure is idempotent — one wallet per holder per asset', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)

      const first = await repos.wallets.ensure(userRef(user.id), 'COIN')
      const second = await repos.wallets.ensure(userRef(user.id), 'COIN')
      const gems = await repos.wallets.ensure(userRef(user.id), 'GEM')

      expect(second.id).toBe(first.id)
      expect(second.balance).toBe(0)
      expect(gems.id).not.toBe(first.id)
    })

    it('finds by holder and misses for a holder with no wallet', async () => {
      const repos = harness.repos()
      const [a, b] = [await makeUser(repos), await makeUser(repos)]
      const wallet = await repos.wallets.ensure(userRef(a.id), 'COIN')

      expect((await repos.wallets.findByHolder(userRef(a.id), 'COIN'))?.id).toBe(wallet.id)
      expect(await repos.wallets.findByHolder(userRef(b.id), 'COIN')).toBeNull()
      expect(await repos.wallets.findByHolder(userRef(a.id), 'TICKET')).toBeNull()
    })

    it('★ a credit writes the ledger row and the cached balance together', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')

      const result = await repos.wallets.append({
        walletId: wallet.id,
        amount: 80,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'MATCH_REWARD:match-1:user:x',
        refKind: 'matchResult',
        refId: 'match-1',
      })

      expect(result.applied).toBe(true)
      expect(result.transaction.balanceAfter).toBe(80)
      expect(result.wallet.balance).toBe(80)
      expect(result.wallet.lifetimeEarned).toBe(80)
      expect(result.wallet.lifetimeSpent).toBe(0)
      // The truth, recomputed the way reconciliation will.
      expect(await repos.wallets.sumTransactions(wallet.id)).toBe(80)
    })

    it('★ replaying an idempotency key pays nothing a second time', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')
      const entry = {
        walletId: wallet.id,
        amount: 50,
        kind: 'MATCH_REWARD' as const,
        idempotencyKey: 'MATCH_REWARD:match-1:user:x',
      }

      const first = await repos.wallets.append(entry)
      const replay = await repos.wallets.append(entry)

      expect(first.applied).toBe(true)
      expect(replay.applied).toBe(false)
      expect(replay.transaction.id).toBe(first.transaction.id)
      expect(replay.wallet.balance).toBe(50)
      expect(await repos.wallets.listTransactions(wallet.id)).toHaveLength(1)
    })

    it('the same key on a different wallet is a different credit', async () => {
      const repos = harness.repos()
      const [a, b] = [await makeUser(repos), await makeUser(repos)]
      const walletA = await repos.wallets.ensure(userRef(a.id), 'COIN')
      const walletB = await repos.wallets.ensure(userRef(b.id), 'COIN')
      const key = 'MATCH_REWARD:match-1'

      expect(
        (
          await repos.wallets.append({
            walletId: walletA.id,
            amount: 10,
            kind: 'MATCH_REWARD',
            idempotencyKey: key,
          })
        ).applied,
      ).toBe(true)
      expect(
        (
          await repos.wallets.append({
            walletId: walletB.id,
            amount: 10,
            kind: 'MATCH_REWARD',
            idempotencyKey: key,
          })
        ).applied,
      ).toBe(true)
      expect(await repos.wallets.sumTransactions(walletB.id)).toBe(10)
    })

    it('tracks a debit in lifetimeSpent and lowers the balance', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')

      await repos.wallets.append({
        walletId: wallet.id,
        amount: 100,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'k1',
      })
      const spent = await repos.wallets.append({
        walletId: wallet.id,
        amount: -30,
        kind: 'PURCHASE',
        idempotencyKey: 'k2',
      })

      expect(spent.wallet.balance).toBe(70)
      expect(spent.wallet.lifetimeEarned).toBe(100)
      expect(spent.wallet.lifetimeSpent).toBe(30)
      expect(spent.transaction.balanceAfter).toBe(70)
    })

    it('stores a zero-amount CAP_REJECTED row with its reason — never silence', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')

      const capped = await repos.wallets.append({
        walletId: wallet.id,
        amount: 0,
        kind: 'CAP_REJECTED',
        idempotencyKey: 'MATCH_REWARD:match-9:capped',
        reason: 'daily cap reached',
      })

      expect(capped.applied).toBe(true)
      expect(capped.transaction.amount).toBe(0)
      expect(capped.transaction.reason).toBe('daily cap reached')
      expect(capped.wallet.balance).toBe(0)
      // It is *visible* in the statement, which is the whole point.
      expect(await repos.wallets.listTransactions(wallet.id)).toHaveLength(1)
    })

    it('records balanceAfter as a running total in append order', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')

      const after: number[] = []
      for (const [i, amount] of [40, 25, -15].entries()) {
        const result = await repos.wallets.append({
          walletId: wallet.id,
          amount,
          kind: amount < 0 ? 'PURCHASE' : 'MATCH_REWARD',
          idempotencyKey: `k${i}`,
        })
        after.push(result.transaction.balanceAfter)
      }

      expect(after).toEqual([40, 65, 50])
      expect(await repos.wallets.sumTransactions(wallet.id)).toBe(50)
      expect((await repos.wallets.findById(wallet.id))?.balance).toBe(50)
    })

    it('lists the statement newest first', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')
      for (const i of [1, 2, 3]) {
        await repos.wallets.append({
          walletId: wallet.id,
          amount: i,
          kind: 'DAILY_BONUS',
          idempotencyKey: `k${i}`,
        })
      }

      const page = await repos.wallets.listTransactions(wallet.id, { limit: 2 })
      expect(page).toHaveLength(2)
      expect(page[0]?.amount).toBe(3)
    })

    it('finds a transaction by its derived key', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')
      await repos.wallets.append({
        walletId: wallet.id,
        amount: 5,
        kind: 'ACHIEVEMENT',
        idempotencyKey: 'ACH:first-win',
      })

      expect((await repos.wallets.findTransactionByKey(wallet.id, 'ACH:first-win'))?.amount).toBe(5)
      expect(await repos.wallets.findTransactionByKey(wallet.id, 'nope')).toBeNull()
    })

    it('vests a guest wallet on signup', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const wallet = await repos.wallets.ensure(guestRef(guest.id), 'COIN')

      expect((await repos.wallets.markVested(wallet.id)).status).toBe('VESTED')
    })
  })

  describe('IWalletRepository — the cap windows (E7)', () => {
    async function walletWith(
      repos: ReturnType<typeof harness.repos>,
      rows: Array<{ amount: number; kind: TransactionKind }>,
    ) {
      const user = await makeUser(repos)
      const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')
      for (const [i, row] of rows.entries()) {
        await repos.wallets.append({
          walletId: wallet.id,
          amount: row.amount,
          kind: row.kind,
          idempotencyKey: `window-${i}`,
        })
      }
      return wallet
    }

    const EARNS: readonly TransactionKind[] = [
      'MATCH_REWARD',
      'DAILY_BONUS',
      'ACHIEVEMENT',
      'PREMIUM_GRANT',
    ]

    it('sums only the requested kinds', async () => {
      const repos = harness.repos()
      const wallet = await walletWith(repos, [
        { amount: 100, kind: 'MATCH_REWARD' },
        { amount: 50, kind: 'DAILY_BONUS' },
        { amount: 25, kind: 'ADMIN_ADJUST' },
      ])

      expect(await repos.wallets.sumCreditsSince(wallet.id, EPOCH, EARNS)).toBe(150)
      expect(await repos.wallets.sumCreditsSince(wallet.id, EPOCH, ['MATCH_REWARD'])).toBe(100)
    })

    it('★ ignores debits — spending is not negative earning', async () => {
      const repos = harness.repos()
      const wallet = await walletWith(repos, [
        { amount: 300, kind: 'MATCH_REWARD' },
        { amount: -200, kind: 'PURCHASE' },
      ])

      // If this returned 100, a player could spend their way back under the
      // daily cap and keep earning — the store would be a cap bypass.
      expect(await repos.wallets.sumCreditsSince(wallet.id, EPOCH, EARNS)).toBe(300)
    })

    it('excludes zero-amount CAP_REJECTED rows from both aggregates', async () => {
      const repos = harness.repos()
      const wallet = await walletWith(repos, [
        { amount: 40, kind: 'MATCH_REWARD' },
        { amount: 0, kind: 'CAP_REJECTED' },
      ])

      expect(await repos.wallets.sumCreditsSince(wallet.id, EPOCH, EARNS)).toBe(40)
      // A capped match does not itself consume a match slot.
      expect(await repos.wallets.countCreditsSince(wallet.id, EPOCH, ['MATCH_REWARD'])).toBe(1)
    })

    it('counts match rewards for the matches-per-day cap', async () => {
      const repos = harness.repos()
      const wallet = await walletWith(repos, [
        { amount: 10, kind: 'MATCH_REWARD' },
        { amount: 10, kind: 'MATCH_REWARD' },
        { amount: 50, kind: 'DAILY_BONUS' },
      ])

      expect(await repos.wallets.countCreditsSince(wallet.id, EPOCH, ['MATCH_REWARD'])).toBe(2)
    })

    it('a window that starts in the future sees nothing', async () => {
      const repos = harness.repos()
      const wallet = await walletWith(repos, [{ amount: 90, kind: 'MATCH_REWARD' }])
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)

      expect(await repos.wallets.sumCreditsSince(wallet.id, tomorrow, EARNS)).toBe(0)
      expect(await repos.wallets.countCreditsSince(wallet.id, tomorrow, EARNS)).toBe(0)
    })

    it('is scoped to one wallet', async () => {
      const repos = harness.repos()
      const mine = await walletWith(repos, [{ amount: 70, kind: 'MATCH_REWARD' }])
      await walletWith(repos, [{ amount: 500, kind: 'MATCH_REWARD' }])

      expect(await repos.wallets.sumCreditsSince(mine.id, EPOCH, EARNS)).toBe(70)
    })
  })

  describe('IRewardRuleRepository — the economy as data (10 §3)', () => {
    it('upserts by id, so the seed and the admin console are idempotent', async () => {
      const repos = harness.repos()
      await repos.rewardRules.upsert(rule({ id: 'shelem', baseAmount: 80 }))
      const raised = await repos.rewardRules.upsert(rule({ id: 'shelem', baseAmount: 95 }))

      expect(raised.baseAmount).toBe(95)
      expect(await repos.rewardRules.listActive()).toHaveLength(1)
    })

    it('round-trips the JSON columns as parsed objects', async () => {
      const repos = harness.repos()
      await repos.rewardRules.upsert(
        rule({
          id: 'sudoku',
          placement: { draw: 1, bySeatCount: { '4': { '1': 1.5, '2': 1 } } },
          repeatDecay: [1, 1, 0.6, 0.3, 0.1],
        }),
      )

      const found = await repos.rewardRules.findById('sudoku')
      // The mapper's job: SQLite stores text, the domain sees a shape (03 §1).
      expect(found?.placement.bySeatCount['4']?.['1']).toBe(1.5)
      expect(found?.repeatDecay).toEqual([1, 1, 0.6, 0.3, 0.1])
    })

    it('★ prefers slug:variant over slug, and falls back when it is absent', async () => {
      const repos = harness.repos()
      await repos.rewardRules.upsert(rule({ id: 'chess', baseAmount: 30 }))
      await repos.rewardRules.upsert(rule({ id: 'chess:rapid', baseAmount: 45 }))

      expect((await repos.rewardRules.findForGame('chess', 'rapid'))?.baseAmount).toBe(45)
      expect((await repos.rewardRules.findForGame('chess', 'blitz'))?.baseAmount).toBe(30)
      expect((await repos.rewardRules.findForGame('chess'))?.baseAmount).toBe(30)
      expect(await repos.rewardRules.findForGame('nope')).toBeNull()
    })

    it('finds the _global caps row, and misses cleanly before the seed runs', async () => {
      const repos = harness.repos()
      expect(await repos.rewardRules.findGlobal()).toBeNull()

      await repos.rewardRules.upsert(rule({ id: '_global', gameSlug: null, capPerHour: 400 }))
      expect((await repos.rewardRules.findGlobal())?.capPerHour).toBe(400)
    })

    it('lists only active rules', async () => {
      const repos = harness.repos()
      await repos.rewardRules.upsert(rule({ id: 'poker' }))
      await repos.rewardRules.upsert(rule({ id: 'retired', active: false }))

      expect((await repos.rewardRules.listActive()).map((r) => r.id)).toEqual(['poker'])
    })
  })

  describe('IMatchParticipantRepository — the claim s re-attribution (03 §6.1)', () => {
    it('a guest with no participations rewrites nothing, and does not throw', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const user = await makeUser(repos)

      // The ordinary case: most claims happen mid-hand, before any
      // `MatchResult` exists at all. The populated case needs rows only S36
      // can create, and is asserted against the database in
      // `tests/integration/wallet/guest-claim.test.ts`.
      expect(await repos.participants.reattributeActor(guest.id, user.id)).toBe(0)
      expect(await repos.participants.countByGuest(guest.id)).toBe(0)
      expect(await repos.participants.countByUser(user.id)).toBe(0)
    })
  })

  describe('IChatRepository — the claim s re-attribution (03 §6.1)', () => {
    it('★ the guest s messages become the new user s messages', async () => {
      const repos = harness.repos()
      const table = await makeTable(repos)
      const guest = await makeGuest(repos, table.id)
      const other = await makeGuest(repos, table.id)
      const user = await makeUser(repos)

      const mine = await repos.chat.append({
        tableId: table.id,
        guestSessionId: guest.id,
        body: 'nice trick',
      })
      const theirs = await repos.chat.append({
        tableId: table.id,
        guestSessionId: other.id,
        body: 'thanks',
      })

      expect(await repos.chat.reattributeActor(guest.id, user.id)).toBe(1)

      const rewritten = await repos.chat.findById(mine.id)
      expect(rewritten?.userId).toBe(user.id)
      expect(rewritten?.guestSessionId).toBeNull()
      // Somebody else's message is untouched, which is the whole risk of an
      // `updateMany` with a predicate.
      expect((await repos.chat.findById(theirs.id))?.guestSessionId).toBe(other.id)
    })
  })

  describe('ICosmeticRepository', () => {
    it('upserts the catalog idempotently by slug', async () => {
      const repos = harness.repos()
      await repos.cosmetics.upsertItem(item({ id: 'back-default' }))
      const updated = await repos.cosmetics.upsertItem(
        item({ id: 'back-default', nameKey: 'cosmetics.back.renamed' }),
      )

      expect(updated.nameKey).toBe('cosmetics.back.renamed')
      expect(await repos.cosmetics.listItems()).toHaveLength(1)
    })

    it('filters the catalog by category and active flag', async () => {
      const repos = harness.repos()
      await repos.cosmetics.upsertItem(item({ id: 'back-a', category: 'CARD_BACK' }))
      await repos.cosmetics.upsertItem(item({ id: 'felt-a', category: 'FELT' }))
      await repos.cosmetics.upsertItem(
        item({ id: 'back-old', category: 'CARD_BACK', active: false }),
      )

      expect(await repos.cosmetics.listItems({ category: 'CARD_BACK' })).toHaveLength(2)
      expect(await repos.cosmetics.listItems({ category: 'CARD_BACK', active: true })).toHaveLength(
        1,
      )
      expect(await repos.cosmetics.listItems({ active: false })).toHaveLength(1)
    })

    it('orders the catalog by sortOrder', async () => {
      const repos = harness.repos()
      await repos.cosmetics.upsertItem(item({ id: 'b', sortOrder: 2 }))
      await repos.cosmetics.upsertItem(item({ id: 'a', sortOrder: 1 }))

      expect((await repos.cosmetics.listItems()).map((i) => i.id)).toEqual(['a', 'b'])
    })

    it('unlocks idempotently and reports ownership', async () => {
      const repos = harness.repos()
      const user = await makeUser(repos)
      await repos.cosmetics.upsertItem(item({ id: 'back-default' }))

      const first = await repos.cosmetics.unlock(user.id, 'back-default')
      const again = await repos.cosmetics.unlock(user.id, 'back-default')

      expect(again.id).toBe(first.id)
      expect(await repos.cosmetics.listUnlocked(user.id)).toHaveLength(1)
      expect(await repos.cosmetics.isUnlocked(user.id, 'back-default')).toBe(true)
      expect(await repos.cosmetics.isUnlocked(user.id, 'felt-a')).toBe(false)
    })

    it('keeps unlocks per user', async () => {
      const repos = harness.repos()
      const [a, b] = [await makeUser(repos), await makeUser(repos)]
      await repos.cosmetics.upsertItem(item({ id: 'back-default' }))
      await repos.cosmetics.unlock(a.id, 'back-default')

      expect(await repos.cosmetics.isUnlocked(b.id, 'back-default')).toBe(false)
      expect(await repos.cosmetics.listUnlocked(b.id)).toHaveLength(0)
    })
  })
})
