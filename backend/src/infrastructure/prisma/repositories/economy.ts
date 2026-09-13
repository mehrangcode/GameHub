import type { AssetCode, TransactionKind } from '../../../contracts/enums.js'
import { getEnv } from '../../../config/env.js'
import type { RewardRule, Subscription, Wallet } from '../../../domain/entities/economy.js'
import type { WalletTransaction } from '../../../domain/entities/economy.js'
import type { CosmeticItem, UserCosmetic } from '../../../domain/entities/user.js'
import { GLOBAL_REWARD_RULE_ID } from '../../../domain/economy/caps.js'
import { NotFoundError } from '../../../domain/errors/errors.js'
import type {
  AppendResult,
  CosmeticFilter,
  ICosmeticRepository,
  IRewardRuleRepository,
  ISubscriptionRepository,
  IWalletRepository,
  LedgerEntry,
  NewRewardRule,
  NewSubscription,
} from '../../../domain/repositories/economy.js'
import type { PageQuery } from '../../../domain/repositories/IRepository.js'
import type { IdentityRef } from '../../../domain/value-objects/identity.js'
import { isUniqueViolation } from '../errors.js'
import {
  toCosmeticItem,
  toJson,
  toJsonOrNull,
  toRewardRule,
  toSubscription,
  toUserCosmetic,
  toWallet,
  toWalletTransaction,
} from '../mappers.js'
import { NEWEST_FIRST, PrismaRepositoryBase, cursorArgs } from './base.js'

function holderWhere(holder: IdentityRef, assetCode: AssetCode) {
  return holder.kind === 'user'
    ? { userId_assetCode: { userId: holder.userId, assetCode } }
    : { guestSessionId_assetCode: { guestSessionId: holder.guestSessionId, assetCode } }
}

export class PrismaWalletRepository extends PrismaRepositoryBase implements IWalletRepository {
  async findById(id: string): Promise<Wallet | null> {
    const row = await this.db.wallet.findUnique({ where: { id } })
    return row ? toWallet(row) : null
  }

  async findByHolder(holder: IdentityRef, assetCode: AssetCode): Promise<Wallet | null> {
    const row = await this.db.wallet.findUnique({ where: holderWhere(holder, assetCode) })
    return row ? toWallet(row) : null
  }

  async ensure(holder: IdentityRef, assetCode: AssetCode): Promise<Wallet> {
    const existing = await this.findByHolder(holder, assetCode)
    if (existing) return existing

    const row = await this.nullOnConflict(() =>
      this.db.wallet.create({
        data: {
          assetCode,
          ...(holder.kind === 'user'
            ? { userId: holder.userId, status: 'VESTED' }
            : // A guest accrues but cannot spend until signup vests it (10 §3.4).
              { guestSessionId: holder.guestSessionId, status: 'PROVISIONAL' }),
        },
      }),
    )
    // Lost a create race: the winner's row is the answer.
    if (row === null) {
      const wallet = await this.findByHolder(holder, assetCode)
      if (!wallet) throw new NotFoundError('Wallet')
      return wallet
    }
    return toWallet(row)
  }

  /**
   * ★ E1 and E2, in one indivisible step.
   *
   * The ledger row and the cached balance are written inside one transaction —
   * `balance` is a cache of `Σ amount`, and a path that could update one
   * without the other would make the reconciliation job report drift that is
   * really a bug in this method.
   *
   * The duplicate check is a `catch`, not a pre-read: two settlements of the
   * same match racing each other both pass a `SELECT`, and only the
   * `(walletId, idempotencyKey)` constraint stops the second from paying.
   */
  async append(entry: LedgerEntry): Promise<AppendResult> {
    const existing = await this.findTransactionByKey(entry.walletId, entry.idempotencyKey)
    if (existing) return this.unapplied(existing)

    try {
      return await this.atomically(async (db) => {
        const wallet = await db.wallet.findUnique({ where: { id: entry.walletId } })
        if (!wallet) throw new NotFoundError('Wallet', { id: entry.walletId })

        const balanceAfter = wallet.balance + entry.amount
        const transaction = await db.walletTransaction.create({
          data: {
            walletId: entry.walletId,
            assetCode: wallet.assetCode,
            amount: entry.amount,
            kind: entry.kind,
            idempotencyKey: entry.idempotencyKey,
            reason: entry.reason ?? null,
            refKind: entry.refKind ?? null,
            refId: entry.refId ?? null,
            balanceAfter,
          },
        })
        const updated = await db.wallet.update({
          where: { id: entry.walletId },
          data: {
            balance: balanceAfter,
            lifetimeEarned: { increment: Math.max(0, entry.amount) },
            lifetimeSpent: { increment: Math.max(0, -entry.amount) },
          },
        })

        return {
          transaction: toWalletTransaction(transaction),
          wallet: toWallet(updated),
          applied: true,
        }
      })
    } catch (error) {
      if (!isUniqueViolation(error, 'idempotencyKey')) throw error
      // The race we could not read our way out of. The winner's row stands.
      const winner = await this.findTransactionByKey(entry.walletId, entry.idempotencyKey)
      if (!winner) throw error
      return this.unapplied(winner)
    }
  }

