import type { Request, RequestHandler } from 'express'
import type { Env } from '../../../config/env.js'
import { AUTH_COOKIES, CSRF_HEADER } from '../../../contracts/dto/auth.js'
import { ForbiddenError } from '../../../domain/errors/errors.js'
import { setCsrfCookie } from '../../../infrastructure/auth/cookies.js'
import { randomToken, safeEqual } from '../../../infrastructure/auth/tokens.js'

/**
 * CSRF defence — 07 §5.4.
 *
 * Cookie auth means CSRF is in scope, and the answer is two independent checks
 * on every state-changing request:
 *
 *   1. **Origin check.** Browsers attach `Origin` to every POST/PUT/PATCH/
 *      DELETE, cross-site ones included, and a page cannot forge it. So an
 *      `Origin` that is present and not ours is refused outright. This is
 *      OWASP's primary defence and it needs no token at all.
 *   2. **Double-submit token.** The non-httpOnly `csrf` cookie must be echoed
 *      in `X-CSRF-Token`. An attacker's page can cause the cookie to be *sent*
 *      but cannot *read* it across origins, so it cannot produce the header.
 *
 * ### Why the token is only required when `Origin` is present
 *
 * A request with no `Origin` and no `Referer` did not come from a browser —
 * `curl`, a REST-client file, a future mobile app. Such a client has no
 * ambient cookie store for an attacker to ride, so there is no CSRF to
 * prevent; demanding a token there would buy no security and would break every
 * `curl` verification step in the build plan. The check is enforced exactly
 * where the threat exists, in the same code path, in dev and prod alike — no
 * environment flag that makes development behave differently from production.
 */

/**
 * Paths exempt from the check entirely, matched against the path after the API
 * prefix. The payment webhook is the documented exemption (02 §7): it arrives
 * from the provider's servers with no cookies at all, and its integrity comes
 * from a signature, not from a session.
 */
export const CSRF_EXEMPT_PATHS: readonly string[] = ['/premium/webhook']

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface CsrfOptions {
  readonly exempt?: readonly string[]
}

export function csrfProtection(env: Env, options: CsrfOptions = {}): RequestHandler {
  const exempt = options.exempt ?? CSRF_EXEMPT_PATHS
  const allowedOrigin = new URL(env.CORS_ORIGIN).origin

  return (req, res, next) => {
    // Seed the cookie on any request that lacks it, so the very first page load
    // leaves the client able to make its first mutation.
    const existing = cookieToken(req)
    if (existing === undefined) setCsrfCookie(res, randomToken(24), env)

    if (SAFE_METHODS.has(req.method)) {
      next()
      return
    }
    if (exempt.some((path) => req.path.endsWith(path))) {
      next()
      return
    }

    // `Origin: null` is an *opaque* origin — a sandboxed iframe or a `data:`
    // document. That is a browser, and a hostile one, so it is a mismatch
    // rather than an absent header.
    if (req.headers.origin === 'null') {
      next(new ForbiddenError('Opaque origin refused', { reason: 'ORIGIN_MISMATCH' }))
      return
    }

    const origin = requestOrigin(req)
    if (origin === undefined) {
      // Not a browser: nothing to forge a request *from*.
      next()
      return
    }

    if (origin !== allowedOrigin) {
      next(new ForbiddenError('Cross-origin request refused', { reason: 'ORIGIN_MISMATCH' }))
      return
    }

    const presented = header(req)
    if (existing === undefined || presented === undefined || !safeEqual(existing, presented)) {
      next(new ForbiddenError('CSRF token missing or mismatched', { reason: 'CSRF_FAILED' }))
      return
    }

    next()
  }
}

function cookieToken(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[AUTH_COOKIES.csrf]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function header(req: Request): string | undefined {
  const value = req.headers[CSRF_HEADER]
  const single = Array.isArray(value) ? value[0] : value
  return typeof single === 'string' && single.length > 0 ? single : undefined
}

/**
 * `Origin` when the browser sent one, otherwise the origin of `Referer`. Older
 * browsers omit `Origin` on some same-origin form posts but always send
 * `Referer`, so falling back keeps the check from silently doing nothing.
 */
function requestOrigin(req: Request): string | undefined {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) return safeOrigin(origin)

  const referer = req.headers.referer
  return typeof referer === 'string' ? safeOrigin(referer) : undefined
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}
