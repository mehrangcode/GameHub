import { Redis } from 'ioredis'
import type { Logger } from 'pino'
import type { DependencyStatus } from '../prisma/health.js'
import { isForbiddenKey } from './keys.js'

/**
 * The Redis connection — S27, 02 §3.2.
 *
 * ### Redis is optional, and that is a product decision
 *
 * `REDIS_URL` unset means the in-memory socket adapter, the in-process rate
 * limiter, and no presence mirror. Everything works. This is not a
 * development convenience bolted on afterwards — it is what lets the whole
 * platform run on one small VPS with one process, which is the deployment M0
 * actually targets (02 §12). Redis earns its place when there is a second
 * instance, not before.
 *
 * ### Losing Redis degrades; it does not crash
 *
 * The four things Redis holds are all *cheap to lose*: rate-limit windows,
 * adapter traffic, and a presence mirror that is recomputed from live sockets.
 * So a Redis outage must never be an API outage. Every call site falls back,
 * `/ready` reports the truth, and the log says so once rather than on every
 * request.
 *
 * This is precisely why the four "must NEVER" rows in 02 §3.2 exist: the moment
 * something *not* cheap to lose is in here, "degrade gracefully" stops being an
 * option and this whole design is wrong. `keys.ts` enforces that.
 */

export interface RedisConnection {
  readonly client: Redis
  /** False after a connection error, until it reconnects. Drives the fallbacks. */
  isHealthy(): boolean
  check(): Promise<DependencyStatus>
  close(): Promise<void>
}

export interface RedisOptions {
  readonly url: string
  readonly logger: Logger
  readonly onDegraded?: () => void
}

export function createRedisConnection({ url, logger, onDegraded }: RedisOptions): RedisConnection {
  const client = new Redis(url, {
    lazyConnect: true,
    // ★ Bounded, deliberately. The default retries a command forever, which
    // turns a Redis outage into requests that hang instead of requests that
    // fall back — and a hung request is far harder to diagnose than a logged
    // "redis unavailable, using in-process limiter".
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  })

  let healthy = false
  let reportedDown = false

  client.on('ready', () => {
    healthy = true
    reportedDown = false
    logger.info({ url: redact(url) }, 'redis connected')
  })

  client.on('end', () => {
    healthy = false
  })

  client.on('error', (error: Error) => {
    healthy = false
    // Once per outage, not once per reconnect attempt: ioredis retries on a
    // timer, and logging each one buries everything else at exactly the moment
    // somebody is reading the log.
    if (!reportedDown) {
      reportedDown = true
      onDegraded?.()
      logger.warn({ err: error }, 'redis unavailable — degrading to in-process behaviour')
    }
  })

  void client.connect().catch(() => {
    // Handled by the 'error' listener above. Swallowed here so an unreachable
    // Redis at boot is a warning rather than an unhandled rejection that takes
    // the process down before it has served a request.
  })

  return {
    client,
    isHealthy: () => healthy,

    async check(): Promise<DependencyStatus> {
      const startedAt = Date.now()
      try {
        await client.ping()
        return { ok: true, latencyMs: Date.now() - startedAt }
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : 'redis ping failed',
        }
      }
    },

    async close(): Promise<void> {
      // `quit` waits for in-flight commands; `disconnect` is the fallback for a
      // connection that is already broken and would otherwise hang the exit.
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
    },
  }
}

/**
 * A runtime backstop for the `keys.ts` rule.
 *
 * The guard *test* is the primary defence and catches the mistake at build
 * time. This catches the one case a static test cannot: a key assembled from a
 * runtime value — `ratelimit:${bucket}` where `bucket` turns out to be
 * `wallet:credit:…`. Throwing rather than logging is right, because the caller
 * is about to store something in the one place it must not be.
 */
export function assertStorableKey(key: string): string {
  if (isForbiddenKey(key)) {
    throw new Error(
      `refusing to write '${key}' to Redis: 02 §3.2 forbids wallet, ledger, matchmaking-cooldown, ` +
        `game-state and reward-idempotency data in a store that may lose it`,
    )
  }
  return key
}

/** Keeps a password out of the log line. */
function redact(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password !== '') parsed.password = '***'
    return parsed.toString()
  } catch {
    return 'redis://***'
  }
}
