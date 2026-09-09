import type {
  IRateLimiter,
  RateLimitDecision,
  RateLimitRule,
} from '../../application/ports/rateLimiter.js'

interface Bucket {
  /** Hit timestamps in ms, ascending. */
  hits: number[]
  /** When the last hit ages out of its own window; the sweeper's cue. */
  expiresAt: number
}

/**
 * An in-process **sliding-window** limiter. S27 adds the Redis twin behind the
 * same port; until then a single API process is the whole deployment, so this
 * is not a compromise, it is the correct implementation.
 *
 * Sliding, not fixed-window, because a fixed window lets a client spend its
 * whole budget in the last second of one window and again in the first second
 * of the next — 2× the intended burst, right at the boundary. Keeping the
 * actual hit timestamps costs a few bytes per key and removes that class of
 * bug entirely.
 */
export class SlidingWindowRateLimiter implements IRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly sweeper: NodeJS.Timeout | undefined

  /**
   * @param sweepMs How often to drop buckets whose window has emptied. Without
   *   this, a process that has seen a million distinct IPs holds a million
   *   entries forever. Note the sweep is driven by each bucket's *own* expiry,
   *   not by this interval — the 15-minute login throttle must survive a
   *   1-minute sweep.
   * @param maxKeys Hard ceiling. Reaching it means someone is cycling source
   *   addresses to exhaust our memory, so the least recently used keys are
   *   evicted — losing a rate-limit counter is a far smaller problem than an
   *   OOM.
   */
  constructor(
    sweepMs = 60_000,
    private readonly maxKeys = 50_000,
  ) {
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), sweepMs)
      // Never keep the process alive for a housekeeping timer.
      this.sweeper.unref()
    }
  }

  async consume(key: string, rule: RateLimitRule, now = new Date()): Promise<RateLimitDecision> {
    const nowMs = now.getTime()
    const cutoff = nowMs - rule.windowMs
    const hits = (this.buckets.get(key)?.hits ?? []).filter((at) => at > cutoff)

    if (hits.length >= rule.limit) {
      // The window frees a slot when its oldest hit ages out. A denied hit is
      // deliberately not recorded — counting rejections would let a client that
      // keeps hammering push its own reset time forever.
      const oldest = hits[0] ?? nowMs
      const retryAfterMs = Math.max(1, oldest + rule.windowMs - nowMs)
      this.store(key, { hits, expiresAt: oldest + rule.windowMs })

      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        retryAfterMs,
        resetAt: new Date(nowMs + retryAfterMs),
      }
    }

    hits.push(nowMs)
    this.store(key, { hits, expiresAt: nowMs + rule.windowMs })

    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - hits.length,
      retryAfterMs: 0,
      resetAt: new Date((hits[0] ?? nowMs) + rule.windowMs),
    }
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key)
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.clear()
  }

  /**
   * Forgets every bucket, keeping the sweeper alive.
   *
   * Not on the port: nothing in production has any business resetting a
   * limiter globally. Tests use it between cases so that one test's requests
   * are not counted against the next one's budget.
   */
  clear(): void {
    this.buckets.clear()
  }

  /** Test seam: proves the sweeper actually reclaims, without waiting a minute. */
  size(): number {
    return this.buckets.size
  }

  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key)
    }
  }

  /**
   * Re-inserting moves the key to the tail of `Map`'s insertion order, which is
   * what makes the head genuinely least-recently-used. A bare `set` on an
   * existing key does *not* reorder, so the delete is load-bearing.
   */
  private store(key: string, bucket: Bucket): void {
    this.buckets.delete(key)
    this.buckets.set(key, bucket)
    if (this.buckets.size > this.maxKeys) this.evictOldest()
  }

  private evictOldest(): void {
    const overflow = this.buckets.size - this.maxKeys
    let removed = 0
    for (const key of this.buckets.keys()) {
      if (removed >= overflow) break
      this.buckets.delete(key)
      removed += 1
    }
  }
}
