// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'
import { AssetCodeSchema, TransactionKindSchema, WalletStatusSchema } from '../enums.js'

/**
 * The wallet wire shapes — 10-economy-and-rewards.md §10, 03 §3.9.
 *
 * Written at S21 alongside the credit path and consumed by the dev-only probe
 * route; `GET /wallet` and `GET /wallet/transactions` land in S37 and render
 * exactly these. Defining them with the service rather than with the route
 * means the shape is settled by the thing that produces it.
 *
 * **Amounts are integers.** No `Decimal`, no floats, no fractional coins —
 * money in this schema is a whole count of a soft currency (03 §1), which is
 * also what keeps `balance == Σ amount` an exact statement rather than an
 * approximate one.
 */

export const WalletBalanceSchema = z.object({
  asset: AssetCodeSchema,
  balance: z.number().int(),
  /**
   * `PROVISIONAL` is a guest's balance: it accrues and cannot be spent until
   * signup vests it (10 §2.2). The client shows a different affordance for
   * each, so the status travels with the number rather than being inferred
   * from the identity kind.
   */
  status: WalletStatusSchema,
  lifetimeEarned: z.number().int().nonnegative(),
  lifetimeSpent: z.number().int().nonnegative(),
})

export type WalletBalanceDto = z.infer<typeof WalletBalanceSchema>

export const WalletSummarySchema = z.object({
  balances: z.array(WalletBalanceSchema),
})

export type WalletSummary = z.infer<typeof WalletSummarySchema>

/**
 * One statement line.
 *
 * `reason` is a machine code, never a sentence — `CAP_PER_HOUR:120` for a
 * capped reward — so the statement renders in Persian without a translation
 * round-trip through the server (02 §8.1). A zero `amount` with kind
 * `CAP_REJECTED` is a real, deliberate row: the audit trail of a reward that
 * was earned and then capped away (10 §2.3).
 */
export const WalletTransactionSchema = z.object({
  id: z.string(),
  asset: AssetCodeSchema,
  amount: z.number().int(),
  kind: TransactionKindSchema,
  reason: z.string().nullable(),
  refKind: z.string().nullable(),
  refId: z.string().nullable(),
  balanceAfter: z.number().int(),
  /** ISO 8601. */
  createdAt: z.string(),
})

export type WalletTransactionDto = z.infer<typeof WalletTransactionSchema>

export const WalletStatementSchema = z.object({
  asset: AssetCodeSchema,
  transactions: z.array(WalletTransactionSchema),
})

export type WalletStatement = z.infer<typeof WalletStatementSchema>
