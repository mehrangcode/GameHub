import type { Request, RequestHandler, Response } from 'express'
import type { GuestSessionService } from '../../../application/services/GuestSessionService.js'
import type { SecurityEventService } from '../../../application/services/SecurityEventService.js'
import { toGuestIdentity, toUserIdentity } from '../../../application/mappers/identity.js'
import { AUTH_COOKIES } from '../../../contracts/dto/auth.js'
import type { Env } from '../../../config/env.js'
import type { IUserRepository } from '../../../domain/repositories/identity.js'
import { clearAuthCookies } from '../../../infrastructure/auth/cookies.js'
import { TokenError, verifyAccessToken } from '../../../infrastructure/auth/jwt.js'
import { clientIp } from './rateLimit.js'

/**
 * Resolves cookies into `req.identity` — 02 §7, the `authenticate` slot.
 *
 * It **never rejects a request.** An absent, expired or forged cookie simply
 * leaves the request anonymous; `authorize` decides whether that is allowed.
 * That split is what lets `GET /invites/:code` and `GET /games` be genuinely
 * public while `GET /auth/me` is not, without either route re-deriving cookie
 * handling.
 *
 * Order matters: the **access** cookie wins over the **guest** cookie. A player
 * who signed up mid-session (journey J2) briefly holds both, and they are now a
 * user — resolving them as a guest would send them back to a provisional
 * wallet and a table-bound identity they have just outgrown.
 */

export interface AuthenticateDeps {
  readonly users: IUserRepository
  readonly guests: GuestSessionService
  readonly security: SecurityEventService
  readonly env: Env
}

export function authenticate(deps: AuthenticateDeps): RequestHandler {
  return (req, res, next) => {
    void resolve(req, res, deps)
      .then((identity) => {
        if (identity) req.identity = identity
        next()
      })
      .catch(next)
  }
}

async function resolve(req: Request, res: Response, deps: AuthenticateDeps) {
  const fromAccess = await resolveUser(req, res, deps)
  if (fromAccess) return fromAccess
  return resolveGuest(req, res, deps)
}

async function resolveUser(req: Request, res: Response, deps: AuthenticateDeps) {
  const token = cookie(req, AUTH_COOKIES.access)
  if (!token) return null

  try {
    const claims = await verifyAccessToken(token, deps.env)

    /**
     * The DB read that could be skipped, and is not.
     *
     * Everything `/auth/me` returns could be baked into the JWT, saving one
     * primary-key lookup per request. It is not, because a stateless claim goes
     * stale in ways that matter: a renamed player would keep their old name for
     * ten minutes, and — the real reason — a **banned** player would keep full
     * access until their access token expired. One indexed read is the cheaper
     * side of that trade.
     */
    const user = await deps.users.findById(claims.sub)
    if (!user) {
      // The token verifies but names nobody: the account was deleted, or the
      // signing key is shared with something that should not have it.
      clearAuthCookies(res, deps.env)
      return null
    }
    if (user.status !== 'ACTIVE') {
      clearAuthCookies(res, deps.env)
      return null
    }

    return toUserIdentity(user)
  } catch (error) {
    // An *expired* token is the normal end of every 10-minute window. Leave the
    // cookies alone so `/auth/refresh` can rotate them; clearing them here
    // would log everyone out every ten minutes.
    if (error instanceof TokenError && error.failure === 'expired') return null

    // Anything else is a token we did not mint. Clear it — otherwise a browser
    // holding a corrupt cookie retries forever — and leave a trail.
    clearAuthCookies(res, deps.env)
    deps.security.record('BAD_TOKEN', {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? null,
      details: { cookie: AUTH_COOKIES.access, reason: 'ACCESS_TOKEN_INVALID' },
    })
    return null
  }
}

async function resolveGuest(req: Request, res: Response, deps: AuthenticateDeps) {
  const token = cookie(req, AUTH_COOKIES.guest)
  if (!token) return null

  const session = await deps.guests.resolve(token)
  if (!session) {
    clearAuthCookies(res, deps.env)
    return null
  }

  return toGuestIdentity(session)
}

function cookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
