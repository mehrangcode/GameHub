import type { AssetCode } from '../../../contracts/enums.js'
import type { Wallet } from '../../../domain/entities/economy.js'
import type { WalletTransaction } from '../../../domain/entities/economy.js'
import type { CosmeticItem, UserCosmetic } from '../../../domain/entities/user.js'
import { NotFoundError } from '../../../domain/errors/errors.js'
import type {
  AppendResult,
  CosmeticFilter,
  ICosmeticRepository,
  IWalletRepository,
  LedgerEntry,
} from '../../../domain/repositories/economy.js'
import type { PageQuery } from '../../../domain/repositories/IRepository.js'
import type { IdentityRef } from '../../../domain/value-objects/identity.js'
import { isUniqueViolation } from '../errors.js'
import {
  toCosmeticItem,
  toJsonOrNull,
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
