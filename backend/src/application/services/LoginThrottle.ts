import type { IRateLimiter, RateLimitRule } from '../ports/rateLimiter.js'
import { RateLimitError } from '../../domain/errors/errors.js'

/**
 * The login-attempt throttle — 07 §5.3: 5 attempts / 15 min, per email **and**
 * per IP.
 *
 * Both keys, because either alone has a hole. Per-IP only lets one attacker
 * spray one password across thousands of accounts from one address; per-email
 * only lets a botnet grind a single account from thousands of addresses. The
 * pair closes both, and the per-email counter is what protects the account
 * whose password is actually weak.
 *
 * This is separate from the global rate limiter's bucket on purpose: burning
 * your page-view budget must not lock you out of logging in, and five bad
 * passwords must not cost you the rest of your browsing.
 */
export class LoginThrottle {
  private readonly rule: RateLimitRule

  constructor(
    private readonly limiter: IRateLimiter,
    maxAttempts: number,
    windowSec: number,
  ) {
    this.rule = { limit: maxAttempts, windowMs: windowSec * 1000 }
  }

  /**
   * Consumes one attempt against both keys.
   *
   * @throws {RateLimitError} when either is exhausted. The error carries
   * `retryAfterMs`, so the client can show a countdown instead of inviting the
   * user to keep guessing.
   */
  async attempt(email: string, ip: string): Promise<void> {
    const [byEmail, byIp] = await Promise.all([
      this.limiter.consume(this.emailKey(email), this.rule),
      this.limiter.consume(this.ipKey(ip), this.rule),
    ])

    const blocked = [byEmail, byIp].filter((decision) => !decision.allowed)
    if (blocked.length > 0) {
      const retryAfterMs = Math.max(...blocked.map((decision) => decision.retryAfterMs))
      // `scope` says which limit bit, for the audit row — not for the client.
      throw new RateLimitError(retryAfterMs, {
        scope: byEmail.allowed ? 'ip' : byIp.allowed ? 'email' : 'both',
      })
    }
  }

  /**
   * Clears both counters after a successful login.
   *
   * Without this, someone who mistypes four times and then gets in stays one
   * attempt from a lockout for the next 15 minutes — punishing the legitimate
   * user for having fingers.
   */
  async clear(email: string, ip: string): Promise<void> {
    await Promise.all([
      this.limiter.reset(this.emailKey(email)),
      this.limiter.reset(this.ipKey(ip)),
    ])
  }

  private emailKey(email: string): string {
    return `login:email:${email.toLowerCase()}`
  }

  private ipKey(ip: string): string {
    return `login:ip:${ip}`
  }
}