  async findTransactionByKey(
    walletId: string,
    idempotencyKey: string,
  ): Promise<WalletTransaction | null> {
    const row = await this.db.walletTransaction.findUnique({
      where: { walletId_idempotencyKey: { walletId, idempotencyKey } },
    })
    return row ? toWalletTransaction(row) : null
  }

  async listTransactions(walletId: string, page: PageQuery = {}): Promise<WalletTransaction[]> {
    if (
      page.before !== undefined &&
      (await this.db.walletTransaction.count({ where: { id: page.before } })) === 0
    ) {
      return []
    }
    const rows = await this.db.walletTransaction.findMany({
      where: { walletId },
      orderBy: NEWEST_FIRST,
      take: page.limit ?? 25,
      ...cursorArgs(page.before),
    })
    return rows.map(toWalletTransaction)
  }

  async sumTransactions(walletId: string): Promise<number> {
    const result = await this.db.walletTransaction.aggregate({
      where: { walletId },
      _sum: { amount: true },
    })
    return result._sum.amount ?? 0
  }

  async sumCreditsSince(
    walletId: string,
    since: Date,
    kinds: readonly TransactionKind[],
  ): Promise<number> {
    const result = await this.db.walletTransaction.aggregate({
      where: this.creditWindow(walletId, since, kinds),
      _sum: { amount: true },
    })
    return result._sum.amount ?? 0
  }

  async countCreditsSince(
    walletId: string,
    since: Date,
    kinds: readonly TransactionKind[],
  ): Promise<number> {
    return this.db.walletTransaction.count({
      where: this.creditWindow(walletId, since, kinds),
    })
  }

  /**
   * `amount > 0` is the load-bearing clause: a cap window that netted debits
   * against credits would let a player spend their way back under the daily
   * limit and keep earning.
   *
   * `createdAt: { gte }` is a half-open window matching the sliding rate
   * limiter's, so a row exactly on the boundary is counted once, by the newer
   * window.
   */
  private creditWindow(walletId: string, since: Date, kinds: readonly TransactionKind[]) {
    return {
      walletId,
      kind: { in: [...kinds] },
      amount: { gt: 0 },
      createdAt: { gte: since },
    }
  }

  /**
   * ★ 10 §2.5 — the row-locked balance read the debit path needs.
   *
   * `SELECT … FOR UPDATE` on PostgreSQL. On SQLite the raw statement is not
   * supported and is not needed either: the engine serializes writers, so the
   * read-then-write window the lock exists to close does not open in the first
   * place. The **property** — two simultaneous purchases with one item's worth
   * of coins produce exactly one debit — therefore holds on both providers,
   * and `tests/integration/wallet-debit.test.ts` asserts it against whichever
   * one is configured.
   *
   * Only meaningful inside a transaction; outside one the lock is taken and
   * released before the caller can act on the number, which is why the debit
   * path calls it from within `uow.run`.
   */
  async balanceForUpdate(walletId: string): Promise<number> {
    if (getEnv().DATABASE_PROVIDER === 'postgresql') {
      const rows = await this.db.$queryRawUnsafe<{ balance: number | bigint }[]>(
        'SELECT "balance" FROM "Wallet" WHERE "id" = $1 FOR UPDATE',
        walletId,
      )
      const found = rows[0]
      if (found === undefined) throw new NotFoundError('Wallet', { id: walletId })
      return Number(found.balance)
    }

    const wallet = await this.db.wallet.findUnique({ where: { id: walletId } })
    if (wallet === null) throw new NotFoundError('Wallet', { id: walletId })
    return wallet.balance
  }

  async listPaged(afterId: string | null, limit: number): Promise<Wallet[]> {
    const rows = await this.db.wallet.findMany({
      orderBy: { id: 'asc' },
      take: limit,
      ...(afterId === null ? {} : { cursor: { id: afterId }, skip: 1 }),
    })
    return rows.map(toWallet)
  }

  async markVested(walletId: string): Promise<Wallet> {
    return this.mapMissing(
      async () =>
        toWallet(
          await this.db.wallet.update({ where: { id: walletId }, data: { status: 'VESTED' } }),
        ),
      'Wallet',
      walletId,
    )
  }

  private async unapplied(transaction: WalletTransaction): Promise<AppendResult> {
    const wallet = await this.findById(transaction.walletId)
    if (!wallet) throw new NotFoundError('Wallet', { id: transaction.walletId })
    return { transaction, wallet, applied: false }
  }
}

