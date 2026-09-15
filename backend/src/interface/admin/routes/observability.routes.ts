import { Router } from 'express'
import { z } from 'zod'
import type { Container } from '../../../container.js'
import { SECURITY_EVENT_KINDS } from '../../../contracts/enums.js'
import { asyncHandler } from '../../http/middleware/error.js'
import { validQuery, zodValidate } from '../../http/middleware/validate.js'

/**
 * `GET /metrics` and `GET /security-events` — 12-admin-console.md §5, §11.1.
 *
 * ★ **These routes were specified for S15 and are deliberately not there.**
 * As originally written they sat on the public port behind a role check, which
 * is precisely the arrangement §2.4 exists to prevent: a role check on `:3000`
 * is one refactor away from no check at all, and the thing it would have been
 * guarding is a complete list of every security event on the platform. S15 was
 * amended to record events and increment counters and to expose **neither**
 * over HTTP; this is where they surface instead.
 *
 * `tests/integration/admin/auth.test.ts` asserts both answer on the admin app
 * and 404 on the public one — the permanent version of that decision.
 *
 * Both are **S**-level: reading is what `SUPPORT` exists for.
 */

const SecurityEventQuerySchema = z
  .object({
    kind: z.enum(SECURITY_EVENT_KINDS).optional(),
    userId: z.string().optional(),
    since: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict()

type SecurityEventQuery = z.infer<typeof SecurityEventQuerySchema>

export function buildAdminObservabilityRouter(container: Container): Router {
  const router = Router()

  /**
   * Counters and gauges since this process started.
   *
   * Not Prometheus text format: there is no scraper in this deployment, and a
   * JSON body is what the console's dashboard renders. If a scraper ever
   * arrives, an exposition-format route is ten lines next to this one — the
   * registry is the part worth having got right.
   */
  router.get('/metrics', (_req, res) => {
    res.json(container.metrics.snapshot())
  })

  /**
   * The audit trail S15 has been filling since Phase C — every `BAD_TOKEN`,
   * `SEAT_IMPERSONATION`, `RATE_LIMIT`, `LEDGER_DRIFT` and the rest.
   *
   * Newest first, cursor-paginated. `details` travels as parsed JSON, so the
   * console can render "wallet X cached 999999, computed 500" without knowing
   * what a `LEDGER_DRIFT` row looks like.
   */
  router.get(
    '/security-events',
    zodValidate({ query: SecurityEventQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = validQuery<SecurityEventQuery>(req)

      const rows = await container.repos.securityEvents.list(
        {
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(query.userId === undefined ? {} : { userId: query.userId }),
          ...(query.since === undefined ? {} : { since: query.since }),
        },
        {
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { before: query.cursor }),
        },
      )

      res.json({
        items: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          severity: row.severity,
          userId: row.userId,
          guestSessionId: row.guestSessionId,
          tableId: row.tableId,
          gameId: row.gameId,
          ip: row.ip,
          userAgent: row.userAgent,
          details: row.details,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: rows.length < query.limit ? null : (rows.at(-1)?.id ?? null),
      })
    }),
  )

  return router
}
