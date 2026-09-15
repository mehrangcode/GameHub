import { Router } from 'express'
import type { AdminServices, Container } from '../../../container.js'
import type { AdminEnv } from '../../../config/env.js'
import {
  ADMIN_COOKIES,
  AdminEnrollRequestSchema,
  AdminLoginRequestSchema,
  AdminMfaRequestSchema,
  AdminStepUpRequestSchema,
  type AdminIdentity,
} from '../../../contracts/admin/auth.js'
import { UnauthorizedError } from '../../../domain/errors/errors.js'
import {
  clearAdminCookies,
  setAdminCookies,
  signAdminAccessToken,
} from '../../../infrastructure/admin/adminTokens.js'
import type { AdminSession } from '../../../domain/entities/admin.js'
import type { User } from '../../../domain/entities/user.js'
import { asyncHandler } from '../../http/middleware/error.js'
import { rateLimit } from '../../http/middleware/rateLimit.js'
import { clientIp } from '../../http/middleware/rateLimit.js'
import { requestIdOf } from '../../http/middleware/requestId.js'
import { validBody, zodValidate } from '../../http/middleware/validate.js'
import { adminAuthenticate } from '../middleware/adminAuth.js'

/**
 * `/admin/api/v1/auth/*` — 12-admin-console.md §3.3, §5.
 *
 * ★ **Two steps, two rate limits.** `/auth/login` is budgeted per IP against
 * password guessing; `/auth/mfa` gets its own, tighter budget, because a
 * six-digit code is the realistic thing to brute-force and a shared budget
 * would let a correct password buy fresh attempts at it. This is the concrete
 * reason §3.3 specifies two endpoints rather than one with three fields.
 *
 * The three routes before `adminAuthenticate` are the *only* unauthenticated
 * admin routes besides `/health`, and each is gated by something:
 *
 * | Route | Gated by |
 * |---|---|
 * | `/auth/login` | the password |
 * | `/auth/totp/enroll` | a live challenge **and** having no second factor yet |
 * | `/auth/mfa` | a live challenge **and** the code |
 * | `/auth/refresh` | the refresh cookie, pinned to its IP |
 */
