import { Router } from 'express'
import type { Container } from '../../../container.js'
import { APP_VERSION } from '../../../config/constants.js'
import { asyncHandler } from '../middleware/error.js'

/**
 * Two endpoints that answer two different questions, which is why they are not
 * one endpoint (02 §11, and the compose healthchecks in S45):
 *
 *   - `/health` — **liveness**. Is the process up? No dependency checks, so a
 *     database blip never makes the orchestrator kill a perfectly good API.
 *   - `/ready`  — **readiness**. Can it actually serve? The database is
 *     reachable and migrated. 503 here takes the instance out of rotation
 *     without restarting it.
 *
 * Conflating them produces the classic outage: the DB hiccups, every replica
 * reports unhealthy, the orchestrator restarts them all, and the restart storm
 * outlasts the hiccup.
 */
export function buildHealthRouter(container: Container): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION })
  })

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const checks = await container.checkReadiness()
      const ok = Object.values(checks).every((check) => check.ok)
      res.status(ok ? 200 : 503).json({ ok, version: APP_VERSION, checks })
    }),
  )

  return router
}
