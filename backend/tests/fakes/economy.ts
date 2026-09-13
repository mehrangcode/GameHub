import type { AssetCode, TransactionKind } from '../../src/contracts/enums.js'
import type {
  RewardRule,
  Subscription,
  Wallet,
  WalletTransaction,
} from '../../src/domain/entities/economy.js'
import type { CosmeticItem, UserCosmetic } from '../../src/domain/entities/user.js'
import { GLOBAL_REWARD_RULE_ID } from '../../src/domain/economy/caps.js'
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
} from '../../src/domain/repositories/economy.js'
import type { PageQuery } from '../../src/domain/repositories/IRepository.js'
import type { IdentityRef } from '../../src/domain/value-objects/identity.js'
import { Collection, nextId, paginate } from './store.js'

export class InMemoryWalletRepository implements IWalletRepository {
  readonly rows = new Collection<Wallet>('Wallet')
  readonly transactions = new Collection<WalletTransaction>('WalletTransaction')

  async findById(id: string): Promise<Wallet | null> {
    return this.rows.get(id)
  }

  async findByHolder(holder: IdentityRef, assetCode: AssetCode): Promise<Wallet | null> {
    return this.rows.find((w) =>
      holder.kind === 'user'
        ? w.userId === holder.userId && w.assetCode === assetCode
        : w.guestSessionId === holder.guestSessionId && w.assetCode === assetCode,
    )
  }

  async ensure(holder: IdentityRef, assetCode: AssetCode): Promise<Wallet> {
    const existing = await this.findByHolder(holder, assetCode)
    if (existing) return existing

    const now = new Date()
    return this.rows.insert({
      id: nextId('wal'),
      userId: holder.kind === 'user' ? holder.userId : null,
      guestSessionId: holder.kind === 'guest' ? holder.guestSessionId : null,
      assetCode,
      balance: 0,
      // A guest accrues but cannot spend until signup vests the wallet (10 §3.4).
      status: holder.kind === 'guest' ? 'PROVISIONAL' : 'VESTED',
      lifetimeEarned: 0,
      lifetimeSpent: 0,
      createdAt: now,
      updatedAt: now,
    })
  }

  /**
   * E1 + E2 in one method, on purpose.
   *
   * The ledger row and the cached balance are written together, and the
   * `(walletId, idempotencyKey)` uniqueness is checked first — a retried
   * settlement returns the original row with `applied: false` instead of paying
   * a second time. There is no other way to move a balance in this interface.
   */
  async append(entry: LedgerEntry): Promise<AppendResult> {
    const wallet = this.rows.require(entry.walletId)

    const duplicate = this.transactions.find(
      (t) => t.walletId === entry.walletId && t.idempotencyKey === entry.idempotencyKey,
    )
    if (duplicate) {
      return { transaction: duplicate, wallet: this.rows.require(wallet.id), applied: false }
    }

    const balanceAfter = wallet.balance + entry.amount
    const transaction = this.transactions.insert({
      id: nextId('txn'),
      walletId: entry.walletId,
      assetCode: wallet.assetCode,
      amount: entry.amount,
      kind: entry.kind,
      idempotencyKey: entry.idempotencyKey,
      reason: entry.reason ?? null,
      refKind: entry.refKind ?? null,
      refId: entry.refId ?? null,
      balanceAfter,
      createdAt: new Date(),
    })

    const updated = this.rows.patch(wallet.id, {
      balance: balanceAfter,
      lifetimeEarned: wallet.lifetimeEarned + Math.max(0, entry.amount),
      lifetimeSpent: wallet.lifetimeSpent + Math.max(0, -entry.amount),
      updatedAt: new Date(),
    })

    return { transaction, wallet: updated, applied: true }
  }

  async findTransactionByKey(
    walletId: string,
    idempotencyKey: string,
  ): Promise<WalletTransaction | null> {
    return this.transactions.find(
      (t) => t.walletId === walletId && t.idempotencyKey === idempotencyKey,
    )
  }

  async listTransactions(walletId: string, page: PageQuery = {}): Promise<WalletTransaction[]> {
    return paginate(
      this.transactions.all().filter((t) => t.walletId === walletId),
      page,
    )
  }

  async sumTransactions(walletId: string): Promise<number> {
    return this.transactions
      .all()
      .filter((t) => t.walletId === walletId)
      .reduce((sum, t) => sum + t.amount, 0)
  }

  async sumCreditsSince(
    walletId: string,
    since: Date,
    kinds: readonly TransactionKind[],
  ): Promise<number> {
    return this.creditWindow(walletId, since, kinds).reduce((sum, t) => sum + t.amount, 0)
  }

