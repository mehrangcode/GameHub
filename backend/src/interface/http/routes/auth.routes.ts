import { Router, type Request } from 'express'
import type { Container } from '../../../container.js'
import {
  AUTH_COOKIES,
  GuestRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  type GuestRequest,
  type LoginRequest,
  type RegisterRequest,
} from '../../../contracts/dto/auth.js'
import {
  clearAuthCookies,
  setAccessCookie,
  setGuestCookie,
  setRefreshCookie,
} from '../../../infrastructure/auth/cookies.js'
import type { IssuedSession } from '../../../application/services/AuthService.js'
import { asyncHandler } from '../middleware/error.js'
import { requireIdentity } from '../middleware/authorize.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { validBody, zodValidate } from '../middleware/validate.js'

/**
 * `/api/v1/auth/*` — 02 §7.
 *
 * The routes are thin on purpose: validate, call a service, write cookies,
 * answer. Every decision worth arguing about lives in `AuthService` or
 * `GuestSessionService`, where it can be tested without HTTP.
 *
 * **No `Authorization` header anywhere.** Identity travels in httpOnly cookies
 * (07 §5.3), which is why the client never holds a token it could leak through
 * XSS — and why every route below finishes by setting or clearing cookies
 * rather than returning a token in the body.
 */
export function buildAuthRouter(container: Container): Router {
  const router = Router()
  const { auth, guests, env, rateLimiter } = container

  /**
   * A tighter limit than the global one on the three endpoints that create
   * state. Registration is the expensive one — each call burns an argon2 hash,
   * so an unthrottled `/register` is a cheap way to spend all our CPU.
   */
  const creationLimit = rateLimit(rateLimiter, {
    bucket: 'auth:create',
    rule: { limit: 10, windowMs: 60_000 },
  })

  router.post(
    '/auth/register',
    creationLimit,
    zodValidate({ body: RegisterRequestSchema }),
    asyncHandler(async (req, res) => {
      const session = await auth.register(validBody<RegisterRequest>(req), contextOf(req))
      writeSession(res, session, container)
      res.status(201).json(publicPart(session))
    }),
  )

  router.post(
    '/auth/login',
    zodValidate({ body: LoginRequestSchema }),
    asyncHandler(async (req, res) => {
      // The per-email/per-IP throttle (07 §5.3) lives inside the service, so it
      // covers every caller of `login`, not just this route.
      const session = await auth.login(validBody<LoginRequest>(req), contextOf(req))
      writeSession(res, session, container)
      res.json(publicPart(session))
    }),
  )

  router.post(
    '/auth/refresh',
    asyncHandler(async (req, res) => {
      const session = await auth.refresh(cookie(req, AUTH_COOKIES.refresh), contextOf(req))
      writeSession(res, session, container)
      res.json(publicPart(session))
    }),
  )

  router.post(
    '/auth/logout',
    asyncHandler(async (req, res) => {
      await auth.logout(cookie(req, AUTH_COOKIES.refresh), contextOf(req))
      // Cookies are cleared regardless of what the server found. "Log me out"
      // has exactly one acceptable outcome from the browser's side.
      clearAuthCookies(res, env)
      res.json({ ok: true })
    }),
  )

  router.get(
    '/auth/me',
    requireIdentity(),
    // Not `asyncHandler`: `authenticate` already did every lookup this needs.
    (req, res) => {
      res.json(req.identity)
    },
  )

  router.post(
    '/auth/guest',
    creationLimit,
    zodValidate({ body: GuestRequestSchema }),
    asyncHandler(async (req, res) => {
      const issued = await guests.create(validBody<GuestRequest>(req), contextOf(req))
      setGuestCookie(res, issued.guestToken, env)
      res.status(201).json({ identity: issued.identity, redirectTo: issued.redirectTo })
    }),
  )

  return router
}

function writeSession(
  res: Parameters<typeof setAccessCookie>[0],
  session: IssuedSession,
  container: Container,
): void {
  setAccessCookie(res, session.accessToken, container.env)
  setRefreshCookie(res, session.refreshToken, container.env)
}

/**
 * Strips the tokens before the body is serialised.
 *
 * The tokens are in the cookies; putting them in the JSON as well would hand
 * them to any JS that can read the response and undo the whole point of
 * `httpOnly`.
 */
function publicPart(session: IssuedSession) {
  return { identity: session.identity, redirectTo: session.redirectTo }
}

function contextOf(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null }
}

function cookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
