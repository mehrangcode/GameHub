import { Router } from 'express'
import type { Container } from '../../../container.js'
import { toPreferencesResponse } from '../../../application/mappers/preferences.js'
import {
  UpdatePreferencesRequestSchema,
  type UpdatePreferencesRequest,
} from '../../../contracts/dto/preferences.js'
import { asUser, requireUser } from '../middleware/authorize.js'
import { asyncHandler } from '../middleware/error.js'
import { validBody, zodValidate } from '../middleware/validate.js'

/**
 * `/api/v1/me/preferences` — S40. 06 §3.5, §6.2.
 *
 * **`requireUser()`, not `requireIdentity()`**, and that is the whole design of
 * guest preferences: a guest has no `UserPreferences` row to read or write, so
 * their choices live in `localStorage` and are carried into the account by the
 * claim transaction (03 §6.1 step 3, `preferencesFromGuest`). Giving a guest a
 * row here would be building half an account for somebody who has not made one
 * — and would have to be reconciled against the blob at claim time anyway.
 *
 * There is no id parameter in this file, exactly as in the wallet router: you
 * can read and write your own preferences and there is no field with which to
 * name anybody else's.
 */
export function buildMeRouter(container: Container): Router {
  const router = Router()
  const { preferences } = container.repos

  /**
   * A user without a row is a valid state (the repository says so), so this
   * answers with the defaults rather than a 404. A settings page that 404s for
   * a brand-new account would be a bug report every time.
   */
  router.get(
    '/me/preferences',
    requireUser(),
    asyncHandler(async (req, res) => {
      const row = await preferences.findByUser(asUser(req).userId)
      res.json(toPreferencesResponse(row))
    }),
  )

  /**
   * A partial patch — one setting at a time, because that is how the
   * customization page saves (debounced at 800 ms per change). Sending the
   * whole object to change one felt is how two open tabs overwrite each
   * other's unrelated choices.
   */
  router.put(
    '/me/preferences',
    requireUser(),
    zodValidate({ body: UpdatePreferencesRequestSchema }),
    asyncHandler(async (req, res) => {
      const patch = validBody<UpdatePreferencesRequest>(req)
      const row = await preferences.upsert(asUser(req).userId, patch)
      res.json(toPreferencesResponse(row))
    }),
  )

  return router
}
