import type { Request, RequestHandler } from 'express'
import type { AdminServices } from '../../../container.js'
import type { AdminEnv } from '../../../config/env.js'
import type { UserRole } from '../../../contracts/enums.js'
import { ADMIN_COOKIES } from '../../../contracts/admin/auth.js'
import { StepUpRequiredError } from '../../../domain/errors/admin.js'
import { ForbiddenError, UnauthorizedError } from '../../../domain/errors/errors.js'
import {
  AdminTokenError,
  clearAdminCookies,
  verifyAdminAccessToken,
} from '../../../infrastructure/admin/adminTokens.js'
import { asyncHandler } from '../../http/middleware/error.js'
import { clientIp } from '../../http/middleware/rateLimit.js'

/**
 * The admin authorization chain — 12-admin-console.md §3.2, §3.4, §5.
 *
 * Read alongside `interface/http/middleware/authorize.ts`, whose level **A** is
 * documented as "used by the admin process". This is that use, and the shape is
 * deliberately different in one way that matters: `authenticate` on the public
 * side **never rejects** — an absent cookie simply leaves the request anonymous
 * and `authorize` decides. Here, `adminAuthenticate` rejects outright.
 *
 * The difference is not inconsistency. The public app has genuinely public
 * routes (`GET /games`, `GET /invites/:code`) and an anonymous request is a
 * legitimate state it must serve. The admin app has exactly two routes anyone
 * unauthenticated may reach — `/health` and the login pair — and they are
 * mounted before this middleware. Everything after it is privileged, so
 * "resolve and let the route decide" would be one forgotten guard away from an
 * open endpoint.
 */

/** Level **S** — any signed-in admin (`SUPPORT` or `ADMIN`). */
export function adminAuthenticate(services: AdminServices, env: AdminEnv): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const token = cookie(req, ADMIN_COOKIES.access)
    if (token === undefined) {
      next(new UnauthorizedError('Admin authentication required', { reason: 'NO_ADMIN_SESSION' }))
      return
    }

    try {
      const claims = await verifyAdminAccessToken(token, env)
      // Every request re-reads the session and the user. Fifteen minutes of
      // stateless authority is fine for a player; for an account that can ban
      // people and mint coins, a revoked session has to stop working now.
      req.admin = await services.auth.resolveSession(claims.sid, { ip: clientIp(req) })
      next()
    } catch (error) {
      if (error instanceof AdminTokenError) {
        // An *expired* access token is the normal end of every 15-minute
        // window — leave the cookies alone so `/auth/refresh` can rotate them.
        // Anything else is a token we did not mint: clear both, or the browser
        // retries a dead credential for ever.
        if (error.failure !== 'expired') clearAdminCookies(res, env)
        next(
          new UnauthorizedError('Admin session is not valid', {
            reason: error.failure === 'expired' ? 'ACCESS_EXPIRED' : 'ACCESS_INVALID',
          }),
        )
        return
      }
      next(error)
    }
  })
}

/**
 * Level **A** — 12 §3.1's RBAC matrix, enforced in one place.
 *
 * `SUPPORT` reads everything and may disable a user; it may not touch the
 * ledger, toggle a game, edit a flag or change a role. The split exists in the
 * schema from day one even though a solo operator seeds only `ADMIN`, because
 * retrofitting a role boundary across twenty endpoints is how one gets missed.
 */
export function requireAdminRole(...roles: readonly UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const admin = req.admin
    if (admin === undefined) {
      // Unreachable behind `adminAuthenticate`. Reaching it means a router
      // mounted this guard without that one, which is our bug — and it must
      // fail closed rather than read `undefined.role`.
      next(new UnauthorizedError('Admin authentication required', { reason: 'NO_ADMIN_SESSION' }))
      return
    }
    if (!roles.includes(admin.user.role)) {
      next(
        new ForbiddenError('Insufficient admin role', {
          reason: 'ROLE_REQUIRED',
          required: [...roles],
        }),
      )
      return
    }
    next()
  }
}

/**
 * ⚡ — 12 §3.4. A valid session is not sufficient for anything irreversible.
 *
 * ★ It must run **before** the controller and therefore before any write. The
 * manifest-driven test in S50 asserts exactly that: a ⚡ route with a stale
 * `mfaAt` returns `STEP_UP_REQUIRED` *and leaves no state change behind*. A
 * step-up checked inside a handler, after the first `await`, would be a
 * confirmation dialog rather than a control.
 */
export function requireStepUp(services: AdminServices): RequestHandler {
  return (req, _res, next) => {
    const admin = req.admin
    if (admin === undefined) {
      next(new UnauthorizedError('Admin authentication required', { reason: 'NO_ADMIN_SESSION' }))
      return
    }
    if (!services.auth.isStepUpFresh(admin.session)) {
      next(
        new StepUpRequiredError({
          mfaAt: admin.session.mfaAt.toISOString(),
          validUntil: services.auth.stepUpValidUntil(admin.session).toISOString(),
        }),
      )
      return
    }
    next()
  }
}

function cookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
