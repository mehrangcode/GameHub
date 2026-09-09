import type { AssetCode, TransactionKind, UnlockKind } from '../../contracts/enums.js'
import type { Wallet, WalletTransaction } from '../entities/economy.js'
import type { CosmeticItem, UserCosmetic } from '../entities/user.js'
import type { IdentityRef } from '../value-objects/identity.js'
import type { PageQuery } from './IRepository.js'

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
  /** Guest vesting: the provisional wallet becomes spendable (10 §3.4). */
  markVested(walletId: string): Promise<Wallet>
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
