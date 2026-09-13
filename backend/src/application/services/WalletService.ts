import type { Logger } from 'pino'
import type { AssetCode, TransactionKind } from '../../contracts/enums.js'
import type { Wallet, WalletTransaction } from '../../domain/entities/economy.js'
import { adminAdjustKey } from '../../domain/economy/idempotency.js'
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
import {
  ForbiddenError,
  InsufficientFundsError,
  ValidationError,
} from '../../domain/errors/errors.js'
import type { PageQuery } from '../../domain/repositories/IRepository.js'
import type { IUnitOfWork, Repositories } from '../../domain/repositories/Repositories.js'
import { holderKey, type IdentityRef } from '../../domain/value-objects/identity.js'
import { holderRoom, type IRealtimePublisher } from '../ports/realtime.js'
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

/** The debit half of {@link CreditInput}. `amount` is the **positive** magnitude. */
export interface DebitInput {
  readonly holder: IdentityRef
  readonly asset: AssetCode
  /** Positive. The sign is applied by {@link WalletService.debit}. */
  readonly amount: number
  readonly kind: TransactionKind
  readonly idempotencyKey: string
  readonly reason?: string
  readonly refKind?: string
  readonly refId?: string
  /**
   * Bypasses the guest refusal **and** the balance check. Set by exactly one
   * caller — an operator clawing back a credit that should never have been
   * made (12 §7.2). A guest's forfeited provisional balance uses it too, since
   * expiry is the platform zeroing a wallet, not the guest spending it.
   */
  readonly allowOverdraft?: boolean
}

export interface AdminAdjustInput {
  readonly holder: IdentityRef
  readonly asset: AssetCode
  /** Signed: positive credits, negative claws back. */
  readonly amount: number
  /** ★ Mandatory, and enforced. Not a UI placeholder — 12 §7.2. */
  readonly reason: string
  /** The audit row that authorised it. The idempotency key is derived from it. */
  readonly auditLogId: string
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
  /** S37. Optional: every unit test in `tests/unit/wallet` runs without one. */
  readonly realtime?: IRealtimePublisher
  readonly now?: () => Date
}

/** Short enough to be typeable, long enough that "x" is not a reason. */
export const ADMIN_ADJUST_REASON_MIN = 4

export class WalletService {
  private readonly now: () => Date

  constructor(private readonly deps: WalletServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** Opens its own transaction. See {@link creditWithin} for the nested case. */
  async credit(input: CreditInput): Promise<CreditResult> {
    const result = await this.deps.uow.run(async (repos) => this.creditWithin(repos, input))
    await this.announce(input.holder, input.asset, {
      delta: result.applied ? result.credited : 0,
      reason: result.transaction.reason ?? result.transaction.kind,
    })
    return result
  }

  /**
   * ★ `wallet:updated` — 10 §10. Called **after** the transaction commits.
   *
   * Never from inside one, and the reason is the obvious one: a transaction can
   * still roll back, and a client told its balance rose to 340 by a write that
   * then vanished has been lied to in the one part of the product where being
   * lied to matters. {@link creditWithin} therefore announces nothing — the
   * caller that owns the transaction owns the announcement, which is why
   * `SettlementService` calls this once per holder after its own commit.
   *
   * `vested` and `provisional` are reported separately because they mean
   * different things to the reader: a guest's provisional balance is the entire
   * signup pitch ("120 coins waiting"), and one combined number could not
   * render it.
   *
   * Failures are swallowed. A notification that did not arrive is a stale
   * screen and a refresh; an exception here would turn a *successful payment*
   * into a failed request, which is strictly worse.
   */
  async announce(
    holder: IdentityRef,
    asset: AssetCode,
    change: { delta?: number; reason?: string } = {},
  ): Promise<void> {
    if (this.deps.realtime === undefined) return

    try {
      const wallet = await this.deps.repos.wallets.findByHolder(holder, asset)
      if (wallet === null) return

      this.deps.realtime.publish(holderRoom(holder), 'wallet:updated', {
        asset,
        vested: wallet.status === 'VESTED' ? wallet.balance : 0,
        provisional: wallet.status === 'PROVISIONAL' ? wallet.balance : 0,
        ...(change.delta === undefined ? {} : { delta: change.delta }),
        ...(change.reason === undefined || change.reason === null ? {} : { reason: change.reason }),
      })
    } catch (error) {
      this.deps.logger.warn({ err: error, asset }, 'wallet:updated could not be sent')
    }
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

  /**
   * ★ The debit path — S38. 10 §2.5, and the one place money leaves a wallet.
   *
   * Three things happen in one transaction, in this order, and the order is the
   * safety property:
   *
   *   1. **`balanceForUpdate` takes a row lock.** A plain read followed by a
   *      write is a real double-spend: two purchases arriving together both see
   *      the same balance, both pass the check, and both debit. The lock is
   *      what makes exactly one of them win.
   *   2. the balance is checked against the amount, and an insufficient one
   *      throws **before anything is written** — there is no partial debit and
   *      no state to unwind.
   *   3. `append` writes the negative row and the cached balance together (E1).
   *
   * Idempotent by the same derived key as a credit: a retried purchase returns
   * the original row and charges nothing.
   *
   * No store UI hangs off this yet — M7 owns the catalogue and the cosmetic
   * grant. This is the primitive, built now because the *concurrency* property
   * is the thing worth getting right while it is cheap to test.
   */
  async debit(input: DebitInput): Promise<CreditResult> {
    this.assertSpendable(input)

    const result = await this.deps.uow.run(async (repos) => {
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
          capCode: null,
        }
      }

      const available = await repos.wallets.balanceForUpdate(wallet.id)
      if (available < input.amount && input.allowOverdraft !== true) {
        this.deps.metrics.increment('wallet_debits_refused')
        throw new InsufficientFundsError(input.amount, available, { asset: input.asset })
      }

      const appended = await repos.wallets.append({
        walletId: wallet.id,
        amount: -input.amount,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason ?? null,
        refKind: input.refKind ?? null,
        refId: input.refId ?? null,
      })

      this.deps.metrics.increment('wallet_debits')
      return {
        transaction: appended.transaction,
        wallet: appended.wallet,
        applied: appended.applied,
        requested: input.amount,
        credited: -input.amount,
        capCode: null,
      }
    })

    await this.announce(input.holder, input.asset, {
      delta: result.applied ? -input.amount : 0,
      reason: input.reason ?? input.kind,
    })
    return result
  }

