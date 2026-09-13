import { Router } from 'express'
import type { z } from 'zod'
import type { Container } from '../../../container.js'
import { toRewardRulesResponse } from '../../../application/mappers/rewards.js'
import { toWalletBalanceDto, toWalletTransactionDto } from '../../../application/mappers/wallet.js'
import { CursorPageSchema, type CursorPage } from '../../../contracts/dto/common.js'
import { ASSET_CODES, AssetCodeSchema, type AssetCode } from '../../../contracts/enums.js'
import { identityRefOf, requireIdentity, requireUser } from '../middleware/authorize.js'
import { asyncHandler } from '../middleware/error.js'
import { validQuery, zodValidate } from '../middleware/validate.js'

/**
 * `/api/v1/wallet`, `/api/v1/rewards/rules` — S37. 02 §5, 10 §10.
 *
 * Three routes at three different access levels, and each level is a decision:
 *
 * | Route | Level | Why |
 * |---|---|---|
 * | `GET /wallet` | **G** — guests included | A guest's provisional balance *is* the signup incentive (10 §3.4). A wallet a guest could not see would be a pitch nobody hears |
 * | `GET /wallet/transactions` | **U** — users only | A statement is an account feature. A guest's ledger is two rows long, unspendable, and about to be vested or forfeited; there is nothing to reconcile |
 * | `GET /rewards/rules` | **P** — public, no cookie | 10 §11. Deliberate transparency: the welcome page can say "Shelem pays most" before anybody signs up, and a published formula is what makes forfeiture a rule rather than a surprise |
 *
 * There is no id parameter anywhere in this file. A holder can read their own
 * wallet and nothing else, and the way that is guaranteed is that there is no
 * field with which to name somebody else's — the same discipline as the seat
 * routes (S20) and the socket payloads (S23).
 */

const StatementQuerySchema = CursorPageSchema.extend({
  asset: AssetCodeSchema.default('COIN'),
}).strict()

type StatementQuery = z.infer<typeof StatementQuerySchema>

export function buildWalletRouter(container: Container): Router {
  const router = Router()
  const { wallets } = container

  /**
   * Every asset the holder owns, with its vesting status.
   *
   * A user has three wallets from registration; a guest has `COIN` only,
   * because gems and tickets are not earnable and a guest has no use for a row
   * that will always read zero.
   *
   * `provisional` is not a separate field here — `status` carries it, per
   * wallet, which is what lets a claimed account show a vested balance and a
   * still-guest session show a provisional one through one shape.
   */
  router.get(
    '/wallet',
    requireIdentity(),
    asyncHandler(async (req, res) => {
      const holder = identityRefOf(req.identity!)
      const assets: readonly AssetCode[] = holder.kind === 'user' ? ASSET_CODES : ['COIN']
      const balances = await wallets.balances(holder, assets)

      res.json({ balances: balances.map(toWalletBalanceDto) })
    }),
  )

  /**
   * The player's own statement, newest first.
   *
   * ★ `CAP_REJECTED` rows are **included**, and that is the point of the route.
   * A reward that was earned and then capped away, or forfeited by an ejection,
   * appears as a zero-amount row carrying its reason (10 §2.3) — so "why did I
   * get no coins?" is answerable from the statement instead of from a support
   * conversation. Filtering them out would make the ledger tidier and the
   * economy unaccountable.
   *
   * `balanceAfter` travels on every row, so the page can be checked downward
   * without the client re-deriving a running total from a partial list.
   */
  router.get(
    '/wallet/transactions',
    requireUser(),
    zodValidate({ query: StatementQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = validQuery<StatementQuery & CursorPage>(req)
      const holder = identityRefOf(req.identity!)

      const rows = await wallets.statement(holder, query.asset, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { before: query.cursor }),
      })

      res.json({
        items: rows.map(toWalletTransactionDto),
        // The cursor is the last row's id; a short page means there is no more.
        nextCursor: rows.length < query.limit ? null : (rows.at(-1)?.id ?? null),
      })
    }),
  )

  /**
   * 10 §11 — the whole rate card, to anybody who asks.
   *
   * Reads `RewardRule` rows rather than constants, so a rebalance shows up here
   * the moment it is written (10 §3) without a deploy and without this file
   * changing.
   */
  router.get(
    '/rewards/rules',
    asyncHandler(async (_req, res) => {
      const rules = await container.repos.rewardRules.listActive()
      res.json(toRewardRulesResponse(rules))
    }),
  )

  return router
}
