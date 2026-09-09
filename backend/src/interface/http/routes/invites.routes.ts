import { Router, type Request } from 'express'
import type { Container } from '../../../container.js'
import { InviteCodeParamsSchema, type InviteCodeParams } from '../../../contracts/dto/invites.js'
import { asyncHandler } from '../middleware/error.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { validParams, zodValidate } from '../middleware/validate.js'

/**
 * `GET /api/v1/invites/:code` — 02 §5, access level **P**.
 *
 * ★ **No `requireIdentity()`, no cookie, no CSRF token.** This is the single
 * most important "no" in the REST surface: the friend opening the link is in a
 * private window with an empty cookie jar, and journey J1→J2 dies at this line
 * if the route asks them who they are. `tests/integration/invites.test.ts`
 * resolves a code with a bare `request(app)` — never an agent — so that
 * property is asserted rather than assumed.
 *
 * It is also the only public endpoint that takes a **guessable-shaped secret**,
 * so it gets its own tighter budget on top of the global limiter (07 §5.2). A
 * bad code additionally records an `INVITE_ABUSE` event inside the service, so
 * spraying leaves a trail even while staying under the limit.
 */
export function buildInvitesRouter(container: Container): Router {
  const router = Router()
  const { invites, env, rateLimiter, metrics, security } = container

  const resolveLimit = rateLimit(rateLimiter, {
    bucket: 'invites:resolve',
    rule: {
      limit: env.INVITE_RESOLVE_MAX,
      windowMs: env.INVITE_RESOLVE_WINDOW_SEC * 1000,
    },
    onLimit: (req, decision) => {
      metrics.increment('invite_resolve_rate_limited')
      security.record('INVITE_ABUSE', {
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        details: { reason: 'RESOLVE_RATE_LIMIT', retryAfterMs: decision.retryAfterMs },
      })
    },
  })

  router.get(
    '/invites/:code',
    resolveLimit,
    zodValidate({ params: InviteCodeParamsSchema }),
    asyncHandler(async (req, res) => {
      const { code } = validParams<InviteCodeParams>(req)
      res.json(await invites.resolve(code, contextOf(req)))
    }),
  )

  return router
}

function contextOf(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null }
}
