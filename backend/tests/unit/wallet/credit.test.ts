import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { MetricsRegistry } from '../../../src/application/services/MetricsRegistry.js'
import { WalletService } from '../../../src/application/services/WalletService.js'
import { SPEC_CAP_LIMITS } from '../../../src/domain/economy/caps.js'
import {
  dailyBonusKey,
  guestVestKey,
  matchRewardKey,
} from '../../../src/domain/economy/idempotency.js'
import { ValidationError } from '../../../src/domain/errors/errors.js'
import type { NewRewardRule } from '../../../src/domain/repositories/economy.js'
import { guestRef, holderKey, userRef } from '../../../src/domain/value-objects/identity.js'
import {
  InMemoryUnitOfWork,
  buildInMemoryRepositories,
  type InMemoryRepositories,
} from '../../fakes/index.js'

/**
 * `WalletService.credit` over the in-memory repositories — S21.
 *
 * The fakes are trustworthy here because the same contract suite holds them and
 * the Prisma repositories to identical behaviour
 * (`tests/unit/repositories/contract/economy.test.ts`), which is what lets the
 * *service's* logic be tested at this speed. The properties that need a real
 * transaction — rollback, two racers on one key — are asserted against SQLite
 * in `tests/integration/wallet/`.
 */

const silent = pino({ level: 'silent' })

const globalRule = (patch: Partial<NewRewardRule> = {}): NewRewardRule & { id: string } => ({
  id: '_global',
  gameSlug: null,
  assetCode: 'COIN',
  baseAmount: 0,
  placement: { draw: 1, bySeatCount: {} },
  expectedMinMs: 0,
  repeatDecay: [1, 1, 0.6, 0.3, 0.1],
  capPerHour: SPEC_CAP_LIMITS.perHour,
  capPerDay: SPEC_CAP_LIMITS.perDay,
  capPerDayGuest: SPEC_CAP_LIMITS.perDayGuest,
  capMatchesPerDay: SPEC_CAP_LIMITS.matchesPerDay,
  guestVestCap: SPEC_CAP_LIMITS.guestVestCap,
  active: true,
  ...patch,
})

