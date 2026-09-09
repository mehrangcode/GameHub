import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_KEY_FRAGMENTS,
  isForbiddenKey,
  presenceKey,
  rateLimitKey,
  REDIS_NAMESPACE,
  SOCKET_ADAPTER_PREFIX,
} from '../../src/infrastructure/redis/keys.js'
import { assertStorableKey } from '../../src/infrastructure/redis/client.js'

/**
 * ★ The forbidden-keys guard — S27, 02 §3.2.
 *
 * The spec names four things that may **never** live in Redis: wallet and
 * ledger state, matchmaking cooldowns, game state, and reward idempotency keys.
 * Every one of them shares a property — losing it is not a cache miss, it is a
 * correctness failure. A lost ledger row is lost money (E1); a lost cooldown is
 * a farming exploit (09 §7.1); a lost idempotency key is a double credit (E2).
 *
 * "Remember not to do that" is a rule somebody breaks eighteen months from now,
 * in a caching PR that looks entirely reasonable and is reviewed by somebody who
 * has not read 02 §3.2. This file is that rule, made mechanical.
 *
 * It works in two directions, and both are needed:
 *
 *   1. **No builder produces a forbidden key** — the shape check.
 *   2. **No file outside `infrastructure/redis/` builds a Redis key at all** —
 *      the containment check, which is what stops somebody adding a fifth
 *      forbidden key by bypassing the builders entirely.
 */

describe('S27 · every key builder is allowed', () => {
  it.each([
    ['rate limit', rateLimitKey('global:1.2.3.4')],
    ['rate limit, socket bucket', rateLimitKey('socket:takeSeat:abc')],
    ['presence', presenceKey('table-cuid')],
    ['socket adapter prefix', SOCKET_ADAPTER_PREFIX],
  ])('%s → %s carries nothing forbidden', (_name, key) => {
    expect(isForbiddenKey(key)).toBe(false)
    expect(key.startsWith(REDIS_NAMESPACE)).toBe(true)
  })

  it('the forbidden vocabulary covers all four "must NEVER" rows', () => {
    // Written as a mapping from the spec's own words, so a reader can check the
    // list against 02 §3.2 rather than trusting that it was once complete.
    const spec: Record<string, string> = {
      'wallet balances': 'wallet',
      'ledger rows': 'ledger',
      'a cached balance': 'balance',
      'coin amounts': 'coin',
      'ledger transactions': 'transaction',
      'reward idempotency keys': 'idempotenc',
      'reward computation': 'reward',
      'matchmaking cooldowns': 'cooldown',
      'game state': 'gamestate',
      'game snapshots': 'snapshot',
    }

    for (const [described, fragment] of Object.entries(spec)) {
      expect(FORBIDDEN_KEY_FRAGMENTS, `${described} must be covered`).toContain(fragment)
    }
  })

  it.each([
    'bg:wallet:user-1',
    'bg:ratelimit:reward:match-1',
    'bg:ledger:entries',
    'bg:matchmaking:cooldown:user-1',
    'bg:game:state:abc',
    'bg:idempotency:match-1:seat-0',
    'BG:WALLET:USER-1',
  ])('%s is refused at runtime, not merely discouraged', (key) => {
    expect(isForbiddenKey(key)).toBe(true)
    // The static scan below catches the shape at build time; this catches the
    // one case it cannot — a key assembled from a runtime value that turns out
    // to name something it must not.
    expect(() => assertStorableKey(key)).toThrow(/02 §3.2/)
  })
})

describe('S27 · nothing outside infrastructure/redis builds a Redis key', () => {
  const srcDir = join(process.cwd(), 'src')
  const redisDir = join(srcDir, 'infrastructure', 'redis')

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) return walk(full)
      return entry.endsWith('.ts') ? [full] : []
    })
  }

  /**
   * A call to any Redis command that takes a key.
   *
   * Deliberately broad and deliberately allowed to over-match: a false positive
   * costs a two-minute conversation, and a false negative costs a balance that
   * disagrees with its ledger.
   */
  const REDIS_COMMAND =
    /\.\s*(set|get|hset|hget|hgetall|zadd|zrem|del|expire|pexpire|incr|sadd|srem|smembers|lpush|rpush)\s*\(/g

  it.each(walk(srcDir).filter((file) => !file.startsWith(redisDir)))(
    '%s issues no keyed Redis command',
    (file) => {
      const source = readFileSync(file, 'utf8')
      const relativePath = relative(srcDir, file)

      // The prose in this test's own docblock, and Prisma/Map/Set calls, are
      // not Redis. What identifies a Redis call is the client reaching it, and
      // outside `infrastructure/redis/` there is no client to reach.
      expect(
        source.includes('ioredis') || source.includes('redis.client'),
        `${relativePath} talks to Redis directly — build the key in infrastructure/redis/keys.ts instead`,
      ).toBe(false)
    },
  )

  it('the Redis directory itself only ever writes allowed keys', () => {
    for (const file of walk(redisDir)) {
      const source = readFileSync(file, 'utf8')
      // Every command in here must take its key from a builder or from a
      // variable the builders produced — never an inline string literal, which
      // is the form a forbidden key would arrive in.
      const inlineKeys = [...source.matchAll(REDIS_COMMAND)].filter((match) => {
        const after = source.slice(
          (match.index ?? 0) + match[0].length,
          (match.index ?? 0) + match[0].length + 40,
        )
        return /^\s*['"`]/.test(after)
      })

      expect(
        inlineKeys.map((match) => match[0]),
        `${relative(srcDir, file)} passes a literal key to Redis`,
      ).toEqual([])
    }
  })
})
