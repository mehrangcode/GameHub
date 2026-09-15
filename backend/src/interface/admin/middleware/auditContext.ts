import type { Request, RequestHandler } from 'express'
import type { AdminActionContext } from '../../../application/services/admin/withAudit.js'
import { ReasonRequiredError } from '../../../domain/errors/admin.js'
import { UnauthorizedError } from '../../../domain/errors/errors.js'
import { clientIp } from '../../http/middleware/rateLimit.js'
import { requestIdOf } from '../../http/middleware/requestId.js'
import type { AdminRouteSpec } from '../manifest.js'

/**
 * Turns a request into the `AdminActionContext` every audit row is written
 * from — 12-admin-console.md §3.5.
 *
 * Actor, address, user agent and `requestId` come from the request; `reason`
 * comes from the body. Assembling it once, in middleware generated from the
 * manifest, is what stops each controller from inventing its own idea of who
 * the actor is — and `actorUserId` being read from the *session* rather than
 * from anything the client sent is the same rule as "seat identity comes from
 * the socket, never the payload".
 */
export function adminActionContext(req: Request): AdminActionContext {
  const admin = req.admin
  if (admin === undefined) {
    throw new UnauthorizedError('Admin authentication required', { reason: 'NO_ADMIN_SESSION' })
  }

  const body = req.body as { reason?: unknown } | undefined
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''

  return {
    actor: { id: admin.user.id },
    ip: clientIp(req),
    userAgent: req.get('user-agent') ?? 'unknown',
    requestId: requestIdOf(req),
    reason: reason === '' ? null : reason,
  }
}

/**
 * 📝 — refuses before the controller runs, so nothing is written.
 *
 * Generated onto every `requiresReason` route by `mountManifest`, which is why
 * the enforcement cannot be forgotten on a new one: forgetting it would mean
 * leaving the flag off in the manifest, and the manifest-driven test in
 * `tests/integration/admin/spine.test.ts` reads the same array.
 */
export function requireReason(spec: AdminRouteSpec): RequestHandler {
  return (req, _res, next) => {
    const body = req.body as { reason?: unknown } | undefined
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''

    if (reason === '') {
      // `spec.action` names the action in the error, so the console can say
      // "why are you disabling this account?" rather than "reason required".
      next(new ReasonRequiredError(spec.action ?? spec.key))
      return
    }
    next()
  }
}