  async countCreditsSince(
    walletId: string,
    since: Date,
    kinds: readonly TransactionKind[],
  ): Promise<number> {
    return this.creditWindow(walletId, since, kinds).length
  }

  /** Credits only, `gte` on the boundary — the Prisma `where` clause, in TS. */
  private creditWindow(walletId: string, since: Date, kinds: readonly TransactionKind[]) {
    return this.transactions
      .all()
      .filter(
        (t) =>
          t.walletId === walletId &&
          t.amount > 0 &&
          kinds.includes(t.kind) &&
          t.createdAt.getTime() >= since.getTime(),
      )
  }

  async markVested(walletId: string): Promise<Wallet> {
    return this.rows.patch(walletId, { status: 'VESTED', updatedAt: new Date() })
  }

  /**
   * No lock to take — a single-threaded map has no concurrent writer, which is
   * the honest fake. The *property* the lock protects (exactly one of two
   * simultaneous debits succeeds) belongs to the database and is asserted
   * against a real transaction in `tests/integration/wallet-debit.test.ts`.
   */
  async balanceForUpdate(walletId: string): Promise<number> {
    return this.rows.require(walletId).balance
  }

  async listPaged(afterId: string | null, limit: number): Promise<Wallet[]> {
    const sorted = this.rows.all().sort((a, b) => a.id.localeCompare(b.id))
    const start = afterId === null ? 0 : sorted.findIndex((w) => w.id === afterId) + 1
    return sorted.slice(start, start + limit)
  }
}

/** Premium, read-only until M7 — one consumer: the 1.5× earn multiplier. */
export class InMemorySubscriptionRepository implements ISubscriptionRepository {
  readonly rows = new Collection<Subscription>('Subscription')

  async findByUser(userId: string): Promise<Subscription | null> {
    return this.rows.find((s) => s.userId === userId)
  }

  async findActive(userId: string, now: Date): Promise<Subscription | null> {
    const subscription = await this.findByUser(userId)
    if (subscription === null) return null

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
    const now = new Date()
    const existing = await this.findByUser(userId)
    const row: Subscription = {
      id: existing?.id ?? nextId('sub'),
      tier: 'PREMIUM',
      provider: 'stripe',
      providerCustomerId: null,
      providerSubId: null,
      interval: 'month',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      graceEndsAt: null,
      ...data,
      userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    return existing === null ? this.rows.insert(row) : this.rows.patch(row.id, row)
  }
}

export class InMemoryRewardRuleRepository implements IRewardRuleRepository {
  readonly rows = new Collection<RewardRule>('RewardRule')

  async upsert(rule: NewRewardRule & { id: string }): Promise<RewardRule> {
    const row: RewardRule = { active: true, ...rule, updatedAt: new Date() }
    return this.rows.peek(row.id) ? this.rows.patch(row.id, row) : this.rows.insert(row)
  }

  async findById(id: string): Promise<RewardRule | null> {
    return this.rows.get(id)
  }

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
    return this.rows.filter((r) => r.active).sort((a, b) => a.id.localeCompare(b.id))
  }
}

export class InMemoryCosmeticRepository implements ICosmeticRepository {
  readonly items = new Collection<CosmeticItem>('CosmeticItem')
  readonly unlocks = new Collection<UserCosmetic>('UserCosmetic')

  async upsertItem(item: CosmeticItem): Promise<CosmeticItem> {
    return this.items.peek(item.id)
      ? this.items.patch(item.id, item)
      : this.items.insert({ ...item })
  }

  async findItem(id: string): Promise<CosmeticItem | null> {
    return this.items.get(id)
  }

  async listItems(filter: CosmeticFilter = {}): Promise<CosmeticItem[]> {
    return this.items
      .filter((i) => {
        if (filter.category !== undefined && i.category !== filter.category) return false
        if (filter.gameSlug !== undefined && i.gameSlug !== filter.gameSlug) return false
        if (filter.active !== undefined && i.active !== filter.active) return false
        if (filter.unlockKind !== undefined && i.unlockKind !== filter.unlockKind) return false
        return true
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  }

  async listUnlocked(userId: string): Promise<UserCosmetic[]> {
    return this.unlocks.filter((u) => u.userId === userId)
  }

  async isUnlocked(userId: string, cosmeticId: string): Promise<boolean> {
    return this.unlocks.all().some((u) => u.userId === userId && u.cosmeticId === cosmeticId)
  }

  async unlock(userId: string, cosmeticId: string, at = new Date()): Promise<UserCosmetic> {
    const existing = this.unlocks.find((u) => u.userId === userId && u.cosmeticId === cosmeticId)
    if (existing) return existing

    return this.unlocks.insert({ id: nextId('ucs'), userId, cosmeticId, unlockedAt: at })
  }
}
