import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { buildAdminServices, type AdminServices, type Container } from './container.js'
import { ADMIN_API_PREFIX } from './config/constants.js'
import type { AdminEnv } from './config/env.js'
import { errorHandler, notFoundHandler } from './interface/http/middleware/error.js'
import { rateLimit } from './interface/http/middleware/rateLimit.js'
import { REQUEST_ID_HEADER, requestId } from './interface/http/middleware/requestId.js'
import { adminAuthenticate } from './interface/admin/middleware/adminAuth.js'
import { ipAllowlist } from './interface/admin/middleware/ipAllowlist.js'
import { buildAdminHandlers } from './interface/admin/controllers/handlers.js'
import { mountManifest } from './interface/admin/routes/adminRouter.js'
import { buildAdminAuthRouter } from './interface/admin/routes/auth.routes.js'
import { buildAdminHealthRouter } from './interface/admin/routes/health.routes.js'
import { buildAdminObservabilityRouter } from './interface/admin/routes/observability.routes.js'

const PROBE_PATH = /^(\/admin\/api\/v1)?\/(health|ready)$/

/**
 * The **admin** Express app, served on `:3100` by `admin-main.ts` — 12 §2.1.
 *
 * A second app rather than a second router tree on the first one, and that is
 * the entire architectural point of Phase L. `app.ts` and this file share a
 * `container.ts`, a repository set and a ledger — so the money rules cannot
 * fork (§2.2) — and share nothing at all about who is allowed to call them.
 *
 * What is deliberately different from the public app:
 *
 * | | public `app.ts` | here |
 * |---|---|---|
 * | CORS origin | `CORS_ORIGIN` | `ADMIN_ORIGIN`, and nothing else |
 * | CSRF | double-submit cookie | not needed — `SameSite=Strict` admin cookies |
 * | Socket.IO | attached in `main.ts` | **never**. Admin liveness is SSE (MA) |
 * | Identity | `authenticate` → `req.identity` | `adminAuthenticate` (S49) |
 * | Bind | `0.0.0.0`, published | `ADMIN_BIND`, never in a `ports:` list |
 *
 * At S48 it serves `/health` and `/ready` and nothing else. That is not a
 * placeholder — it is the point of the session. The isolation has to be
 * provable *before* the first admin endpoint exists, because retrofitting it
 * after twenty of them means auditing all twenty.
 */
export function buildAdminApp(
  container: Container,
  env: AdminEnv,
  services: AdminServices = buildAdminServices(container, env),
): Express {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false)

  app.use(requestId())
  app.use(
    pinoHttp({
      logger: container.logger.child({ process: 'admin' }),
      genReqId: (req) => req.id ?? String(req.headers[REQUEST_ID_HEADER] ?? ''),
      autoLogging: {
        ignore: (req) => PROBE_PATH.test((req.url ?? '').split('?')[0] ?? ''),
      },
    }),
  )

  /**
   * Stricter than the public app's: this app never serves an image, never gets
   * embedded, and is never fetched by a third origin.
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  )

  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin === undefined) {
          callback(null, false)
          return
        }
        callback(null, origin === new URL(env.ADMIN_ORIGIN).origin)
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', REQUEST_ID_HEADER],
      exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
      maxAge: 600,
    }),
  )

  app.use(cookieParser())
  app.use(express.json({ limit: '100kb' }))

  /**
   * ★ Before the rate limiter, and before anything reads a cookie.
   *
   * An address that is not allowed to be here should cost this process one
   * string comparison, not a Redis round-trip and a database read. Placing it
   * after the limiter would also let a blocked address exhaust the budget that
   * protects the operator's own login.
   *
   * Empty (the default) makes this a no-op — see `ipAllowlist`.
   */
  app.use(ipAllowlist(env.ADMIN_IP_ALLOWLIST))

  app.use(
    rateLimit(container.rateLimiter, {
      bucket: 'admin-global',
      rule: { limit: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_SEC * 1000 },
      skip: (req) => PROBE_PATH.test(req.path),
      onLimit: (req, decision) => {
        container.metrics.increment('rate_limit_trips')
        container.security.record('RATE_LIMIT', {
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          details: {
            path: req.path,
            method: req.method,
            retryAfterMs: decision.retryAfterMs,
            process: 'admin',
          },
        })
      },
    }),
  )

  // Mounted twice for the same reason the public app does it: compose's
  // healthcheck hits the bare path, a Vite dev proxy the prefixed one.
  const health = buildAdminHealthRouter(container)
  app.use(health)
  app.use(ADMIN_API_PREFIX, health)

  // Two steps, two rate limits, and the only unauthenticated admin routes
  // besides /health — see the router's own docblock.
  app.use(ADMIN_API_PREFIX, buildAdminAuthRouter(container, services, env))

  /**
   * Everything past this line needs a session. `adminAuthenticate` is mounted
   * **here**, once, rather than per router: a guard that each new router has to
   * remember to add is a guard that one of them will eventually not have.
   *
   * S50 adds `/users`, `/audit` and the first mutating endpoint behind it.
   */
  app.use(ADMIN_API_PREFIX, adminAuthenticate(services, env))
  app.use(ADMIN_API_PREFIX, buildAdminObservabilityRouter(container))
  // ★ S50 — generated from `interface/admin/manifest.ts`, not hand-mounted.
  app.use(ADMIN_API_PREFIX, mountManifest(services, buildAdminHandlers(container, services)))

  app.use(notFoundHandler())
  app.use(errorHandler(container.logger))

  return app
}
