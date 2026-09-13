import type { AssetCode, TransactionKind, UnlockKind } from '../../contracts/enums.js'
import type { RewardRule, Subscription, Wallet, WalletTransaction } from '../entities/economy.js'
import type { CosmeticItem, UserCosmetic } from '../entities/user.js'
import type { IdentityRef } from '../value-objects/identity.js'
import type { Draft, PageQuery } from './IRepository.js'

/**
 * What a caller appends to the ledger. Note what is **absent**: `balanceAfter`
 * is computed by the repository, never supplied — a caller that could state the
 * resulting balance could state a wrong one.
 */
export interface LedgerEntry {
  readonly walletId: string
  /** Signed. Positive credit, negative debit, 0 for a `CAP_REJECTED` audit row. */
  readonly amount: number
  readonly kind: TransactionKind
  /** ★ Derived from the causing event, never random. Unique per wallet (E2). */
  readonly idempotencyKey: string
  readonly reason?: string | null
  readonly refKind?: string | null
  readonly refId?: string | null
}

export interface AppendResult {
  readonly transaction: WalletTransaction
  readonly wallet: Wallet
  /**
   * False when `idempotencyKey` already existed: the stored row is returned
   * unchanged and nothing was written. A retried settlement must be a no-op.
   */
  readonly applied: boolean
}

/**
 * The economy's core (10 §2).
 *
 * `balance` is a cached column whose truth is `Σ transactions`. This interface
 * exposes **no** way to set it: {@link IWalletRepository.append} is the only
 * mutation, and it writes the ledger row and the balance together or not at
 * all. Take that method away and E1 becomes a convention someone eventually
 * forgets.
 */
export interface IWalletRepository {
  findById(id: string): Promise<Wallet | null>
  findByHolder(holder: IdentityRef, assetCode: AssetCode): Promise<Wallet | null>
  /** Create-if-missing. A guest's wallet is created `PROVISIONAL` (10 §3.4). */
  ensure(holder: IdentityRef, assetCode: AssetCode): Promise<Wallet>

  append(entry: LedgerEntry): Promise<AppendResult>

  findTransactionByKey(walletId: string, idempotencyKey: string): Promise<WalletTransaction | null>
  /** Newest first — the statement view. */
  listTransactions(walletId: string, page?: PageQuery): Promise<WalletTransaction[]>
  /** Recomputes the truth for the nightly reconciliation (S38). */
  sumTransactions(walletId: string): Promise<number>

  /**
   * ★ The cap windows (E7, 10 §3.7) — Σ of **positive** amounts of the given
   * kinds since `since`.
   *
   * Positive-only, and it matters: including debits would let a player spend
   * their way back under the daily cap and keep earning, which turns the store
   * into a cap bypass. A cap is on *earning rate*, and spending is not
   * negative earning.
   *
   * Aggregated in the database rather than by summing rows in the service,
   * because a holder who has played all evening has hundreds of rows and this
   * runs inside the credit transaction on every single credit.
   */
  sumCreditsSince(walletId: string, since: Date, kinds: readonly TransactionKind[]): Promise<number>
  /**
   * How many credits of those kinds landed since `since` — the
   * matches-per-day cap, which counts events rather than coins.
   *
   * Zero-amount `CAP_REJECTED` rows are excluded by the `kinds` filter, so a
   * capped match does not itself consume a match slot. That is the kinder
   * reading and the defensible one: the cap is on rewards *paid*.
   */
  countCreditsSince(
    walletId: string,
    since: Date,
    kinds: readonly TransactionKind[],
  ): Promise<number>

  /** Guest vesting: the provisional wallet becomes spendable (10 §3.4). */
  markVested(walletId: string): Promise<Wallet>

  /**
   * ★ The debit path's row-locked read — 10 §2.5, S38.
   *
   * `SELECT … FOR UPDATE` on PostgreSQL; on SQLite the statement is a no-op
   * because the engine serializes writers anyway, so the *property* holds on
   * both and only the mechanism differs. Two simultaneous purchases with one
   * item's worth of coins must not both pass the balance check: a plain read
   * followed by a write is a real double-spend, not a theoretical one.
   *
   * Only meaningful **inside** a transaction — the lock is released at commit.
   */
  balanceForUpdate(walletId: string): Promise<number>

