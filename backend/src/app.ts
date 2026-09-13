import cookieParser from 'cookie-parser'
import express, { type Express } from 'express'
import { pinoHttp } from 'pino-http'
import type { Container } from './container.js'
import { API_PREFIX } from './config/constants.js'
import { authenticate } from './interface/http/middleware/authenticate.js'
import { csrfProtection } from './interface/http/middleware/csrf.js'
import { errorHandler, notFoundHandler } from './interface/http/middleware/error.js'
import { rateLimit } from './interface/http/middleware/rateLimit.js'
import { corsPolicy, securityHeaders } from './interface/http/middleware/security.js'
import { REQUEST_ID_HEADER, requestId } from './interface/http/middleware/requestId.js'
import { buildAuthRouter } from './interface/http/routes/auth.routes.js'
import { buildGamesRouter } from './interface/http/routes/games.routes.js'
import { buildHealthRouter } from './interface/http/routes/health.routes.js'
import { buildInvitesRouter } from './interface/http/routes/invites.routes.js'
import { buildProbeRouter } from './interface/http/routes/probe.routes.js'
import { buildTablesRouter } from './interface/http/routes/tables.routes.js'
import { buildWalletRouter } from './interface/http/routes/wallet.routes.js'

/** Liveness and readiness are exempt from the global limiter — see below. */
const PROBE_PATH = /^(\/api\/v1)?\/(health|ready)$/

/**
 * The **public** Express app, served on :3000.
 *
 * There are no admin routes here and there never will be: `interface/admin/**`
 * is mounted by `admin-main.ts` alone (12 §2.4). `/admin/*` falls through to
 * the 404 handler like any other unknown path — asserted permanently in
 * `tests/integration/health.test.ts`.
 *
 * The chain below is 02 §7's order, exactly:
 *
 *     requestId → pino-http → helmet → cors → cookieParser → json
 *       → rateLimit → csrf → authenticate → [route: zodValidate → authorize
 *       → controller] → notFound → errorHandler
 *
 * `zodValidate` and `authorize` are per-route rather than global — a global
 * body schema is meaningless and a global authorize level would make every new
 * route's access an accident of mount order. They still run in the specified
 * position *relative to* everything global, which is what §7 is about.
 */
export function buildApp(container: Container): Express {
  const app = express()
  const { env } = container

  app.disable('x-powered-by')
  /**
   * Behind Caddy (S46) the peer address is the proxy, so `req.ip` has to come
   * from `X-Forwarded-For` — and *only* there. Trusting the header in dev would
   * let anyone defeat every per-IP rate limit by sending one.
   */
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false)

  // ── 02 §7, in order ───────────────────────────────────────────────────────
  app.use(requestId())
  app.use(
    pinoHttp({
      logger: container.logger,
      genReqId: (req) => req.id ?? String(req.headers[REQUEST_ID_HEADER] ?? ''),
      // Health probes fire every few seconds; at info level they bury
      // everything a human would want to read. Both mount points are ignored —
      // compose hits the bare path, the Vite proxy the prefixed one.
      autoLogging: {
        ignore: (req) => PROBE_PATH.test((req.url ?? '').split('?')[0] ?? ''),
      },
    }),
  )
  app.use(securityHeaders(env))
  app.use(corsPolicy(env))
  app.use(cookieParser())
  app.use(express.json({ limit: '100kb' }))
  app.use(
    rateLimit(container.rateLimiter, {
      bucket: 'global',
      rule: { limit: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_SEC * 1000 },
      // An orchestrator polling /health must never be able to exhaust the
      // budget and take the instance out of rotation by itself.
      skip: (req) => PROBE_PATH.test(req.path),
      onLimit: (req, decision) => {
        container.metrics.increment('rate_limit_trips')
        container.security.record('RATE_LIMIT', {
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          details: { path: req.path, method: req.method, retryAfterMs: decision.retryAfterMs },
        })
      },
    }),
  )
  app.use(csrfProtection(env))
  app.use(
    authenticate({
      users: container.repos.users,
      guests: container.guests,
      security: container.security,
      env,
    }),
  )

  // ── Routes ────────────────────────────────────────────────────────────────
  const health = buildHealthRouter(container)
  // Mounted twice on purpose: compose healthchecks want the bare path, and the
  // Vite dev proxy only forwards /api.
  app.use(health)
  app.use(API_PREFIX, health)
  app.use(API_PREFIX, buildAuthRouter(container))
  app.use(API_PREFIX, buildGamesRouter(container))
  app.use(API_PREFIX, buildTablesRouter(container))
  // S37 — `GET /wallet` (G), `/wallet/transactions` (U), `/rewards/rules` (P).
  app.use(API_PREFIX, buildWalletRouter(container))
  // `/invites/:code` is its own router because it is the one table-adjacent
  // route with no authentication at all — keeping it out of the tables router
  // means nobody can add a `requireIdentity()` to that file and silently break
  // the invite link (S19).
  app.use(API_PREFIX, buildInvitesRouter(container))

  // Dev-only: the boundary's behaviour, made visible to curl (S12, S20).
  if (env.NODE_ENV !== 'production') {
    app.use(API_PREFIX, buildProbeRouter(container))
  }

  // ── Tail ──────────────────────────────────────────────────────────────────
  app.use(notFoundHandler())
  app.use(errorHandler(container.logger))

  return app
}
