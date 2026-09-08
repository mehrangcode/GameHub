import express, { type Express } from 'express'
import { API_PREFIX } from './config/constants.js'
import { buildHealthRouter } from './interface/http/routes/health.routes.js'

/**
 * The **public** Express app, served on :3000.
 *
 * There are no admin routes here and there never will be: `interface/admin/**`
 * is mounted by `admin-main.ts` alone (12-admin-console.md §2.4). The full
 * middleware chain from 02-technical-prd.md §7 is assembled in S10.
 */
export function buildApp(): Express {
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '100kb' }))

  const health = buildHealthRouter()
  // Reachable both unprefixed (compose healthchecks) and through the Vite
  // dev proxy, which only forwards /api.
  app.use(health)
  app.use(API_PREFIX, health)

  return app
}
