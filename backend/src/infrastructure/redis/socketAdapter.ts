import { createAdapter } from '@socket.io/redis-adapter'
import type { Logger } from 'pino'
import type { RedisConnection } from './client.js'
import { SOCKET_ADAPTER_PREFIX } from './keys.js'

/**
 * The Socket.IO Redis adapter — S27, 04 §1.2.
 *
 * ### What it does, and what it does not
 *
 * It makes `io.to(room).emit(...)` reach sockets on **other** API instances, by
 * publishing the emit over Redis pub/sub. Without it, two instances behind a
 * load balancer are two separate tables: player A connects to instance 1,
 * player B to instance 2, and neither ever sees the other take a seat. That is
 * the single reason Redis is on the roadmap at all.
 *
 * It stores nothing durable — pub/sub is fire-and-forget, and a message nobody
 * is listening for is simply dropped. Which is exactly right for the payloads
 * it carries: a seat change nobody received is followed by a `table:snapshot`
 * on the next reconnect.
 *
 * ### Two connections, not one
 *
 * A Redis client in subscriber mode may issue no other commands, so the adapter
 * needs a dedicated subscriber alongside the publisher. `duplicate()` produces
 * one with the same configuration — including the bounded retry policy, which
 * matters: a subscriber that retries forever would keep a dead connection alive
 * and silently stop delivering.
 */
export function createRedisSocketAdapter(redis: RedisConnection, logger: Logger) {
  const pub = redis.client.duplicate()
  const sub = redis.client.duplicate()

  for (const [role, client] of [
    ['publisher', pub],
    ['subscriber', sub],
  ] as const) {
    client.on('error', (error: Error) => {
      // Logged at `warn`, never rethrown. A dropped adapter connection degrades
      // a multi-instance deployment to per-instance rooms; it must not take an
      // instance down, because the one that is still up is the one still
      // serving players.
      logger.warn({ err: error, role }, 'redis socket adapter connection error')
    })
  }

  return {
    adapter: createAdapter(pub, sub, { key: SOCKET_ADAPTER_PREFIX }),
    async close(): Promise<void> {
      await Promise.allSettled([pub.quit(), sub.quit()])
    },
  }
}