  /**
   * ★ 12 §7.2 — an operator moving somebody's balance by hand.
   *
   * Two things are non-negotiable and both are enforced here rather than in the
   * admin UI, because a UI is a suggestion and a service is a rule:
   *
   *   - **A written reason.** `reason` is a column and a refusal, not a
   *     placeholder. An adjustment nobody can explain later is indistinguishable
   *     from a bug in the credit path, and this is the one transaction kind with
   *     no causing event to point at.
   *   - **A derived key.** `admin:{auditLogId}` (10 §2.4) ties the money to the
   *     audit row that authorised it, so "the balance moved" and "somebody is
   *     accountable for it" cannot exist apart — the same discipline the ledger
   *     applies to every other credit.
   *
   * Exempt from the earn caps: an operator correcting a mistake must not have
   * the correction silently eaten, which would make the ledger *less* true.
   * The admin routes that call this land in Phase L; the primitive is here
   * because it belongs beside the ledger, not beside the console.
   */
  async adminAdjust(input: AdminAdjustInput): Promise<CreditResult> {
    const reason = input.reason.trim()
    if (reason.length < ADMIN_ADJUST_REASON_MIN) {
      throw new ValidationError('An admin adjustment requires a written reason', {
        reason: ['errors.field.required'],
      })
    }

    const idempotencyKey = adminAdjustKey(input.auditLogId)
    const tagged = `ADMIN_ADJUST:${reason}`

    return input.amount >= 0
      ? this.credit({
          holder: input.holder,
          asset: input.asset,
          amount: input.amount,
          kind: 'ADMIN_ADJUST',
          idempotencyKey,
          reason: tagged,
          refKind: 'admin_audit',
          refId: input.auditLogId,
        })
      : this.debit({
          holder: input.holder,
          asset: input.asset,
          amount: -input.amount,
          kind: 'ADMIN_ADJUST',
          idempotencyKey,
          reason: tagged,
          refKind: 'admin_audit',
          refId: input.auditLogId,
          // An operator clawing back an erroneous credit must be able to, even
          // if the holder has already spent some of it. The ledger stays true;
          // the balance is allowed to go negative and be visible as such.
          allowOverdraft: true,
        })
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
   * ★ Guests cannot spend — 10 §2.2, §2.5.
   *
   * This is not a UI rule with a service check behind it; it is the *only*
   * check, and it removes a whole class of attack rather than one exploit: a
   * guest session that could convert farmed provisional coins into anything
   * before signing up would make guest sessions a coin faucet with an exit,
   * and the vesting cap (10 §3.4) would bound nothing.
   *
   * `403`, not `409`: spending needs an account, and "refresh and retry" is
   * advice a guest can never act on. Same reasoning as `requireUser` (S13).
   */
  private assertSpendable(input: DebitInput): void {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new ValidationError('A debit must be a positive whole number', {
        amount: ['errors.field.invalid'],
      })
    }
    if (input.holder.kind === 'guest' && input.allowOverdraft !== true) {
      throw new ForbiddenError('Guests cannot spend', {
        i18nKey: 'errors.guestCannotSpend',
        holder: holderKey(input.holder),
      })
    }
    if (input.idempotencyKey.length === 0) {
      throw new ValidationError('A debit needs a derived idempotency key', {
        idempotencyKey: ['errors.field.required'],
      })
    }
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
