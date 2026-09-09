import cors from 'cors'
import helmet from 'helmet'
import type { RequestHandler } from 'express'
import type { Env } from '../../../config/env.js'
import { CSRF_HEADER } from '../../../contracts/dto/auth.js'
import { REQUEST_ID_HEADER } from './requestId.js'

/**
 * Transport-level hardening — 02 §7, 07 §6.
 *
 * The API serves JSON, so most of helmet's headers are belt-and-braces. Two
 * are not: `X-Content-Type-Options: nosniff`, which 07 §6 requires on *all*
 * responses because the avatar route serves user-supplied bytes, and a CSP
 * that makes a browser refuse to render anything if a JSON response is ever
 * navigated to directly.
 */
export function securityHeaders(_env: Env): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      // An API that never returns HTML should permit nothing at all. This is
      // the correct CSP for JSON, and it is *not* the frontend's CSP — that one
      // is set by Caddy in S46, where the Vite origin actually matters.
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // The frontend is served from a different origin and fetches with
    // credentials; a same-origin resource policy would break that.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  })
}

/**
 * Credentialed CORS, locked to exactly one origin.
 *
 * `credentials: true` and a wildcard origin are mutually exclusive by spec, and
 * for good reason — so `CORS_ORIGIN` is a required, single, exact origin. A
 * request from anywhere else simply receives no `Access-Control-Allow-Origin`
 * header, which makes the browser discard the response. Mutating requests from
 * a foreign origin are additionally refused outright by `csrfProtection`.
 */
export function corsPolicy(env: Env): RequestHandler {
  const allowed = new URL(env.CORS_ORIGIN).origin

  return cors({
    origin: (origin, callback) => {
      // No `Origin` header: a non-browser client. Nothing to allow or deny.
      if (origin === undefined) {
        callback(null, false)
        return
      }
      callback(null, origin === allowed)
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', CSRF_HEADER, REQUEST_ID_HEADER],
    exposedHeaders: [
      REQUEST_ID_HEADER,
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 600,
  })
}
