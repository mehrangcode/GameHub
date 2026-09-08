import { Router } from 'express'
import { APP_VERSION } from '../../../config/constants.js'

/**
 * Liveness only — no dependency checks. `/ready` (DB + Redis reachable) arrives
 * in S10; keeping them separate is what makes the compose healthchecks in S45
 * mean two different things.
 */
export function buildHealthRouter(): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION })
  })

  return router
}