  /**
   * Every wallet, a page at a time, ordered by `id` — the nightly
   * reconciliation (E1, S38).
   *
   * Paged rather than `findMany()` because this is the one query in the
   * codebase whose result set grows with the whole user base, and a job that
   * loads every wallet into memory stops working on precisely the day the
   * platform starts mattering.
   */
  listPaged(afterId: string | null, limit: number): Promise<Wallet[]>
}

/**
 * Premium, read-only at M0 — 10 §6.
 *
 * There is exactly one consumer before M7: the 1.5× earn multiplier in
 * `RewardService`. The write side (checkout, webhooks, provider ids) belongs to
 * M7 and is deliberately absent, so nothing here can grow into payment code by
 * accident. `upsert` exists because a test — and, later, the admin console —
 * needs to be able to say "this account is a subscriber" without a Stripe
 * account existing.
 */
export interface ISubscriptionRepository {
  findByUser(userId: string): Promise<Subscription | null>
  /**
   * ★ Is premium *live* right now? Includes `PAST_DUE` inside `graceEndsAt`,
   * per 10 §6.3: perks continue for three days after a failed payment, because
   * a declined card is usually an expired one and taking the perks away the
   * same hour punishes the wrong thing.
   */
  findActive(userId: string, now: Date): Promise<Subscription | null>
  upsert(userId: string, data: NewSubscription): Promise<Subscription>
}

export type NewSubscription = Draft<
  Subscription,
  | 'tier'
  | 'provider'
  | 'providerCustomerId'
  | 'providerSubId'
  | 'interval'
  | 'currentPeriodStart'
  | 'currentPeriodEnd'
  | 'cancelAtPeriodEnd'
  | 'canceledAt'
  | 'graceEndsAt'
>


/** `updatedAt` is the database's; everything else is the operator's. */
export type NewRewardRule = Draft<RewardRule, 'active'>

/**
 * The economy's tuning knobs, as data — 10 §3, 03 §3.9.
 *
 * `RewardRule` rows are read, not compiled: rebalancing is a row update, not a
 * deploy, and the numbers in 10 §3 are explicitly a starting guess. Two shapes
 * of row live in one table — `_global` carries the caps every holder is
 * measured against, and one row per game (or `slug:variant`) carries that
 * game's rates.
 */
export interface IRewardRuleRepository {
  /** Idempotent by `id` — how the S06 seed and the admin console both write. */
  upsert(rule: NewRewardRule & { id: string }): Promise<RewardRule>
  findById(id: string): Promise<RewardRule | null>
  /**
   * `${gameSlug}:${variant}` if a variant is given and such a row exists,
   * otherwise `${gameSlug}`. S35's lookup, in the repository so that the
   * fallback cannot be implemented twice and differently.
   */
  findForGame(gameSlug: string, variant?: string): Promise<RewardRule | null>
  /** The `_global` row: caps and the vesting bound. `null` before the seed runs. */
  findGlobal(): Promise<RewardRule | null>
  listActive(): Promise<RewardRule[]>
}

export interface CosmeticFilter {
  readonly category?: string
  readonly gameSlug?: string | null
  readonly active?: boolean
  /**
   * How the item is obtained. `AuthService.register` queries `'DEFAULT'` to
   * find the grants every new account gets — which keeps "what does a new
   * player own?" a **data** question the seed and the admin console answer,
   * rather than a list hard-coded in the sign-up path.
   */
  readonly unlockKind?: UnlockKind
}

export interface ICosmeticRepository {
  /**
   * The catalog is data, not code: the S06 seed writes it, and the admin
   * console edits it. `id` is a stable slug, so this is idempotent by design.
   */
  upsertItem(item: CosmeticItem): Promise<CosmeticItem>
  findItem(id: string): Promise<CosmeticItem | null>
  listItems(filter?: CosmeticFilter): Promise<CosmeticItem[]>
  listUnlocked(userId: string): Promise<UserCosmetic[]>
  isUnlocked(userId: string, cosmeticId: string): Promise<boolean>
  /** Idempotent: unlocking twice returns the first row, it does not fail. */
  unlock(userId: string, cosmeticId: string, at?: Date): Promise<UserCosmetic>
}
