import { Router } from 'express'
import type { Container } from '../../../container.js'
import { GameSlugParamsSchema, type GameSlugParams } from '../../../contracts/dto/games.js'
import { validParams, zodValidate } from '../middleware/validate.js'

/**
 * `/api/v1/games` — 02 §5, access level **P** (public).
 *
 * No `requireIdentity()`, deliberately: the welcome page is the first thing a
 * stranger sees, and a catalog that needed a cookie would make the front page
 * of the site depend on being logged in.
 *
 * Both handlers are synchronous — the registry is in memory. There is no
 * database read on the busiest public route in the product.
 */
export function buildGamesRouter(container: Container): Router {
  const router = Router()
  const { catalog } = container

  router.get('/games', (_req, res) => {
    res.json(catalog.list())
  })

  router.get('/games/:slug', zodValidate({ params: GameSlugParamsSchema }), (req, res) => {
    // Throws `NotFoundError` for an unknown slug — including `fixture` in
    // production, where it is indistinguishable from a slug that never was.
    res.json(catalog.detail(validParams<GameSlugParams>(req).slug))
  })

  return router
}
