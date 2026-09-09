import type {
  IRateLimiter,
  RateLimitDecision,
  RateLimitRule,
} from '../../application/ports/rateLimiter.js'
import type { Logger } from 'pino'
import { SlidingWindowRateLimiter } from '../rateLimit/slidingWindow.js'
import { assertStorableKey, type RedisConnection } from './client.js'
import { rateLimitKey } from './keys.js'

/**
 * The Redis-backed sliding window — S27, behind the port S12 declared.
 *
 * Same algorithm as the in-process twin, same reason: a *fixed* window lets a
 * client spend its whole budget in the last second of one window and again in
 * the first second of the next, which is 2× the intended burst right at the
 * boundary. Keeping the hit timestamps removes that class of bug entirely.
 *
 * ### The Lua script, and why it is not four commands
 *
 * The whole operation — drop expired hits, count what is left, decide, record —
 * must be atomic. As a pipeline of four commands it is a read-modify-write with
 * a gap in the middle, and two requests arriving together both read the old
 * count and both get through. That is not theoretical: it is exactly the
 * scenario a limiter exists for. `EVAL` runs the lot inside Redis, single-
 * threaded, with no gap.
 *
 * ### A denied hit is not recorded
 *
 * The same property the in-process limiter has, restated here because it is
 * easy to lose when porting: counting rejections would let a client that keeps
 * hammering push its own reset time forward forever, turning a 60-second
 * cooldown into an indefinite lockout for the one user who retries hardest.
 *
 * ### Falling back
 *
 * When Redis is unreachable, calls route to an in-process limiter rather than
 * throwing or failing open. Failing *open* would remove the protection at
 * exactly the moment the system is under stress; throwing would turn a cache
 * outage into an API outage. A per-instance budget is a strictly weaker
 * guarantee than a shared one, and strictly stronger than none.
 */
export class RedisRateLimiter implements IRateLimiter {
  private readonly fallback = new SlidingWindowRateLimiter()

  constructor(
    private readonly redis: RedisConnection,
    private readonly logger: Logger,
  ) {}

  async consume(key: string, rule: RateLimitRule, now = new Date()): Promise<RateLimitDecision> {
    if (!this.redis.isHealthy()) return this.fallback.consume(key, rule, now)

    const nowMs = now.getTime()
    // Deliberately outside the try/catch below: a forbidden bucket name is a
    // bug in *our* code, not a Redis outage, and routing it to the fallback
    // would keep Redis clean while letting the mistake ship. It must fail on
    // the first request in development, which is where it belongs.
    const redisKey = assertStorableKey(rateLimitKey(key))

    try {
      const raw = (await this.redis.client.eval(
        SLIDING_WINDOW,
        1,
        redisKey,
        String(nowMs),
        String(rule.windowMs),
        String(rule.limit),
        // A member has to be unique per hit, or two hits in the same millisecond
        // collapse into one sorted-set entry and the second is free.
        `${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
      )) as [number, number]

      // `[1, remaining]` when allowed, `[0, oldestHitMs]` when denied.
      const [allowed, value] = raw

      if (allowed === 1) {
        return {
          allowed: true,
          limit: rule.limit,
          remaining: Math.max(0, Number(value)),
          retryAfterMs: 0,
          resetAt: new Date(nowMs + rule.windowMs),
        }
      }

      const freesAt = Number(value) + rule.windowMs
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        retryAfterMs: Math.max(1, freesAt - nowMs),
        resetAt: new Date(freesAt),
      }
    } catch (error) {
      this.logger.warn({ err: error, key }, 'redis rate limit failed — falling back in-process')
      return this.fallback.consume(key, rule, now)
    }
  }

  async reset(key: string): Promise<void> {
    await this.fallback.reset(key)
    if (!this.redis.isHealthy()) return

    try {
      await this.redis.client.del(rateLimitKey(key))
    } catch (error) {
      this.logger.warn({ err: error, key }, 'redis rate limit reset failed')
    }
  }

  dispose(): void {
    this.fallback.dispose()
  }
}

/**
 * `[allowed, value]` where `value` is the remaining budget when allowed, and
 * the **oldest hit's timestamp** when denied — which is what `retryAfterMs` is
 * computed from, because that is the moment the window frees a slot.
 *
 * `PEXPIRE` on every call is what keeps the keyspace bounded: a bucket nobody
 * touches again evaporates one window after its last hit, so a million distinct
 * IPs do not become a million permanent keys.
 */
const SLIDING_WINDOW = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local member   = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local hits = redis.call('ZCARD', key)

if hits >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  redis.call('PEXPIRE', key, windowMs)
  return { 0, tonumber(oldest[2]) or now }
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return { 1, limit - hits - 1 }
`