export class PrismaRewardRuleRepository
  extends PrismaRepositoryBase
  implements IRewardRuleRepository
{
  async upsert(rule: NewRewardRule & { id: string }): Promise<RewardRule> {
    const { id, placement, repeatDecay, ...rest } = rule
    const data = {
      ...rest,
      active: rule.active ?? true,
      placementJson: toJson(placement),
      repeatDecayJson: toJson(repeatDecay),
    }
    return toRewardRule(
      await this.db.rewardRule.upsert({ where: { id }, create: { id, ...data }, update: data }),
    )
  }

  async findById(id: string): Promise<RewardRule | null> {
    const row = await this.db.rewardRule.findUnique({ where: { id } })
    return row ? toRewardRule(row) : null
  }

  /**
   * `slug:variant` first, then `slug` (Phase A's decision: `RewardRule.id` is
   * free-form, so a variant needs no schema change). Two reads rather than one
   * `in` query because the *order* is the rule — a variant row overrides its
   * base rather than merging with it.
   */
  async findForGame(gameSlug: string, variant?: string): Promise<RewardRule | null> {
    if (variant !== undefined) {
      const specific = await this.findById(`${gameSlug}:${variant}`)
      if (specific) return specific
    }
    return this.findById(gameSlug)
  }

  async findGlobal(): Promise<RewardRule | null> {
    return this.findById(GLOBAL_REWARD_RULE_ID)
  }

  async listActive(): Promise<RewardRule[]> {
    const rows = await this.db.rewardRule.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    })
    return rows.map(toRewardRule)
  }
}

export class PrismaCosmeticRepository extends PrismaRepositoryBase implements ICosmeticRepository {
  async upsertItem(item: CosmeticItem): Promise<CosmeticItem> {
    const { unlockParams, id, ...rest } = item
    const data = { ...rest, unlockParamsJson: toJsonOrNull(unlockParams) }
    return toCosmeticItem(
      await this.db.cosmeticItem.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      }),
    )
  }

  async findItem(id: string): Promise<CosmeticItem | null> {
    const row = await this.db.cosmeticItem.findUnique({ where: { id } })
    return row ? toCosmeticItem(row) : null
  }

  async listItems(filter: CosmeticFilter = {}): Promise<CosmeticItem[]> {
    const rows = await this.db.cosmeticItem.findMany({
      where: {
        ...(filter.category === undefined ? {} : { category: filter.category }),
        ...(filter.gameSlug === undefined ? {} : { gameSlug: filter.gameSlug }),
        ...(filter.active === undefined ? {} : { active: filter.active }),
        ...(filter.unlockKind === undefined ? {} : { unlockKind: filter.unlockKind }),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toCosmeticItem)
  }

  async listUnlocked(userId: string): Promise<UserCosmetic[]> {
    const rows = await this.db.userCosmetic.findMany({
      where: { userId },
      orderBy: { unlockedAt: 'asc' },
    })
    return rows.map(toUserCosmetic)
  }

  async isUnlocked(userId: string, cosmeticId: string): Promise<boolean> {
    return (await this.db.userCosmetic.count({ where: { userId, cosmeticId } })) > 0
  }

  async unlock(userId: string, cosmeticId: string, at = new Date()): Promise<UserCosmetic> {
    // `(userId, cosmeticId)` is unique, so an upsert makes "grant this twice"
    // a no-op instead of an error the caller has to remember to swallow.
    return toUserCosmetic(
      await this.db.userCosmetic.upsert({
        where: { userId_cosmeticId: { userId, cosmeticId } },
        create: { userId, cosmeticId, unlockedAt: at },
        update: {},
      }),
    )
  }
}

/**
 * Premium, read-only until M7 — 10 §6.
 *
 * One consumer at M0: the 1.5× earn multiplier. No provider SDK, no checkout,
 * no webhook — a `Subscription` row is, from here, just a column that says
 * whether the perks are live.
 */
export class PrismaSubscriptionRepository
  extends PrismaRepositoryBase
  implements ISubscriptionRepository
{
  async findByUser(userId: string): Promise<Subscription | null> {
    const row = await this.db.subscription.findUnique({ where: { userId } })
    return row === null ? null : toSubscription(row)
  }

  /**
   * ★ Live *right now*, which is not the same as `status === 'ACTIVE'`.
   *
   * Two departures from the naive read, both from 10 §6.3:
   *
   *   - **`PAST_DUE` still counts inside `graceEndsAt`.** A declined card is
   *     usually an expired one, and taking somebody's earn rate away the hour
   *     it happens punishes an administrative failure as if it were a lapse.
   *   - **`currentPeriodEnd` is checked, not trusted.** A row left `ACTIVE` by
   *     a provider webhook that never arrived would otherwise pay 1.5× forever.
   */
  async findActive(userId: string, now: Date): Promise<Subscription | null> {
    const row = await this.db.subscription.findUnique({ where: { userId } })
    if (row === null) return null

    const subscription = toSubscription(row)
    const live =
      (subscription.status === 'ACTIVE' || subscription.status === 'TRIALING') &&
      (subscription.currentPeriodEnd === null || subscription.currentPeriodEnd > now)
    const inGrace =
      subscription.status === 'PAST_DUE' &&
      subscription.graceEndsAt !== null &&
      subscription.graceEndsAt > now

    return live || inGrace ? subscription : null
  }

  async upsert(userId: string, data: NewSubscription): Promise<Subscription> {
    const { userId: _ignored, ...rest } = data
    return toSubscription(
      await this.db.subscription.upsert({
        where: { userId },
        create: { userId, ...rest },
        update: rest,
      }),
    )
  }
}