export function buildAdminAuthRouter(
  container: Container,
  services: AdminServices,
  env: AdminEnv,
): Router {
  const router = Router()

  /** Per-IP, and deliberately generous: the code step is the tight one. */
  const loginLimit = rateLimit(container.rateLimiter, {
    bucket: 'admin-login',
    rule: { limit: env.LOGIN_MAX_ATTEMPTS * 2, windowMs: env.LOGIN_WINDOW_SEC * 1000 },
  })

  /**
   * ★ The budget that actually matters. `ADMIN_MFA_MAX_ATTEMPTS` per-credential
   * lockout stops a sustained attack on one account; this stops a spray across
   * many challenges from one address, which the per-credential counter would
   * never see.
   */
  const mfaLimit = rateLimit(container.rateLimiter, {
    bucket: 'admin-mfa',
    rule: { limit: env.ADMIN_MFA_MAX_ATTEMPTS * 2, windowMs: env.LOGIN_WINDOW_SEC * 1000 },
  })

  router.post(
    '/auth/login',
    loginLimit,
    zodValidate({ body: AdminLoginRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validBody<{ email: string; password: string }>(req)
      res.json(await services.auth.login(body, contextOf(req)))
    }),
  )

  /**
   * The one route an unenrolled admin may reach — §3.3.
   *
   * Everything it returns is unrecoverable afterwards, by design: the secret is
   * stored only as ciphertext and the recovery codes only as hashes. There is
   * deliberately no "show me those again" route, because a route that could
   * show them to the operator could show them to whoever has their cookie.
   */
  router.post(
    '/auth/totp/enroll',
    loginLimit,
    zodValidate({ body: AdminEnrollRequestSchema }),
    asyncHandler(async (req, res) => {
      const { challengeId } = validBody<{ challengeId: string }>(req)
      res.json(await services.auth.enroll(challengeId, contextOf(req)))
    }),
  )

  router.post(
    '/auth/mfa',
    mfaLimit,
    zodValidate({ body: AdminMfaRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validBody<{ challengeId: string; code: string }>(req)
      const issued = await services.auth.verifyMfa(body, contextOf(req))

      await issueCookies(res, issued.session, issued.user, issued.refreshToken, env)
      // 200 with the identity rather than 204: the console needs `mfaAt` and
      // `stepUpValidUntil` immediately, and a second round-trip to `/auth/me`
      // for something the server has in hand is a wasted request.
      res.json(await identityOf(services, issued.session, issued.user))
    }),
  )

  /**
   * Rotates the refresh token. The 8-hour absolute cap is **not** extended —
   * see `IAdminSessionRepository.rotate`.
   */
  router.post(
    '/auth/refresh',
    asyncHandler(async (req, res) => {
      const token = (req.cookies as Record<string, unknown> | undefined)?.[ADMIN_COOKIES.refresh]
      if (typeof token !== 'string' || token === '') {
        throw new UnauthorizedError('No admin refresh token', { reason: 'NO_ADMIN_SESSION' })
      }

      const issued = await services.auth.refresh(
        services.tokens.hashRefreshToken(token),
        contextOf(req),
      )
      await issueCookies(res, issued.session, issued.user, issued.refreshToken, env)
      res.json(await identityOf(services, issued.session, issued.user))
    }),
  )

  // ── everything below needs a session ─────────────────────────────────────
  router.use(adminAuthenticate(services, env))

  router.get(
    '/auth/me',
    asyncHandler(async (req, res) => {
      const admin = req.admin!
      res.json(await identityOf(services, admin.session, admin.user))
    }),
  )

  /**
   * ⚡ A fresh factor without a new session — §3.4.
   *
   * Rate-limited on the *code* budget, not the login one: it is a code-guessing
   * surface, and an attacker holding a stolen session cookie would otherwise
   * have a second, looser place to grind six digits.
   */
  router.post(
    '/auth/stepup',
    mfaLimit,
    zodValidate({ body: AdminStepUpRequestSchema }),
    asyncHandler(async (req, res) => {
      const { code } = validBody<{ code: string }>(req)
      const admin = req.admin!
      const session = await services.auth.stepUp(admin.session, code, contextOf(req))

      res.json(await identityOf(services, session, admin.user))
    }),
  )

  router.post(
    '/auth/logout',
    asyncHandler(async (req, res) => {
      const admin = req.admin!
      await services.auth.logout(admin.session, contextOf(req))
      clearAdminCookies(res, env)
      res.status(204).end()
    }),
  )

  return router
}

function contextOf(req: Parameters<typeof clientIp>[0] & { get(name: string): string | undefined }) {
  return {
    ip: clientIp(req),
    userAgent: req.get('user-agent') ?? 'unknown',
    requestId: requestIdOf(req),
  }
}

async function issueCookies(
  res: Parameters<typeof setAdminCookies>[0],
  session: AdminSession,
  user: User,
  refreshToken: string,
  env: AdminEnv,
): Promise<void> {
  const access = await signAdminAccessToken({ userId: user.id, sessionId: session.id }, env)
  setAdminCookies(res, { access: access.token, refresh: refreshToken }, env)
}

async function identityOf(
  services: AdminServices,
  session: AdminSession,
  user: User,
): Promise<AdminIdentity> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    // Narrowed by `requireAdmin` inside the service: a `USER` never gets here.
    role: user.role as 'SUPPORT' | 'ADMIN',
    mfaAt: session.mfaAt.toISOString(),
    stepUpValidUntil: services.auth.stepUpValidUntil(session).toISOString(),
    sessionExpiresAt: session.expiresAt.toISOString(),
  }
}
