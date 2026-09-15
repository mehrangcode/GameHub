import { Router } from 'express'
import type { Container } from '../../../container.js'
import { APP_VERSION } from '../../../config/constants.js'
import { asyncHandler } from '../../http/middleware/error.js'

/**
 * The admin process's liveness and readiness — 12 §5, the only unauthenticated
 * admin routes there will ever be.
 *
 * They are unauthenticated for the same reason the public ones are: compose's
 * healthcheck has no cookie jar and no second factor, and a healthcheck that
 * cannot pass is a container that restarts forever. What they give away is the
 * version string and whether a database is reachable — to a caller who is
 * already inside the Docker network, since `:3100` is never published.
 *
 * Importing `asyncHandler` from `interface/http/middleware/` is deliberate and
 * is the *allowed* direction: guard 1 in `eslint.config.js` bans
 * `interface/http/**` from importing `interface/admin/**`, not the reverse. The
 * error middleware, the request-id middleware and the validators are shared
 * infrastructure — duplicating them for the admin process would give the two
 * apps two different ideas of what an error looks like.
 */
export function buildAdminHealthRouter(container: Container): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION, process: 'admin' })
  })

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const checks = await container.checkReadiness()
      const ok = Object.values(checks).every((check) => check.ok)
      res.status(ok ? 200 : 503).json({ ok, version: APP_VERSION, process: 'admin', checks })
    }),
  )

  return router
}
