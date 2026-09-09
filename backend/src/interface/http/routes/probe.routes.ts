import { Router } from 'express'
import { z } from 'zod'
import type { GuestSessionService } from '../../../application/services/GuestSessionService.js'
import { enforceGuestBinding, requireIdentity } from '../middleware/authorize.js'
import { validBody, zodValidate } from '../middleware/validate.js'

/**
 * A route that exists purely so the boundary's behaviour can be *seen*
 * (11-build-plan.md S12).
 *
 * Mounted only when `NODE_ENV !== 'production'`. It is not a health check and
 * not an example endpoint — its schema is deliberately picky so that one `curl`
 * demonstrates each guarantee: a required field, a refusal to coerce `"5"` into
 * `5`, and rejection of an unknown key.
 */
export const ProbeRequestSchema = z
  .object({
    /** No `z.coerce` — that is the point. `"5"` must fail. */
    n: z.number().int().min(1).max(10),
    label: z.string().min(2).max(20).optional(),
  })
  .strict()

export type ProbeRequest = z.infer<typeof ProbeRequestSchema>

export function buildProbeRouter(guests: GuestSessionService): Router {
  const router = Router()

  router.post('/_probe', zodValidate({ body: ProbeRequestSchema }), (req, res) => {
    const body = validBody<ProbeRequest>(req)
    res.json({ ok: true, echo: body })
  })

  /**
   * The guest-binding guard, made observable before `/tables/:id` exists.
   *
   * S16's verification step wants to see a guest token refused against another
   * table with its own eyes, but the real table route arrives in S18. Rather
   * than leave the session's central property unverifiable for two sessions,
   * this stands in: same middleware, same 403, same `SEAT_IMPERSONATION` row.
   * When S18 lands, `/tables/:id` inherits `enforceGuestBinding` and this can
   * go — it is dev-only, so no production surface ever depended on it.
   */
  router.get(
    '/_probe/table/:tableId',
    requireIdentity(),
    enforceGuestBinding(guests),
    (req, res) => {
      res.json({ ok: true, tableId: req.params.tableId, identity: req.identity })
    },
  )

  return router
}
