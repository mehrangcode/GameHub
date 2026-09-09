import type { Logger } from 'pino'
import type { AssetCode, TransactionKind } from '../../contracts/enums.js'
import type { Wallet, WalletTransaction } from '../../domain/entities/economy.js'
import {
  DAY_MS,
  HOUR_MS,
  MATCH_KINDS,
  EARN_KINDS,
  applyCaps,
  capLimitsFrom,
  capReason,
  isEarnKind,
  vestableAmount,
  type CapDecision,
  type CapLimits,
  type CapUsage,
} from '../../domain/economy/caps.js'
import { ValidationError } from '../../domain/errors/errors.js'
import type { PageQuery } from '../../domain/repositories/IRepository.js'
import type { IUnitOfWork, Repositories } from '../../domain/repositories/Repositories.js'
import { holderKey, type IdentityRef } from '../../domain/value-objects/identity.js'
import type { MetricsRegistry } from './MetricsRegistry.js'

/**
 * ★ The wallet — S21. 10-economy-and-rewards.md §2, invariants E1, E2, E7.
 *
 * Three properties, and every design decision below serves one of them:
 *
 * **E1 — the ledger is the truth.** `balance == Σ WalletTransaction.amount`.
 * The cached column is written *only* by `IWalletRepository.append`, which
 * writes it inside the same transaction as the row. This service therefore has
 * no way to move a balance without appending — not by convention, but because
 * the interface exposes no other mutation. {@link recompute} is the reconciler's
 * view of the same fact and is what S38's nightly job calls.
 *
 * **E2 — every credit is idempotent.** The key is derived from the causing
 * event (`domain/economy/idempotency.ts`) and `(walletId, idempotencyKey)` is
 * unique in the database. A replay returns the original row with
 * `applied: false`; it does not pay, and it does not throw either — a retried
 * settlement is a *normal* event, not an error.
 *
 * **E7 — earning is capped.** The caps are read from the `_global`
 * `RewardRule` row inside the credit transaction and applied by a pure function
 * (`domain/economy/caps.ts`). A credit capped to nothing becomes a zero-amount
 * `CAP_REJECTED` row carrying the cap code, because a reward silently not
 * granted is indistinguishable from a bug (10 §2.4) — "why did I get no coins?"
 * must be answerable from the ledger alone.
 *
 * ### On the two entry points
 *
 * {@link credit} opens its own transaction. {@link creditWithin} runs inside one
 * the caller already opened, and exists because the guest→user claim (S22) and
 * reward settlement (S36) must credit as *part of* a larger all-or-nothing
 * transaction — a vested wallet with no transferred seat is as broken as the
 * reverse. Prisma cannot nest `$transaction`, so this seam is a requirement,
 * not a convenience.
 *
 * Debits are **not** here: `purchase` (10 §2.5) needs a row-locked read and
 * lands in S38 with the reconciliation job.
 */

export interface CreditInput {
  readonly holder: IdentityRef
  readonly asset: AssetCode
  /** The amount **earned**, before caps. Must be a positive integer. */
  readonly amount: number
  readonly kind: TransactionKind
  /** Derived, never random — see `domain/economy/idempotency.ts`. */
  readonly idempotencyKey: string
  readonly reason?: string
  readonly refKind?: string
  readonly refId?: string
  /**
   * Premium raises the hourly and daily ceilings by this factor; it never
   * removes them (E3). Defaults to 1 — nothing sets it before M7, and it is
   * declared now so the multiplier has exactly one home in the economy.
   */
  readonly capMultiplier?: number
  /**
   * Skips the earn caps entirely. Used only where a cap would make the ledger
   * *less* true: `GUEST_VEST` moves coins between wallets rather than minting
   * them, `ADMIN_ADJUST` is an operator correcting a mistake, and `REFUND`
   * returns coins the holder already had. Derived from `kind`, not requested by
   * the caller.
   */
  readonly exemptFromCaps?: boolean
}

export interface CreditResult {
  readonly transaction: WalletTransaction
  readonly wallet: Wallet
  /** False when the key already existed: nothing was written, nothing was paid. */
  readonly applied: boolean
  /** What was earned before caps. */
  readonly requested: number
  /** What actually landed. Below `requested` when a cap bound. */
  readonly credited: number
  /** The binding cap code, or `null`. `credited === 0` means a `CAP_REJECTED` row. */
  readonly capCode: string | null
}

/** What `GET /wallet` renders (S37) and what the S22 verify step reads. */
export interface WalletBalance {
  readonly asset: AssetCode
  readonly balance: number
  readonly status: Wallet['status']
  readonly lifetimeEarned: number
  readonly lifetimeSpent: number
}

