import { z } from 'zod'
import type { Container } from '../../../container.js'
import type { AdminServices } from '../../../container.js'
import { ADMIN_ACTIONS, ADMIN_TARGET_TYPES } from '../../../contracts/admin/enums.js'
import { ASSET_CODES, USER_ROLES, USER_STATUSES } from '../../../contracts/enums.js'
import type { AdminAuditEntry } from '../../../domain/entities/admin.js'
import type { User } from '../../../domain/entities/user.js'
import { NotFoundError } from '../../../domain/errors/errors.js'
import { asyncHandler } from '../../http/middleware/error.js'
import { adminActionContext } from '../middleware/auditContext.js'
import type { AdminHandlers } from '../routes/adminRouter.js'

/**
 * S50's controllers — three reads and one write, keyed by their manifest entry.
 *
 * Kept thin on purpose. Each one parses, calls a service, and maps the result
 * to a DTO; every decision that matters — who may call it, whether a fresh
 * factor is needed, whether a reason is mandatory, whether an audit row is
 * written — lives in the manifest and in `withAudit`, where it is enforced for
 * routes that do not exist yet.
 *
 * ★ Note what no controller does: none of them reads `req.body.userId` or any
 * other caller-supplied identity. The actor comes from `req.admin.user`, which
 * came from the session. Same rule as "seat identity comes from the socket,
 * never the payload" — there is no field with which to act as somebody else.
 */

const UserSearchQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    status: z.enum(USER_STATUSES).optional(),
    role: z.enum(USER_ROLES).optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().optional(),
  })
  .strict()

const AuditQuerySchema = z
  .object({
    actorUserId: z.string().optional(),
    action: z.enum(ADMIN_ACTIONS).optional(),
    targetType: z.enum(ADMIN_TARGET_TYPES).optional(),
    targetId: z.string().optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().optional(),
  })
  .strict()

const DisableBodySchema = z.object({ reason: z.string().min(1).max(500) }).strict()

export function buildAdminHandlers(container: Container, services: AdminServices): AdminHandlers {
  return {
    'users.list': asyncHandler(async (req, res) => {
      const query = UserSearchQuerySchema.parse(req.query)

      const users = await container.repos.users.search(
        {
          ...(query.q === undefined ? {} : { query: query.q }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.role === undefined ? {} : { role: query.role }),
          ...(query.createdAfter === undefined ? {} : { createdAfter: query.createdAfter }),
          ...(query.createdBefore === undefined ? {} : { createdBefore: query.createdBefore }),
        },
        { limit: query.limit, ...(query.cursor === undefined ? {} : { before: query.cursor }) },
      )

      res.json({
        items: users.map(toAdminUserSummary),
        nextCursor: users.length < query.limit ? null : (users.at(-1)?.id ?? null),
      })
    }),

    'users.get': asyncHandler(async (req, res) => {
      const id = pathParam(req.params.id)
      const user = await container.repos.users.findById(id)
      if (user === null) throw new NotFoundError('User', { id })

      /**
       * Balances come from the wallet repository rather than from a join, so
       * the number shown here is the same cached column the reconciliation job
       * checks — an admin screen that computed its own total would quietly
       * disagree with the ledger, and nobody would know which was right.
       *
       * ★ It shows the **cached** balance and does not recompute `Σ ledger`.
       * That is deliberate: `POST /wallets/:userId/reconcile` (M2) is where the
       * two are compared, and a detail page that silently reconciled would hide
       * exactly the drift E1 exists to surface.
       */
      const wallets = (
        await Promise.all(
          ASSET_CODES.map((assetCode) =>
            container.repos.wallets.findByHolder({ kind: 'user', userId: id }, assetCode),
          ),
        )
      ).filter((wallet) => wallet !== null)

      res.json({
        ...toAdminUserSummary(user),
        statusChangedAt: user.statusChangedAt?.toISOString() ?? null,
        statusChangedBy: user.statusChangedBy,
        emailVerified: user.emailVerified,
        lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
        wallets: wallets.map((wallet) => ({
          assetCode: wallet.assetCode,
          balance: wallet.balance,
          status: wallet.status,
        })),
      })
    }),

    'audit.list': asyncHandler(async (req, res) => {
      const query = AuditQuerySchema.parse(req.query)

      const entries = await services.audit.list(
        {
          ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId }),
          ...(query.action === undefined ? {} : { action: query.action }),
          ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
          ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
          ...(query.since === undefined ? {} : { since: query.since }),
          ...(query.until === undefined ? {} : { until: query.until }),
        },
        { limit: query.limit, ...(query.cursor === undefined ? {} : { before: query.cursor }) },
      )

      res.json({
        items: entries.map(toAuditDto),
        nextCursor: entries.length < query.limit ? null : (entries.at(-1)?.id ?? null),
      })
    }),

    'audit.verify': asyncHandler(async (_req, res) => {
      const verification = await services.audit.verify()
      // 200 either way. A broken chain is a *finding*, not a request failure —
      // the console has to render it, and a 500 would look like the endpoint
      // was down rather than like the log was tampered with.
      res.json(verification)
    }),

    'users.disable': asyncHandler(async (req, res) => {
      const body = DisableBodySchema.parse(req.body)
      const context = adminActionContext(req)

      const result = await services.moderation.disableUser(pathParam(req.params.id), {
        ...context,
        reason: body.reason,
      })

      res.json({
        user: toAdminUserSummary(result.user),
        refreshFamiliesRevoked: result.refreshFamiliesRevoked,
        adminSessionsRevoked: result.adminSessionsRevoked,
        auditLogId: result.entry.id,
        controlCommandId: result.controlCommandId,
      })
    }),
  }
}

/**
 * Express 5 types a route param as `string | string[]`. Every admin path
 * declares `:id` exactly once, so the array form is unreachable — but throwing
 * rather than coercing keeps that an assertion instead of an assumption.
 */
function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') {
    throw new NotFoundError('User', { id: String(value) })
  }
  return value
}

/** Never carries `passwordHash`. The mapper is the only reason that is guaranteed. */
function toAdminUserSummary(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    statusReason: user.statusReason,
    createdAt: user.createdAt.toISOString(),
  }
}

function toAuditDto(entry: AdminAuditEntry) {
  return {
    id: entry.id,
    actorUserId: entry.actorUserId,
    actorIp: entry.actorIp,
    actorUserAgent: entry.actorUserAgent,
    requestId: entry.requestId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    reason: entry.reason,
    before: entry.before,
    after: entry.after,
    // The hashes travel so the console can show the chain, and so an operator
    // can verify a row by hand against `computeAuditHash` without database
    // access — which is the point of a chain anyone can check.
    prevHash: entry.prevHash,
    hash: entry.hash,
    createdAt: entry.createdAt.toISOString(),
  }
}
