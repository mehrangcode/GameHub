import { afterEach, describe, expect, it } from 'vitest'
import type { RateLimitRule } from '../../src/application/ports/rateLimiter.js'
import { SlidingWindowRateLimiter } from '../../src/infrastructure/rateLimit/slidingWindow.js'

const rule: RateLimitRule = { limit: 3, windowMs: 1000 }
const limiters: SlidingWindowRateLimiter[] = []

function build(sweepMs = 0, maxKeys = 50_000): SlidingWindowRateLimiter {
  const limiter = new SlidingWindowRateLimiter(sweepMs, maxKeys)
  limiters.push(limiter)
  return limiter
}

afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.dispose()
})

const at = (ms: number) => new Date(ms)

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit and then denies', async () => {
    const limiter = build()

    for (let i = 1; i <= 3; i += 1) {
      const decision = await limiter.consume('k', rule, at(i))
      expect(decision.allowed, `hit ${i}`).toBe(true)
      expect(decision.remaining).toBe(3 - i)
    }

    const denied = await limiter.consume('k', rule, at(4))
    expect(denied.allowed).toBe(false)
    expect(denied.remaining).toBe(0)
  })

  it('reports when to come back', async () => {
    const limiter = build()
    for (const t of [0, 100, 200]) await limiter.consume('k', rule, at(t))

    // The oldest hit was at t=0, so the window frees a slot at t=1000.
    const denied = await limiter.consume('k', rule, at(400))
    expect(denied.retryAfterMs).toBe(600)
    expect(denied.resetAt.getTime()).toBe(1000)
  })

  it('★ slides — a hit ageing out frees exactly one slot', async () => {
    const limiter = build()
    for (const t of [0, 500, 900]) await limiter.consume('k', rule, at(t))
    expect((await limiter.consume('k', rule, at(950))).allowed).toBe(false)

    // At t=1001 the hit from t=0 has left the window. One slot, not three —
    // which is exactly what a fixed window gets wrong at the boundary.
    expect((await limiter.consume('k', rule, at(1001))).allowed).toBe(true)
    expect((await limiter.consume('k', rule, at(1002))).allowed).toBe(false)
  })

  it('★ does not count a denied hit — hammering cannot extend the lockout', async () => {
    const limiter = build()
    for (const t of [0, 1, 2]) await limiter.consume('k', rule, at(t))

    // Twenty rejected attempts spread across the window…
    for (let t = 10; t < 900; t += 45) await limiter.consume('k', rule, at(t))

    // …and the window still opens on schedule, based on the three real hits.
    expect((await limiter.consume('k', rule, at(1001))).allowed).toBe(true)
  })

  it('keys are independent', async () => {
    const limiter = build()
    for (const t of [0, 1, 2]) await limiter.consume('a', rule, at(t))

    expect((await limiter.consume('a', rule, at(3))).allowed).toBe(false)
    expect((await limiter.consume('b', rule, at(3))).allowed).toBe(true)
  })

  it('reset forgets a key — the successful-login case', async () => {
    const limiter = build()
    for (const t of [0, 1, 2]) await limiter.consume('k', rule, at(t))
    expect((await limiter.consume('k', rule, at(3))).allowed).toBe(false)

    await limiter.reset('k')
    expect((await limiter.consume('k', rule, at(4))).allowed).toBe(true)
  })

  it('sweeps buckets whose own window has passed, and keeps the rest', async () => {
    const limiter = build()
    const long: RateLimitRule = { limit: 5, windowMs: 900_000 }

    await limiter.consume('short', rule, at(0))
    await limiter.consume('long', long, at(0))
    expect(limiter.size()).toBe(2)

    // A 1-minute sweep must not evict a 15-minute login throttle. That bug
    // would silently uncap the login limiter.
    limiter.sweep(60_000)
    expect(limiter.size()).toBe(1)
    expect((await limiter.consume('long', long, at(60_001))).remaining).toBe(3)
  })

  it('evicts least-recently-used keys rather than growing without bound', async () => {
    const limiter = build(0, 2)

    await limiter.consume('a', rule, at(0))
    await limiter.consume('b', rule, at(1))
    await limiter.consume('a', rule, at(2)) // touches 'a', so 'b' is now oldest
    await limiter.consume('c', rule, at(3))

    expect(limiter.size()).toBe(2)
    // 'a' kept its history; 'b' was dropped, which costs a counter, not memory.
    expect((await limiter.consume('a', rule, at(4))).remaining).toBe(0)
    expect((await limiter.consume('b', rule, at(4))).remaining).toBe(2)
  })

  it('holds a full window of hits and then denies, at scale', async () => {
    const limiter = build()
    const wide: RateLimitRule = { limit: 100, windowMs: 60_000 }

    const outcomes = []
    for (let i = 0; i < 120; i += 1) outcomes.push(await limiter.consume('k', wide, at(i)))

    expect(outcomes.filter((d) => d.allowed)).toHaveLength(100)
    expect(outcomes.filter((d) => !d.allowed)).toHaveLength(20)
  })
})
