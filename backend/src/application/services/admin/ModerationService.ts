import type { Logger } from 'pino'
import type { AdminAuditEntry } from '../../../domain/entities/admin.js'
import type { User } from '../../../domain/entities/user.js'
import { SelfTargetError } from '../../../domain/errors/admin.js'
import { NotFoundError } from '../../../domain/errors/errors.js'
import type { IUnitOfWork, Repositories } from '../../../domain/repositories/Repositories.js'
import type { MetricsRegistry } from '../MetricsRegistry.js'
import { assertReason, withAudit, type AdminActionContext } from './withAudit.js'

/**
 * Moderation — 12-admin-console.md §7.1. S50 implements one action of it.
 *
 * ★ **Disabling somebody costs them nothing** — invariant A8, and the single
 * most important line in this file. An ejection for idling forfeits the match's
 * rewards (10 §5.1) because forfeiture punishes *idling*; a
 * platform-initiated interruption is not idling, and treating the two the same
 * would mean an operator investigating a report accidentally fining the person
 * they were investigating. So `disableUser` touches no wallet, writes no
 * `CAP_REJECTED` row, and settles nothing.
 *
 * The three effects it *does* have, and where each happens:
 *
 * | Effect | Where | Why there |
 * |---|---|---|
 * | `status` → `DISABLED` | here, in the transaction | It is a row this process owns |
 * | Player + admin sessions revoked | here, in the transaction | Same |
 * | Sockets dropped, seat released, bot substituted | **the api process**, via a `ControlCommand` | The gameplay sockets live in the other process (§6) |
 *
 * That third row is the deferral worth being explicit about: S50 writes the
 * outbox row inside the same transaction, and **the consumer arrives at M3**
 * per §11.1. Until then a disabled player's existing socket survives until it
 * reconnects — at which point `authenticate` refuses it, because
 * `interface/http/middleware/authenticate.ts` re-reads `user.status` on every
 * request and every handshake. The gap is "a live socket keeps playing the
 * current hand", not "a banned player keeps full access".
 */

export interface ModerationDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

export interface DisableUserResult {
  readonly user: User
  readonly refreshFamiliesRevoked: number
  readonly adminSessionsRevoked: number
  readonly entry: AdminAuditEntry
  /** The outbox row the api process will consume at M3. */
  readonly controlCommandId: string | null
}

export class ModerationService {
  private readonly now: () => Date

  constructor(private readonly deps: ModerationDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * `POST /users/:id/disable` — ⚡📝.
   *
   * Everything below runs inside `withAudit`, so the status change, the token
   * revocations, the control command and the audit row share one commit. A
   * throw anywhere leaves the account exactly as it was, with no row claiming
   * otherwise.
   */
  async disableUser(
    targetUserId: string,
    context: AdminActionContext,
  ): Promise<DisableUserResult> {
    const reason = assertReason(context.reason, 'user.disable')

    if (targetUserId === context.actor.id) {
      // The realistic version of this is not malice: it is an operator with two
      // tabs open. Recovery from a console nobody can sign into is CLI plus
      // database access, at whatever hour it happens.
      throw new SelfTargetError({ action: 'user.disable' })
    }

    const now = this.now()
    const { result, entry, commands } = await withAudit(
      { uow: this.deps.uow, now: () => now },
      { ...context, reason },
      'user.disable',
      { type: 'user', id: targetUserId },
      async (repos) => {
        const before = await repos.users.findById(targetUserId)
        if (before === null) throw new NotFoundError('User', { id: targetUserId })

        const user = await repos.users.update(targetUserId, {
          status: 'DISABLED',
          statusReason: reason,
          statusChangedAt: now,
          statusChangedBy: context.actor.id,
        })

        // Every refresh family, not just the newest: a player signed in on a
        // phone and a laptop holds two, and revoking one leaves the other
        // minting access tokens for a disabled account for thirty days.
        const families = new Set(
          (await repos.refreshTokens.listActiveByUser(targetUserId, now)).map((t) => t.familyId),
        )
        let refreshFamiliesRevoked = 0
        for (const familyId of families) {
          await repos.refreshTokens.revokeFamily(familyId, now)
          refreshFamiliesRevoked += 1
        }

        // If the target is themselves an admin, their console session dies too.
        const adminSessionsRevoked = await repos.adminSessions.revokeAllForUser(targetUserId, now)

        return {
          result: { user, refreshFamiliesRevoked, adminSessionsRevoked },
          // Declared, not written: `withAudit` appends it once the audit row's
          // id exists, in this same transaction. See `AuditedResult.commands`.
          commands: [{ kind: 'user.disabled' as const, payload: { userId: targetUserId } }],
          // The diff the console renders, and the only part of this an
          // investigation six months later actually needs.
          before: { status: before.status, statusReason: before.statusReason },
          after: { status: user.status, statusReason: user.statusReason },
        }
      },
    )

    this.deps.metrics.increment('admin_users_disabled')
    this.deps.logger.warn(
      { targetUserId, actorUserId: context.actor.id, reason, auditLogId: entry.id },
      'admin disabled a user',
    )

    return { ...result, entry, controlCommandId: commands[0]?.id ?? null }
  }
}