export interface ReconciliationReport {
  readonly walletId: string
  readonly cached: number
  readonly computed: number
  /** `cached - computed`. Non-zero is an `ALERT`, never a rounding artefact. */
  readonly drift: number
}

export interface WalletServiceDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

export class WalletService {
  private readonly now: () => Date

  constructor(private readonly deps: WalletServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** Opens its own transaction. See {@link creditWithin} for the nested case. */
  async credit(input: CreditInput): Promise<CreditResult> {
    return this.deps.uow.run(async (repos) => this.creditWithin(repos, input))
  }

  /**
   * The credit path, step for step per 10 §2.4.
   *
   *   1. resolve (or create) the wallet for this holder and asset
   *   2. look the key up — an existing row is the answer, unchanged
   *   3. apply the caps (E7)
   *   4. capped to nothing → a zero-amount `CAP_REJECTED` row **with a reason**
   *   5. otherwise append, which writes the row and the cached balance together
   *
   * Steps 2 and 5 both rely on the unique constraint rather than trusting the
   * read: `append` catches the violation and returns the winner's row, so two
   * settlements of one match racing each other still pay once (asserted in
   * `tests/integration/unit-of-work.test.ts`).
   */
  async creditWithin(repos: Repositories, input: CreditInput): Promise<CreditResult> {
    this.assertCreditable(input)

    const wallet = await repos.wallets.ensure(input.holder, input.asset)

    const existing = await repos.wallets.findTransactionByKey(wallet.id, input.idempotencyKey)
    if (existing) {
      this.deps.metrics.increment('wallet_credits_replayed')
      return {
        transaction: existing,
        wallet,
        applied: false,
        requested: input.amount,
        credited: existing.amount,
        capCode: capCodeOf(existing.reason),
      }
    }

    const decision = await this.decide(repos, wallet.id, input)

    if (decision.amount === 0) {
      // ★ Never silence. The row is the answer to "why did I get nothing?".
      const reason = decision.code
        ? capReason(decision.code, decision.requested)
        : (input.reason ?? 'ZERO')
      const rejected = await repos.wallets.append({
        walletId: wallet.id,
        amount: 0,
        kind: 'CAP_REJECTED',
        idempotencyKey: input.idempotencyKey,
        reason,
        refKind: input.refKind ?? null,
        refId: input.refId ?? null,
      })
      this.deps.metrics.increment('wallet_caps_rejected')
      this.deps.logger.info(
        {
          holder: holderKey(input.holder),
          asset: input.asset,
          requested: decision.requested,
          reason,
        },
        'credit capped to zero',
      )
      return {
        transaction: rejected.transaction,
        wallet: rejected.wallet,
        applied: rejected.applied,
        requested: decision.requested,
        credited: 0,
        capCode: decision.code,
      }
    }

    const result = await repos.wallets.append({
      walletId: wallet.id,
      amount: decision.amount,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      // A partial cap is recorded on the paying row, so the statement can say
      // "earned 120, credited 30, hourly limit" without a second row.
      reason: decision.code ? capReason(decision.code, decision.requested) : (input.reason ?? null),
      refKind: input.refKind ?? null,
      refId: input.refId ?? null,
    })

    this.deps.metrics.increment(result.applied ? 'wallet_credits' : 'wallet_credits_replayed')
    if (decision.code) this.deps.metrics.increment('wallet_caps_partial')

    return {
      transaction: result.transaction,
      wallet: result.wallet,
      applied: result.applied,
      requested: decision.requested,
      credited: result.applied ? decision.amount : result.transaction.amount,
      capCode: decision.code,
    }
  }

  /** The cached column — the fast read every screen uses. */
  async balanceFor(holder: IdentityRef, asset: AssetCode): Promise<number> {
    const wallet = await this.deps.repos.wallets.findByHolder(holder, asset)
    return wallet?.balance ?? 0
  }

  /**
   * Every wallet a holder owns.
   *
   * A holder with no wallet row yet is not an error and not an empty list: a
   * user has three assets from registration and a guest has `COIN`, and a
   * missing row reads as zero. Creating rows here would make a *read* write.
   */
  async balances(holder: IdentityRef, assets: readonly AssetCode[]): Promise<WalletBalance[]> {
    const found: WalletBalance[] = []
    for (const asset of assets) {
      const wallet = await this.deps.repos.wallets.findByHolder(holder, asset)
      if (!wallet) continue
      found.push({
        asset,
        balance: wallet.balance,
        status: wallet.status,
        lifetimeEarned: wallet.lifetimeEarned,
        lifetimeSpent: wallet.lifetimeSpent,
      })
    }
    return found
  }

  /** Newest first — the statement. S37 maps it to the wire shape. */
  async statement(
    holder: IdentityRef,
    asset: AssetCode,
    page: PageQuery = {},
  ): Promise<WalletTransaction[]> {
    const wallet = await this.deps.repos.wallets.findByHolder(holder, asset)
    if (!wallet) return []
    return this.deps.repos.wallets.listTransactions(wallet.id, page)
  }

  /**
   * E1, checked rather than assumed — the nightly reconciliation's core (S38).
   *
   * This does **not** repair the cached column. A silent self-heal would hide
   * the very bug the check exists to find; a non-zero drift is an `ALERT` and a
   * human decision, because the interesting question is not "what is the
   * balance" but "which write path lied".
   */
  async recompute(holder: IdentityRef, asset: AssetCode): Promise<ReconciliationReport | null> {
    const wallet = await this.deps.repos.wallets.findByHolder(holder, asset)
    if (!wallet) return null

    const computed = await this.deps.repos.wallets.sumTransactions(wallet.id)
    return {
      walletId: wallet.id,
      cached: wallet.balance,
      computed,
      drift: wallet.balance - computed,
    }
  }

  /** The caps as they currently stand — read by S22's vesting bound and by S35. */
  async capLimits(repos: Repositories = this.deps.repos): Promise<CapLimits> {
    return capLimitsFrom(await repos.rewardRules.findGlobal())
  }

  /** `min(provisional, guestVestCap)` (10 §3.4), with the cap read from data. */
  async vestable(provisional: number, repos: Repositories = this.deps.repos): Promise<number> {
    return vestableAmount(provisional, await this.capLimits(repos))
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Reads the two rolling windows and hands them to the pure policy.
   *
   * Only for capped kinds: an exempt credit skips three queries per call, which
   * matters because `GUEST_VEST` runs inside the claim transaction and every
   * extra read there is time a SQLite write lock is held.
   */
  private async decide(
    repos: Repositories,
    walletId: string,
    input: CreditInput,
  ): Promise<CapDecision> {
    const requested = Math.trunc(input.amount)
    if (input.exemptFromCaps ?? !isEarnKind(input.kind)) {
      return { requested, amount: requested, code: null, headroom: Number.POSITIVE_INFINITY }
    }

    const now = this.now().getTime()
    const hourAgo = new Date(now - HOUR_MS)
    const dayAgo = new Date(now - DAY_MS)

    const usage: CapUsage = {
      earnedLastHour: await repos.wallets.sumCreditsSince(walletId, hourAgo, EARN_KINDS),
      earnedLastDay: await repos.wallets.sumCreditsSince(walletId, dayAgo, EARN_KINDS),
      matchRewardsLastDay: await repos.wallets.countCreditsSince(walletId, dayAgo, MATCH_KINDS),
    }

    return applyCaps({
      requested,
      usage,
      limits: await this.capLimits(repos),
      isGuest: input.holder.kind === 'guest',
      countsTowardMatchCap: MATCH_KINDS.includes(input.kind),
      ...(input.capMultiplier === undefined ? {} : { multiplier: input.capMultiplier }),
    })
  }

  /**
   * A credit is positive and whole. Both checks are `ValidationError`, not
   * silent coercion: a caller asking to "credit" −50 wants the debit path and a
   * caller passing 12.7 has a formula bug, and both are worth failing loudly at
   * the boundary of the money code (P7).
   */
  private assertCreditable(input: CreditInput): void {
    if (!Number.isFinite(input.amount) || !Number.isInteger(input.amount)) {
      throw new ValidationError('Credit amount must be a whole number', {
        amount: ['errors.field.invalid'],
      })
    }
    if (input.amount < 0) {
      throw new ValidationError('Credit amount must not be negative', {
        amount: ['errors.field.tooSmall'],
      })
    }
    if (input.idempotencyKey.length === 0) {
      throw new ValidationError('Credit needs a derived idempotency key', {
        idempotencyKey: ['errors.field.required'],
      })
    }
  }
}

/** `CAP_PER_HOUR:120` → `CAP_PER_HOUR`. `null` for any other reason. */
export function capCodeOf(reason: string | null): string | null {
  if (reason === null) return null
  const code = reason.split(':')[0] ?? ''
  return code.startsWith('CAP_') ? code : null
}
