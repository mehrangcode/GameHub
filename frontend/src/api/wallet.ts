import { api } from './client'
import type { Paginated } from '@/contracts/dto/common'
import type { RewardRulesResponse } from '@/contracts/dto/rewards'
import type { WalletSummary, WalletTransactionDto } from '@/contracts/dto/wallet'

/**
 * Wallet reads and the public rate card — 10 §10, §11.
 *
 * ★ Balances here are **display only**. A purchase re-reads and row-locks
 * server-side (07 §11.3), so the client showing "not enough coins" is a
 * courtesy exactly as greying out an illegal card is: helpful, never
 * authoritative.
 */

export async function getWallet(): Promise<WalletSummary> {
  const { data } = await api.get<WalletSummary>('/wallet')
  return data
}

/**
 * The statement. There is deliberately no parameter naming a holder — asking
 * for somebody else's statement is a `VALIDATION_FAILED`, because there is no
 * field in which to ask.
 */
export async function getTransactions(params: {
  limit?: number
  cursor?: string
} = {}): Promise<Paginated<WalletTransactionDto>> {
  const { data } = await api.get<Paginated<WalletTransactionDto>>('/wallet/transactions', { params })
  return data
}

/**
 * ★ Unauthenticated on purpose (10 §11). The integrity factors are published so
 * that "you were removed for inactivity, so you earned nothing" is a rule a
 * player could have read *beforehand*, rather than a surprise after the fact.
 */
export async function getRewardRules(): Promise<RewardRulesResponse> {
  const { data } = await api.get<RewardRulesResponse>('/rewards/rules')
  return data
}
