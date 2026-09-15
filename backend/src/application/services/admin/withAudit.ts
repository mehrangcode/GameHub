import type { AdminAction, AdminTargetType } from '../../../contracts/admin/enums.js'
import type { AdminAuditEntry } from '../../../domain/entities/admin.js'
import { ReasonRequiredError } from '../../../domain/errors/admin.js'
import type { ControlCommandRow, NewControlCommand } from '../../../domain/repositories/admin.js'
import type { IUnitOfWork, Repositories } from '../../../domain/repositories/Repositories.js'

/**
 * ★★ The audit spine — 12-admin-console.md §3.5, invariant A3.
 *
 * Every mutating admin service call goes through this one wrapper, and the
 * reason it is a wrapper rather than a convention is the whole of A3: the audit
 * row is appended **inside the caller's transaction**. Either the state change
 * and its audit row both commit, or neither does. There is no window in which
 * somebody was disabled and no row says who did it, and no window in which a
 * row claims something that was rolled back.
 *
 * This is the same discipline as the wallet ledger, and for the same reason: a
 * balance written without a ledger row and a ban applied without an audit row
 * are the same class of mistake — a fact with no history, discovered months
 * later by the one person who needed the history.
 *
 * > **On its location.** 12 §2.3 files this under `infrastructure/admin/`. It
 * > lives in `application/` instead because it depends on nothing but
 * > `IUnitOfWork` and `Repositories`, both of which are *domain* interfaces —
 * > and because every caller is an application service, which ESLint guard 1
 * > forbids from importing `infrastructure/**`. Putting it where the document
 * > says would make the rule it enforces unenforceable.
 */

export interface AdminActionContext {
  readonly actor: { readonly id: string }
  readonly ip: string
  readonly userAgent: string
  readonly requestId: string
  /** Required for 📝 actions; see {@link assertReason}. */
  readonly reason: string | null
}

export interface AuditTarget {
  readonly type: AdminTargetType
  readonly id: string
}

export interface AuditedResult<T> {
  readonly result: T
  /** Snapshot before the change. Stored as JSON; never queried into (rule 3). */
  readonly before?: unknown
  readonly after?: unknown
  /**
   * Commands for the gameplay process — 12 §6.1.
   *
   * ★ Returned rather than written, and that is not a style preference. A
   * `ControlCommand` carries the `auditLogId` that produced it, and the audit
   * row does not exist until after `fn` has finished. Letting `fn` write the
   * command itself would mean either a placeholder id that nothing could join
   * on, or a second transaction that could commit without the first.
   *
   * So `fn` declares its commands and `withAudit` writes them, in the same
   * transaction, once the real id is in hand. The gateway's "closed table X"
   * log line then points back at who ordered it and why, which is the entire
   * reason the column exists.
   */
  readonly commands?: readonly Omit<NewControlCommand, 'auditLogId'>[]
}

export interface WithAuditDeps {
  readonly uow: IUnitOfWork
  readonly now?: () => Date
}

/**
 * Runs `fn` in a transaction and appends exactly one `AdminAuditLog` row to it.
 *
 * `fn` receives the transactional `Repositories`, so everything it writes and
 * the audit row share one commit. It returns the value to hand back plus the
 * before/after snapshots — asking for them as *return values* rather than
 * letting the caller write them means a caller cannot forget: the type will not
 * compile without the shape, and the shape is where the diff goes.
 */
export async function withAudit<T>(
  deps: WithAuditDeps,
  context: AdminActionContext,
  action: AdminAction,
  target: AuditTarget,
  fn: (repos: Repositories) => Promise<AuditedResult<T>>,
): Promise<{ result: T; entry: AdminAuditEntry; commands: readonly ControlCommandRow[] }> {
  const at = deps.now?.() ?? new Date()

  return deps.uow.run(async (repos) => {
    const { result, before, after, commands = [] } = await fn(repos)

    const entry = await repos.adminAudit.append(
      {
        actorUserId: context.actor.id,
        actorIp: context.ip,
        actorUserAgent: context.userAgent,
        requestId: context.requestId,
        action,
        targetType: target.type,
        targetId: target.id,
        reason: context.reason,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      },
      at,
    )

    // After the audit row, inside the same transaction: all three exist or
    // none do (§6.1's ordering, which is the whole of A6).
    const written: ControlCommandRow[] = []
    for (const command of commands) {
      written.push(await repos.controlCommands.append({ ...command, auditLogId: entry.id }, at))
    }

    return { result, entry, commands: written }
  })
}

/**
 * 📝 — 12 §5.1. Thrown **before** the transaction opens, so a route called
 * without a reason changes nothing at all.
 *
 * A blank string counts as missing. `reason` is a column and an error, not a UI
 * placeholder: six months later, "who disabled this account" is answerable from
 * the row and "why" is answerable only if somebody was made to type it.
 */
export function assertReason(reason: string | null | undefined, action: AdminAction): string {
  const trimmed = reason?.trim() ?? ''
  if (trimmed === '') throw new ReasonRequiredError(action)
  return trimmed
}