describe('WalletService.credit', () => {
  let repos: InMemoryRepositories
  let metrics: MetricsRegistry
  let wallets: WalletService

  beforeEach(async () => {
    repos = buildInMemoryRepositories()
    metrics = new MetricsRegistry()
    wallets = new WalletService({
      uow: new InMemoryUnitOfWork(repos),
      repos,
      metrics,
      logger: silent,
    })
    await repos.rewardRules.upsert(globalRule())
  })

  async function aUser(email = 'player@test.dev') {
    return repos.users.create({ email, passwordHash: 'argon2id$x', displayName: 'Player' })
  }

  async function aGuest() {
    const table = await repos.tables.create({ gameSlug: 'fixture', options: {}, seatCount: 4 })
    return repos.guests.create({
      tokenHash: `hash-${Math.random()}`,
      displayName: 'Guest',
      tableId: table.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
  }

  describe('E2 — idempotency', () => {
    it('★ the same idempotency key credits exactly once, and returns the first row', async () => {
      const user = await aUser()
      const input = {
        holder: userRef(user.id),
        asset: 'COIN' as const,
        amount: 80,
        kind: 'MATCH_REWARD' as const,
        idempotencyKey: matchRewardKey('mr_1', 2),
      }

      const first = await wallets.credit(input)
      const replay = await wallets.credit(input)

      expect(first.applied).toBe(true)
      expect(replay.applied).toBe(false)
      // Not a throw and not a second payment: a retried settlement is an
      // ordinary event, and the caller gets the row that already exists.
      expect(replay.transaction.id).toBe(first.transaction.id)
      expect(await wallets.balanceFor(userRef(user.id), 'COIN')).toBe(80)
      expect((await wallets.statement(userRef(user.id), 'COIN')).length).toBe(1)
      expect(metrics.snapshot().counters.wallet_credits_replayed).toBe(1)
    })

    it('the same key on two different holders is two different credits', async () => {
      const [a, b] = [await aUser('a@test.dev'), await aUser('b@test.dev')]
      const key = matchRewardKey('mr_1', 0)

      for (const user of [a, b]) {
        const result = await wallets.credit({
          holder: userRef(user.id),
          asset: 'COIN',
          amount: 25,
          kind: 'MATCH_REWARD',
          idempotencyKey: key,
        })
        expect(result.applied).toBe(true)
      }

      expect(await wallets.balanceFor(userRef(a.id), 'COIN')).toBe(25)
      expect(await wallets.balanceFor(userRef(b.id), 'COIN')).toBe(25)
    })

    it('one asset s key does not block another s', async () => {
      const user = await aUser()
      const key = dailyBonusKey(holderKey(userRef(user.id)), new Date('2026-09-09T08:00:00Z'))

      await wallets.credit({
        holder: userRef(user.id),
        asset: 'COIN',
        amount: 50,
        kind: 'DAILY_BONUS',
        idempotencyKey: key,
      })
      const gems = await wallets.credit({
        holder: userRef(user.id),
        asset: 'GEM',
        amount: 5,
        kind: 'DAILY_BONUS',
        idempotencyKey: key,
      })

      // Uniqueness is per **wallet**, and a wallet is (holder, asset).
      expect(gems.applied).toBe(true)
      expect(await wallets.balanceFor(userRef(user.id), 'GEM')).toBe(5)
    })
  })

  describe('E1 — balance == Σ transactions', () => {
    it('★ holds after a randomized sequence of 500 credits', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      // Deliberately far above the caps, and exempt, so the property under
      // test is the arithmetic rather than the policy.
      let expected = 0

      for (let i = 0; i < 500; i += 1) {
        const amount = 1 + ((i * 37) % 23)
        expected += amount
        await wallets.credit({
          holder,
          asset: 'COIN',
          amount,
          kind: 'ADMIN_ADJUST',
          idempotencyKey: `seq:${i}`,
          reason: 'test',
        })
      }

      const report = await wallets.recompute(holder, 'COIN')
      expect(report?.cached).toBe(expected)
      expect(report?.computed).toBe(expected)
      expect(report?.drift).toBe(0)
    })

    it('balanceAfter on each row is the running total', async () => {
      const user = await aUser()
      const holder = userRef(user.id)

      for (const [i, amount] of [40, 25, 35].entries()) {
        await wallets.credit({
          holder,
          asset: 'COIN',
          amount,
          kind: 'ADMIN_ADJUST',
          idempotencyKey: `k${i}`,
        })
      }

      const statement = await wallets.statement(holder, 'COIN')
      // Newest first.
      expect(statement.map((t) => t.balanceAfter)).toEqual([100, 65, 40])
    })

    it('recompute reports drift rather than silently repairing it', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 100,
        kind: 'ADMIN_ADJUST',
        idempotencyKey: 'k',
      })

      // Corrupt the cached column the way only a bug could.
      const wallet = await repos.wallets.findByHolder(holder, 'COIN')
      repos.wallets.rows.patch(wallet!.id, { balance: 7 })

      const report = await wallets.recompute(holder, 'COIN')
      expect(report).toEqual({
        walletId: wallet!.id,
        cached: 7,
        computed: 100,
        drift: -93,
      })
      // Still 7: a self-heal here would hide the write path that lied, which
      // is the only interesting question (S38 raises an ALERT instead).
      expect(await wallets.balanceFor(holder, 'COIN')).toBe(7)
    })

    it('a holder with no wallet reads as zero and nothing is created', async () => {
      const user = await aUser()
      expect(await wallets.balanceFor(userRef(user.id), 'TICKET')).toBe(0)
      expect(await wallets.recompute(userRef(user.id), 'TICKET')).toBeNull()
      expect(await repos.wallets.findByHolder(userRef(user.id), 'TICKET')).toBeNull()
    })
  })

  describe('E7 — caps', () => {
    it('★ a fully capped reward writes a zero-amount CAP_REJECTED row, never silence', async () => {
      const user = await aUser()
      const holder = userRef(user.id)

      // Spend the hourly budget first.
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 400,
        kind: 'MATCH_REWARD',
        idempotencyKey: matchRewardKey('mr_0', 0),
      })

      const capped = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 120,
        kind: 'MATCH_REWARD',
        idempotencyKey: matchRewardKey('mr_1', 0),
      })

      expect(capped.credited).toBe(0)
      expect(capped.requested).toBe(120)
      expect(capped.capCode).toBe('CAP_PER_HOUR')
      expect(capped.transaction.kind).toBe('CAP_REJECTED')
      expect(capped.transaction.amount).toBe(0)
      // The reason answers "why did I get nothing?" from the row alone.
      expect(capped.transaction.reason).toBe('CAP_PER_HOUR:120')
      expect(await wallets.balanceFor(holder, 'COIN')).toBe(400)
      // And it is *visible* in the statement, which is the point.
      expect((await wallets.statement(holder, 'COIN')).map((t) => t.kind)).toEqual([
        'CAP_REJECTED',
        'MATCH_REWARD',
      ])
      expect(metrics.snapshot().counters.wallet_caps_rejected).toBe(1)
    })

    it('a partial cap credits what fits and records the cap on the paying row', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 370,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'a',
      })

      const partial = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 100,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'b',
      })

      expect(partial.credited).toBe(30)
      expect(partial.transaction.amount).toBe(30)
      expect(partial.transaction.kind).toBe('MATCH_REWARD')
      expect(partial.transaction.reason).toBe('CAP_PER_HOUR:100')
      expect(await wallets.balanceFor(holder, 'COIN')).toBe(400)
    })

    it('★ a replayed capped reward stays capped — it does not pay later', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      const key = matchRewardKey('mr_9', 1)
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 400,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'spent',
      })
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 90,
        kind: 'MATCH_REWARD',
        idempotencyKey: key,
      })

      const replay = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 90,
        kind: 'MATCH_REWARD',
        idempotencyKey: key,
      })

      // The CAP_REJECTED row holds the key, so the retry finds it. A capped
      // reward is a settled fact, not a pending one (10 §3.7).
      expect(replay.applied).toBe(false)
      expect(replay.credited).toBe(0)
      expect(replay.capCode).toBe('CAP_PER_HOUR')
      expect(await wallets.balanceFor(holder, 'COIN')).toBe(400)
    })

    it('the matches-per-day cap stops rewards but not the daily bonus', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      await repos.rewardRules.upsert(globalRule({ capMatchesPerDay: 2, capPerHour: 100_000 }))

      for (const i of [0, 1]) {
        const paid = await wallets.credit({
          holder,
          asset: 'COIN',
          amount: 10,
          kind: 'MATCH_REWARD',
          idempotencyKey: matchRewardKey(`mr_${i}`, 0),
        })
        expect(paid.credited).toBe(10)
      }

      const third = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 10,
        kind: 'MATCH_REWARD',
        idempotencyKey: matchRewardKey('mr_2', 0),
      })
      expect(third.capCode).toBe('CAP_MATCHES_PER_DAY')

      const bonus = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 50,
        kind: 'DAILY_BONUS',
        idempotencyKey: dailyBonusKey(holderKey(holder), new Date()),
      })
      // "Rewards stop; play continues normally" (10 §3.7).
      expect(bonus.credited).toBe(50)
    })

    it('★ a guest is capped tighter than a user, and lands on a PROVISIONAL wallet', async () => {
      const guest = await aGuest()
      const holder = guestRef(guest.id)
      await repos.rewardRules.upsert(globalRule({ capPerHour: 100_000 }))

      const first = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 450,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'g1',
      })
      const second = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 200,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'g2',
      })

      expect(first.credited).toBe(450)
      expect(first.wallet.status).toBe('PROVISIONAL')
      expect(second.credited).toBe(50)
      expect(second.capCode).toBe('CAP_PER_DAY_GUEST')
    })

    it('exempt kinds skip the caps entirely', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 400,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'spent',
      })

      const vest = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 500,
        kind: 'GUEST_VEST',
        idempotencyKey: guestVestKey('gst_1'),
      })

      // GUEST_VEST moves coins that were already earned under a cap; charging
      // them again would mean a guest could not keep their own balance.
      expect(vest.credited).toBe(500)
      expect(vest.capCode).toBeNull()
    })

    it('reads the caps from the _global row, so a rebalance is a row update', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      await repos.rewardRules.upsert(globalRule({ capPerHour: 25 }))

      const result = await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 100,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'k',
      })
      expect(result.credited).toBe(25)
    })

    it('falls back to the spec caps when the _global row is missing', async () => {
      const fresh = buildInMemoryRepositories()
      const service = new WalletService({
        uow: new InMemoryUnitOfWork(fresh),
        repos: fresh,
        metrics,
        logger: silent,
      })
      const user = await fresh.users.create({
        email: 'unseeded@test.dev',
        passwordHash: 'x',
        displayName: 'Player',
      })

      const result = await service.credit({
        holder: userRef(user.id),
        asset: 'COIN',
        amount: 900,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'k',
      })
      // 400/hour from 10 §3.7 — an unseeded database must not mean no caps.
      expect(result.credited).toBe(400)
    })
  })

  describe('the boundary (P7)', () => {
    it('refuses a negative amount — that is the debit path', async () => {
      const user = await aUser()
      await expect(
        wallets.credit({
          holder: userRef(user.id),
          asset: 'COIN',
          amount: -50,
          kind: 'PURCHASE',
          idempotencyKey: 'k',
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('refuses a fractional amount — a formula bug, not a rounding decision', async () => {
      const user = await aUser()
      await expect(
        wallets.credit({
          holder: userRef(user.id),
          asset: 'COIN',
          amount: 12.5,
          kind: 'MATCH_REWARD',
          idempotencyKey: 'k',
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('refuses an empty idempotency key', async () => {
      const user = await aUser()
      await expect(
        wallets.credit({
          holder: userRef(user.id),
          asset: 'COIN',
          amount: 10,
          kind: 'MATCH_REWARD',
          idempotencyKey: '',
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('a zero credit is allowed and audited, because a reward can legitimately be zero', async () => {
      const user = await aUser()
      const result = await wallets.credit({
        holder: userRef(user.id),
        asset: 'COIN',
        amount: 0,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'k',
        reason: 'EJECTED_FORFEIT',
      })

      // An ejected player's settlement row (10 §5.2): zero coins, and a row
      // saying so. This is the shape S36 writes for a forfeited seat.
      expect(result.transaction.kind).toBe('CAP_REJECTED')
      expect(result.transaction.amount).toBe(0)
      expect(result.transaction.reason).toBe('EJECTED_FORFEIT')
    })
  })

  describe('balances', () => {
    it('reports every wallet the holder actually owns', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      await repos.wallets.ensure(holder, 'COIN')
      await repos.wallets.ensure(holder, 'GEM')

      const balances = await wallets.balances(holder, ['COIN', 'GEM', 'TICKET'])
      expect(balances.map((b) => b.asset)).toEqual(['COIN', 'GEM'])
      expect(balances[0]?.status).toBe('VESTED')
    })

    it('tracks lifetime totals alongside the balance', async () => {
      const user = await aUser()
      const holder = userRef(user.id)
      await wallets.credit({
        holder,
        asset: 'COIN',
        amount: 100,
        kind: 'ADMIN_ADJUST',
        idempotencyKey: 'k',
      })

      const [coin] = await wallets.balances(holder, ['COIN'])
      expect(coin?.lifetimeEarned).toBe(100)
      expect(coin?.lifetimeSpent).toBe(0)
    })
  })
})
