import type { WalletBalanceDto, WalletTransactionDto } from '../../contracts/dto/wallet.js'
import type { WalletTransaction } from '../../domain/entities/economy.js'
import type { WalletBalance } from '../services/WalletService.js'

/**
 * Entity → wire, for the wallet.
 *
 * Fields are listed by hand rather than spread, for the same reason
 * `toUserIdentity` lists them: a column added to `WalletTransaction` — an
 * internal note, a moderation flag, the `walletId` itself — must not appear in
 * a client payload because somebody used the spread operator. `walletId` is
 * deliberately absent: a wallet id is an internal handle and the client already
 * knows whose wallet it asked for.
 */

export function toWalletBalanceDto(balance: WalletBalance): WalletBalanceDto {
  return {
    asset: balance.asset,
    balance: balance.balance,
    status: balance.status,
    lifetimeEarned: balance.lifetimeEarned,
    lifetimeSpent: balance.lifetimeSpent,
  }
}

export function toWalletTransactionDto(row: WalletTransaction): WalletTransactionDto {
  return {
    id: row.id,
    asset: row.assetCode,
    amount: row.amount,
    kind: row.kind,
    reason: row.reason,
    refKind: row.refKind,
    refId: row.refId,
    balanceAfter: row.balanceAfter,
    createdAt: row.createdAt.toISOString(),
  }
}
