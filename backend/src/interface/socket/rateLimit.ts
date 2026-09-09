import type { IRateLimiter, RateLimitRule } from '../../application/ports/rateLimiter.js'
import type { MetricsRegistry } from '../../application/services/MetricsRegistry.js'
import { RateLimitError } from '../../domain/errors/errors.js'
import { holderKey, type IdentityRef } from '../../domain/value-objects/identity.js'

/**
 * Per-event rate limits for the socket — 04 §8, S24.
 *
 * The same `IRateLimiter` port the HTTP middleware uses, so S27's Redis swap is
 * still one line in `container.ts`, and so a socket flood and an HTTP flood are
 * counted by the same mechanism rather than by two that drift.
 *
 * ### Per socket or per identity — the choice that actually matters
 *
 * Two keying strategies, and picking the wrong one produces a limit that is
 * either useless or infuriating:
 *
 *   - **Per socket** for events whose cost is *server work on one connection* —
 *     seat changes, joins, and (from S30) moves. Opening a second tab genuinely
 *     doubles the legitimate need, and a shared budget would mean a second tab
 *     throttles the first.
 *   - **Per identity** for events whose cost is *other people's attention* —
 *     chat and emotes. Five tabs must not buy five times the spam. `ChatService`
 *     owns those two buckets itself, precisely because the limit belongs to the
 *     person rather than to the transport.
 */

export interface SocketLimiterDeps {
  readonly rateLimiter: IRateLimiter
  readonly metrics: MetricsRegistry
}

/**
 * @throws {RateLimitError} carrying `retryAfterMs`, which the client renders as
 * a countdown rather than as a dead button. A limit with no "when" is a limit
 * users interpret as a bug.
 */
export async function spendSocketBudget(
  deps: SocketLimiterDeps,
  key: string,
  rule: RateLimitRule,
): Promise<void> {
  const decision = await deps.rateLimiter.consume(key, rule)
  if (decision.allowed) return

  deps.metrics.increment('socket_rate_limited')
  throw new RateLimitError(decision.retryAfterMs, { bucket: bucketOf(key) })
}

export const perSocket = (socketId: string, bucket: string): string =>
  `socket:${bucket}:${socketId}`

export const perIdentity = (identity: IdentityRef, bucket: string): string =>
  `socket:${bucket}:${holderKey(identity)}`

/** `socket:takeSeat:abc123` → `takeSeat`. The id never reaches the error body. */
function bucketOf(key: string): string {
  return key.split(':')[1] ?? 'socket'
}
