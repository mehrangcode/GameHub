import type { Request, RequestHandler } from 'express'
import type {
  IRateLimiter,
  RateLimitDecision,
  RateLimitRule,
} from '../../../application/ports/rateLimiter.js'
import { RateLimitError } from '../../../domain/errors/errors.js'

/**
 * Turns a {@link IRateLimiter} decision into an HTTP outcome.
 *
 * The limiter is injected rather than constructed here so S27 can hand the
 * Redis-backed one to the exact same middleware, and so a test can hand it a
 * limiter with a 2-request window instead of sleeping through a real one.
 */

export interface RateLimitOptions {
  readonly rule: RateLimitRule
  /**
   * Namespaces the key. Two limiters must never share a counter: burning the
   * global budget should not lock someone out of logging in, and five bad
   * passwords should not consume their page views.
   */
  readonly bucket: string
  /** Defaults to the client IP. The login throttle also keys on the email. */
  readonly key?: (req: Request) => string
  /**
   * Requests to skip entirely. Liveness and readiness probes use it: an
   * orchestrator polling `/health` every few seconds must never be able to
   * exhaust the global budget and take the instance out of rotation itself.
   */
  readonly skip?: (req: Request) => boolean
  /**
   * Called on every denial. S15 wires the `RATE_LIMIT` `SecurityEvent` here —
   * the limiter itself stays free of any dependency on the audit log.
   */
  readonly onLimit?: (req: Request, decision: RateLimitDecision) => void
}

/**
 * `req.ip` respects `trust proxy`, which `app.ts` enables only in production —
 * behind Caddy the peer address is the reverse proxy, and in dev trusting
 * `X-Forwarded-For` would let anyone bypass every limit by sending a header.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

export function rateLimit(limiter: IRateLimiter, options: RateLimitOptions): RequestHandler {
  const keyOf = options.key ?? clientIp

  return (req, res, next) => {
    if (options.skip?.(req)) {
      next()
      return
    }

    void limiter
      .consume(`${options.bucket}:${keyOf(req)}`, options.rule)
      .then((decision) => {
        res.setHeader('X-RateLimit-Limit', decision.limit)
        res.setHeader('X-RateLimit-Remaining', decision.remaining)
        res.setHeader('X-RateLimit-Reset', Math.ceil(decision.resetAt.getTime() / 1000))

        if (decision.allowed) {
          next()
          return
        }

        options.onLimit?.(req, decision)
        // `errorHandler` turns this into 429 + `Retry-After` + `retryAfterMs`.
        next(new RateLimitError(decision.retryAfterMs, { bucket: options.bucket }))
      })
      .catch(next)
  }
}
