/**
 * The rate-limiting port — 02 §3.2, 07 §5.2/§5.3.
 *
 * Declared in `application/` rather than `infrastructure/` for one reason: S27
 * replaces the in-process implementation with a Redis-backed one, and that swap
 * must be a single line in `container.ts`. If the middleware imported the
 * concrete limiter, "add Redis" would become "touch every call site".
 *
 * Note what this port does **not** promise: durability. Redis may hold rate
 * limits precisely because they are cheap to lose and expensive to compute
 * (02 §3.2). Matchmaking cooldowns, which look similar, may never live here —
 * losing one of those is a farming exploit, not a free extra request.
 */

export interface RateLimitRule {
  /** Requests permitted per window. */
  readonly limit: number
  readonly windowMs: number
}

export interface RateLimitDecision {
  readonly allowed: boolean
  readonly limit: number
  /** Requests left in the current window; 0 when denied. */
  readonly remaining: number
  /** 0 when allowed. Becomes `retryAfterMs` on the `RATE_LIMITED` error. */
  readonly retryAfterMs: number
  /** When the window will next have room. */
  readonly resetAt: Date
}

export interface IRateLimiter {
  /**
   * Records one hit against `key` and reports whether it is permitted.
   *
   * A **denied** hit is not recorded. Counting rejections would let a client
   * that keeps hammering push its own reset time forever, turning a 60-second
   * cooldown into an indefinite lockout.
   */
  consume(key: string, rule: RateLimitRule, now?: Date): Promise<RateLimitDecision>

  /**
   * Forgets a key. The login throttle uses it: five *failed* attempts lock the
   * account for 15 minutes, but a success has to clear the counter, or a
   * legitimate user who mistyped four times stays throttled after getting in.
   */
  reset(key: string): Promise<void>

  /** Releases timers. Called by `container.shutdown()`. */
  dispose(): void
}
