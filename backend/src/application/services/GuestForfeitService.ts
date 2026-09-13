import type { Logger } from 'pino'
import { guestForfeitKey } from '../../domain/economy/idempotency.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import { guestRef } from '../../domain/value-objects/identity.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { WalletService } from './WalletService.js'

/**
 * ★ `GUEST_FORFEIT` — S38. 10 §2.3, §3.4.
 *
 * A guest's coins are `PROVISIONAL`: they accrue, they cannot be spent, and
 * they vest into a real wallet at signup. A guest session that expires
 * unclaimed (12 hours) therefore has a balance that must stop existing — and
 * **the way it stops existing is a ledger row**, never an `UPDATE` that sets a
 * column to zero.
 *
 * That distinction is the whole of invariant E1 in one job. `balance == Σ
 * transactions` is either true of every wallet at every instant or it is not a
 * property at all, and a wipe that skipped the ledger would be the
 * reconciliation job's first false positive — and, worse, would teach whoever
 * read this code that zeroing a balance directly is a thing one may do.
 *
 * ### The key is derived, like every other one
 *
 * `forfeit:{guestSessionId}` (10 §2.4's rule, applied to a row the table does
 * not list). One session forfeits exactly once, whether by the vesting cap at
 * claim time (S22, which writes the same key) or by expiry here — so a job run
 * twice, or run against a session the claim already partially forfeited, pays
 * out nothing new.
 *
 * ### Why `allowOverdraft`
 *
 * The debit path refuses guests by design (10 §2.5): a guest converting farmed
 * coins into anything before signing up is the attack the whole provisional
 * mechanism exists to prevent. This is not that. The platform is reclaiming an
 * expired balance, not the guest spending it, and the flag is how the
 * difference is stated out loud at the one call site entitled to it.
 *
 * ### No scheduler
 *
 * Same reasoning as `ReconciliationService`: an ordinary method, invoked by
 * `scripts/dev-forfeit.ts` or by whatever the deployment already schedules. An
 * in-process timer would double-run the moment there were two instances.
 */

export interface ForfeitReport {
  readonly scanned: number
  readonly forfeited: number
  readonly coins: number
}

export interface GuestForfeitServiceDeps {
  readonly repos: Repositories
  readonly wallets: WalletService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

/** Sessions per run. A backlog is worked through over several runs, not in one. */
export const FORFEIT_BATCH_SIZE = 500

export class GuestForfeitService {
  private readonly now: () => Date

  constructor(private readonly deps: GuestForfeitServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  async run(limit = FORFEIT_BATCH_SIZE): Promise<ForfeitReport> {
    const now = this.now()
    const expired = await this.deps.repos.guests.listExpiredUnclaimed(now, limit)

    let forfeited = 0
    let coins = 0

    for (const session of expired) {
      const holder = guestRef(session.id)
      const wallet = await this.deps.repos.wallets.findByHolder(holder, 'COIN')
      if (wallet === null || wallet.balance <= 0) continue

      const result = await this.deps.wallets.debit({
        holder,
        asset: 'COIN',
        amount: wallet.balance,
        kind: 'GUEST_FORFEIT',
        idempotencyKey: guestForfeitKey(session.id),
        reason: 'GUEST_EXPIRED',
        refKind: 'guest_session',
        refId: session.id,
        // The platform reclaiming an expired balance — not the guest spending.
        allowOverdraft: true,
      })

      if (!result.applied) continue
      forfeited += 1
      coins += wallet.balance
      this.deps.metrics.increment('guest_forfeits')
    }

    this.deps.logger.info(
      { scanned: expired.length, forfeited, coins },
      'expired guest balances forfeited',
    )

    return { scanned: expired.length, forfeited, coins }
  }
}
