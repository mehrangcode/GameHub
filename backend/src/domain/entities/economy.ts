import type { AssetCode, TransactionKind, WalletStatus } from '../../contracts/enums.js'

/**
 * E1 — `balance` is a **cache**. The truth is `Σ WalletTransaction.amount`, and
 * this column is written only inside the same transaction that appends the
 * corresponding ledger row. The nightly reconciliation (S38) recomputes the sum
 * and alerts on any drift.
 */
export interface Wallet {
  readonly id: string
  /** Exactly one of these is set. */
  readonly userId: string | null
  readonly guestSessionId: string | null
  readonly assetCode: AssetCode
  readonly balance: number
  /** PROVISIONAL for a guest: accrues, cannot be spent, vests on signup (10 §3.4). */
  readonly status: WalletStatus
  readonly lifetimeEarned: number
  readonly lifetimeSpent: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Append-only. Never updated, never deleted — a correction is another row.
 *
 * `idempotencyKey` is **derived** from the event that caused the credit
 * (`MATCH_REWARD:<matchId>:<holderKey>`), never random, and is unique per
 * wallet at the database level. That constraint is the entire double-credit
 * defence: a retried settlement collides instead of paying twice (E2).
 */
export interface WalletTransaction {
  readonly id: string
  readonly walletId: string
  readonly assetCode: AssetCode
  /** Signed. Positive = credit, negative = debit, 0 = `CAP_REJECTED` audit row. */
  readonly amount: number
  readonly kind: TransactionKind
  readonly idempotencyKey: string
  /** Why. Mandatory in spirit for `CAP_REJECTED` and `ADMIN_ADJUST`. */
  readonly reason: string | null
  readonly refKind: string | null
  readonly refId: string | null
  readonly balanceAfter: number
  readonly createdAt: Date
}

/** rank → multiplier, keyed by seat count. `{ draw: 1, bySeatCount: { '4': … } }`. */
export interface PlacementTable {
  readonly draw: number
  readonly bySeatCount: Readonly<Record<string, Readonly<Record<string, number>>>>
}

/**
 * Data, not code — rebalancing the economy is a row update, not a deploy
 * (10 §3). `id` is `'<slug>'`, `'<slug>:<variant>'`, or `'_global'` for caps.
 */
export interface RewardRule {
  readonly id: string
  readonly gameSlug: string | null
  readonly assetCode: AssetCode
  readonly baseAmount: number
  readonly placement: PlacementTable
  /** Minimum plausible duration for a full reward, in ms (the durationFactor). */
  readonly expectedMinMs: number
  readonly repeatDecay: readonly number[]
  readonly capPerHour: number
  readonly capPerDay: number
  readonly capPerDayGuest: number
  readonly capMatchesPerDay: number
  readonly guestVestCap: number
  readonly active: boolean
  readonly updatedAt: Date
}
