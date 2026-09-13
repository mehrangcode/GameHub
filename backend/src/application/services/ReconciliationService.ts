import type { Logger } from 'pino'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { SecurityEventService } from './SecurityEventService.js'

/**
 * ★ E1, checked rather than assumed — S38. 10 §2.3, the M0 exit criterion.
 *
 *     balance(holder, asset) == Σ WalletTransaction.amount
 *
 * That equation is the foundation the whole economy stands on, and until this
 * job existed it was a *claim*. Now it is a measurement: every wallet is
 * recomputed from its own ledger rows, and any disagreement raises an `ALERT`
 * `SecurityEvent` and logs at `error`.
 *
 * ### It does not repair anything, deliberately
 *
 * A self-healing job would set the column to the computed value and move on —
 * and would thereby destroy the only evidence that a write path is broken. The
 * interesting question is never "what is the balance"; the ledger has always
 * answered that. It is **which code path wrote a number that disagreed with
 * the row it was supposed to accompany**, and that is a human's question. So
 * the job reports, loudly, and stops.
 *
 * ### Why there is no scheduler
 *
 * Nothing in this codebase runs on a timer that outlives a request, and this
 * job does not introduce one. It is an ordinary service with an ordinary
 * method, invoked by `scripts/dev-reconcile.ts` in development and by whatever
 * the deployment already uses — system cron, a platform scheduler, a CI job —
 * in production. An in-process `setInterval` would be simpler today and wrong
 * the moment there are two API instances, since both would reconcile the same
 * wallets and both would alert.
 *
 * ### Paging
 *
 * `listPaged` rather than "load every wallet": this is the one query whose
 * result set grows with the entire user base, and a job that holds all of it in
 * memory stops working on precisely the day the platform starts mattering.
 */

/** One wallet that disagreed with its own ledger. */
export interface WalletDrift {
  readonly walletId: string
  readonly userId: string | null
  readonly guestSessionId: string | null
  readonly asset: string
  readonly cached: number
  readonly computed: number
  /** `cached - computed`. Positive means coins that were never earned. */
  readonly drift: number
}

export interface ReconciliationReport {
  readonly scanned: number
  readonly drifted: readonly WalletDrift[]
  readonly startedAt: Date
  readonly finishedAt: Date
}

export interface ReconciliationServiceDeps {
  readonly repos: Repositories
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

/** Wallets per page. Small enough to stay cheap, large enough to stay quick. */
export const RECONCILE_PAGE_SIZE = 200

export class ReconciliationService {
  private readonly now: () => Date

  constructor(private readonly deps: ReconciliationServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  async run(): Promise<ReconciliationReport> {
    const startedAt = this.now()
    const drifted: WalletDrift[] = []
    let scanned = 0
    let cursor: string | null = null

    for (;;) {
      const page: Awaited<ReturnType<Repositories['wallets']['listPaged']>> =
        await this.deps.repos.wallets.listPaged(cursor, RECONCILE_PAGE_SIZE)
      if (page.length === 0) break

      for (const wallet of page) {
        scanned += 1
        const computed = await this.deps.repos.wallets.sumTransactions(wallet.id)
        if (computed === wallet.balance) continue

        const record: WalletDrift = {
          walletId: wallet.id,
          userId: wallet.userId,
          guestSessionId: wallet.guestSessionId,
          asset: wallet.assetCode,
          cached: wallet.balance,
          computed,
          drift: wallet.balance - computed,
        }
        drifted.push(record)
        await this.alert(record)
      }

      cursor = page.at(-1)?.id ?? null
      if (page.length < RECONCILE_PAGE_SIZE) break
    }

    this.deps.metrics.increment('reconciliations_run')
    const finishedAt = this.now()

    this.deps.logger.info(
      { scanned, drifted: drifted.length, ms: finishedAt.getTime() - startedAt.getTime() },
      drifted.length === 0 ? 'ledger reconciled clean' : 'ledger reconciliation found drift',
    )

    return { scanned, drifted, startedAt, finishedAt }
  }

  /**
   * `ALERT`, and awaited.
   *
   * The usual `SecurityEventService.record` is fire-and-forget because an audit
   * failure must not fail the audited request (S15). Here there is no request
   * to protect, and the whole *product* of the job is the alert — so it is
   * awaited, and a failure to write it is worth knowing about.
   */
  private async alert(drift: WalletDrift): Promise<void> {
    this.deps.metrics.increment('reconciliation_drift_detected')

    this.deps.logger.error(
      {
        walletId: drift.walletId,
        asset: drift.asset,
        cached: drift.cached,
        computed: drift.computed,
        drift: drift.drift,
      },
      'ALERT: cached wallet balance disagrees with its ledger (E1)',
    )

    await this.deps.security.recordAndWait(
      'LEDGER_DRIFT',
      {
        userId: drift.userId,
        guestSessionId: drift.guestSessionId,
        details: {
          walletId: drift.walletId,
          asset: drift.asset,
          cached: drift.cached,
          computed: drift.computed,
          drift: drift.drift,
        },
      },
      'ALERT',
    )
  }
}
