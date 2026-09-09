import { afterEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { RedisRateLimiter } from '../../src/infrastructure/redis/RedisRateLimiter.js'
import { RedisPresenceMirror } from '../../src/infrastructure/redis/presenceMirror.js'
import { presenceKey, rateLimitKey } from '../../src/infrastructure/redis/keys.js'
import type { RedisConnection } from '../../src/infrastructure/redis/client.js'
import { buildContainer } from '../../src/container.js'
import { parseEnv } from '../../src/config/env.js'
import { db } from '../helpers/db.js'

/**
 * S27 — Redis, and the fact that the app does not need it.
 *
 * There is deliberately no real Redis here. A test suite that required a
 * container running would be a suite that gets skipped in CI and on a laptop,
 * and the property being asserted — *the fallbacks work* — is one you cannot
 * observe with a healthy Redis anyway. So the client is a fake that records
 * every key it is asked to touch, which turns "does money ever reach Redis?"
 * into an assertion rather than a `redis-cli KEYS '*wallet*'` somebody remembers
 * to run.
 *
 * `docker compose up -d redis` plus the `You verify` steps in `11` §8 cover the
 * real thing, once, by hand.
 */

const silent = pino({ level: 'silent' })

/** Records every key touched, and can be made to fail on command. */
function fakeRedis(): {
  connection: RedisConnection
  keys: string[]
  store: Map<string, Map<string, string>>
  healthy: boolean
  fail: boolean
} {
  const state = {
    keys: [] as string[],
    store: new Map<string, Map<string, string>>(),
    healthy: true,
    fail: false,
  }

  const note = (key: string) => {
    state.keys.push(key)
    if (state.fail) throw new Error('redis is down')
  }

  const client = {
    async eval(_script: unknown, _numKeys: number, key: string) {
      note(key)
      return [1, 4]
    },
    async del(...keys: string[]) {
      for (const key of keys) note(key)
      return keys.length
    },
    async keys(pattern: string) {
      note(pattern)
      return [...state.store.keys()]
    },
    async hgetall(key: string) {
      note(key)
      return Object.fromEntries(state.store.get(key) ?? new Map())
    },
    multi() {
      const queued: Array<() => void> = []
      const chain = {
        del: (key: string) => {
          queued.push(() => note(key))
          return chain
        },
        hset: (key: string, values: Record<string, string>) => {
          queued.push(() => {
            note(key)
            state.store.set(key, new Map(Object.entries(values)))
          })
          return chain
        },
        expire: (key: string) => {
          queued.push(() => note(key))
          return chain
        },
        async exec() {
          for (const step of queued) step()
          return []
        },
      }
      return chain
    },
  }

  return {
    ...state,
    connection: {
      client: client as never,
      isHealthy: () => state.healthy,
      check: async () => ({ ok: state.healthy, latencyMs: 1 }),
      close: async () => undefined,
    },
    get keys() {
      return state.keys
    },
    get store() {
      return state.store
    },
    get healthy() {
      return state.healthy
    },
    set healthy(value: boolean) {
      state.healthy = value
    },
    get fail() {
      return state.fail
    },
    set fail(value: boolean) {
      state.fail = value
    },
  } as never
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('S27 · with REDIS_URL unset', () => {
  it('★ the container builds, with the in-process limiter and no mirror', () => {
    const container = buildContainer({
      prisma: db,
      logger: silent,
      env: parseEnv({ ...process.env, REDIS_URL: undefined }),
    })

    // Not a degraded configuration — the correct one for the single-process
    // deployment M0 actually targets (02 §12). Redis earns its place when there
    // is a second instance.
    expect(container.redis).toBeNull()
    expect(container.presenceMirror).toBeNull()
  })

  it('/ready reports only the dependencies that exist', async () => {
    const container = buildContainer({
      prisma: db,
      logger: silent,
      env: parseEnv({ ...process.env, REDIS_URL: undefined }),
    })

    const checks = await container.checkReadiness()

    // Listing an unconfigured dependency as failing would take a perfectly
    // healthy instance out of rotation for not having a Redis it never wanted.
    expect(Object.keys(checks)).toEqual(['database'])
    expect(checks['database']?.ok).toBe(true)
  })
})

describe('S27 · the rate limiter', () => {
  it('counters land in Redis, under the ratelimit namespace', async () => {
    const redis = fakeRedis()
    const limiter = new RedisRateLimiter(redis.connection, silent)

    const decision = await limiter.consume('global:1.2.3.4', { limit: 5, windowMs: 1_000 })

    expect(decision.allowed).toBe(true)
    expect(redis.keys).toEqual([rateLimitKey('global:1.2.3.4')])

    limiter.dispose()
  })

  it('★ Redis dropping mid-session degrades to the in-process limiter', async () => {
    const redis = fakeRedis()
    const limiter = new RedisRateLimiter(redis.connection, silent)

    redis.fail = true

    // Not failing *open* — that removes the protection at exactly the moment the
    // system is under stress — and not throwing, which would turn a cache
    // outage into an API outage. A per-instance budget is weaker than a shared
    // one and stronger than none.
    const rule = { limit: 2, windowMs: 60_000 }
    expect((await limiter.consume('k', rule)).allowed).toBe(true)
    expect((await limiter.consume('k', rule)).allowed).toBe(true)
    expect((await limiter.consume('k', rule)).allowed).toBe(false)

    limiter.dispose()
  })

  it('an unhealthy connection is not even attempted', async () => {
    const redis = fakeRedis()
    const limiter = new RedisRateLimiter(redis.connection, silent)
    redis.healthy = false

    await limiter.consume('k', { limit: 5, windowMs: 1_000 })
    expect(redis.keys).toEqual([])

    limiter.dispose()
  })

  it('★ no ledger, cooldown, game-state or idempotency key ever reaches Redis', async () => {
    const redis = fakeRedis()
    const limiter = new RedisRateLimiter(redis.connection, silent)
    const mirror = new RedisPresenceMirror(redis.connection, silent)

    // Exercise every write path this milestone has.
    await limiter.consume('global:1.2.3.4', { limit: 5, windowMs: 1_000 })
    await limiter.consume('socket:takeSeat:abc', { limit: 5, windowMs: 1_000 })
    await limiter.consume('chat:text:user:u1', { limit: 5, windowMs: 1_000 })
    await limiter.reset('global:1.2.3.4')
    await mirror.publish('table-1', [
      { memberId: 'm1', seat: 1, state: 'online', graceEndsAt: null },
    ])
    await mirror.clearAll()

    expect(redis.keys.length).toBeGreaterThan(0)
    for (const key of redis.keys) {
      expect(key, `${key} must not name money, cooldowns or game state`).not.toMatch(
        /wallet|ledger|balance|coin|transaction|idempotenc|reward|cooldown|gamestate|snapshot/i,
      )
    }

    limiter.dispose()
  })

  it('★ a bucket that names money throws, loudly, before anything is written', async () => {
    const redis = fakeRedis()
    const limiter = new RedisRateLimiter(redis.connection, silent)

    /**
     * The runtime backstop for a key assembled from a *runtime* value — the one
     * case the static scan cannot see.
     *
     * It throws rather than quietly falling back, and that is deliberate. A
     * bucket named `wallet:credit:…` is a bug in our own code, not hostile
     * input, and it will only ever exist because somebody keyed a limiter on
     * something they should not have. Degrading silently would keep Redis clean
     * and let the mistake ship; failing makes it impossible to miss on the
     * first request in development, which is where it belongs.
     */
    await expect(
      limiter.consume('wallet:credit:user-1', { limit: 5, windowMs: 1_000 }),
    ).rejects.toThrow(/02 §3.2/)

    expect(redis.keys).toEqual([])

    limiter.dispose()
  })
})

describe('S27 · the presence mirror', () => {
  it('writes under the presence namespace and reads back', async () => {
    const redis = fakeRedis()
    const mirror = new RedisPresenceMirror(redis.connection, silent)

    await mirror.publish('table-9', [
      { memberId: 'm1', seat: 0, state: 'disconnected', graceEndsAt: '2026-01-01T00:00:00.000Z' },
    ])

    expect(redis.keys).toContain(presenceKey('table-9'))
    await expect(mirror.read('table-9')).resolves.toEqual([
      { memberId: 'm1', seat: 0, state: 'disconnected', graceEndsAt: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('★ presence is cleared at boot, so a restart cannot leave phantom players', async () => {
    const redis = fakeRedis()
    const mirror = new RedisPresenceMirror(redis.connection, silent)

    await mirror.publish('table-a', [
      { memberId: 'm1', seat: 0, state: 'online', graceEndsAt: null },
    ])

    // Whatever the previous process left describes sockets that no longer
    // exist. A persisted `online` would survive a crash as a *lie* about
    // somebody the other three are waiting on.
    const cleared = await mirror.clearAll()
    expect(cleared).toBeGreaterThan(0)
  })

  it('a mirror failure never propagates — it is a convenience, not a source', async () => {
    const redis = fakeRedis()
    const mirror = new RedisPresenceMirror(redis.connection, silent)
    redis.fail = true

    await expect(
      mirror.publish('table-b', [{ memberId: 'm', seat: 1, state: 'online', graceEndsAt: null }]),
    ).resolves.toBeUndefined()
    await expect(mirror.read('table-b')).resolves.toEqual([])
  })
})
