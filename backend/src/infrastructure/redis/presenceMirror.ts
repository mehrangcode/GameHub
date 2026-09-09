import type { Logger } from 'pino'
import type { PresenceEntry } from '../../contracts/dto/presence.js'
import { assertStorableKey, type RedisConnection } from './client.js'
import { presenceKey } from './keys.js'

/**
 * The presence mirror — S27.
 *
 * ### A mirror, emphatically not a source of truth
 *
 * The live presence state lives in `PresenceService`, in process, keyed by
 * identity and derived from open sockets. This writes a copy to Redis so a
 * *second* API instance can render a seat map without asking the first one.
 *
 * The distinction is the whole design, and it is what keeps this on the right
 * side of 02 §3.2:
 *
 *   - **Losing it costs one recomputation.** On restart the mirror is cleared
 *     and rebuilt from `io.fetchSockets()`, so a stale entry cannot outlive the
 *     process that wrote it. A persisted `state: 'online'` would survive a crash
 *     as a *lie* about somebody who is no longer there — which is worse than no
 *     data, because the seat map would show a player the other three are
 *     waiting on.
 *   - **Nothing reads it to make a decision.** Ejection, grace expiry and
 *     reward eligibility all read `TableMember.disconnectedAt`, which is in the
 *     database. This is for rendering.
 *
 * Every entry carries a TTL for the same reason: an instance that dies without
 * running its shutdown leaves rows behind, and they must age out rather than
 * accumulate.
 */

/** Long enough to survive a rolling restart, short enough that a crash self-heals. */
const MIRROR_TTL_SEC = 300

export class RedisPresenceMirror {
  constructor(
    private readonly redis: RedisConnection,
    private readonly logger: Logger,
  ) {}

  async publish(tableId: string, entries: readonly PresenceEntry[]): Promise<void> {
    if (!this.redis.isHealthy()) return
    const key = assertStorableKey(presenceKey(tableId))

    try {
      const pipeline = this.redis.client.multi()
      pipeline.del(key)

      if (entries.length > 0) {
        pipeline.hset(
          key,
          Object.fromEntries(entries.map((entry) => [entry.memberId, JSON.stringify(entry)])),
        )
        pipeline.expire(key, MIRROR_TTL_SEC)
      }

      await pipeline.exec()
    } catch (error) {
      // Never rethrown. A presence mirror that fails must not fail the seat
      // change that triggered it.
      this.logger.debug({ err: error, tableId }, 'presence mirror write failed')
    }
  }

  async read(tableId: string): Promise<PresenceEntry[]> {
    if (!this.redis.isHealthy()) return []

    try {
      const raw = await this.redis.client.hgetall(presenceKey(tableId))
      return Object.values(raw).flatMap((value) => {
        try {
          return [JSON.parse(value) as PresenceEntry]
        } catch {
          // A malformed entry is one seat badge, not a reason to render nothing.
          return []
        }
      })
    } catch (error) {
      this.logger.debug({ err: error, tableId }, 'presence mirror read failed')
      return []
    }
  }

  /**
   * Clears every mirrored table.
   *
   * Called at boot, **before** the gateway accepts connections: whatever the
   * previous process left behind describes sockets that no longer exist, and
   * publishing over it one table at a time would leave the tables nobody
   * rejoins showing phantom players forever.
   */
  async clearAll(): Promise<number> {
    if (!this.redis.isHealthy()) return 0

    try {
      const keys = await this.redis.client.keys(presenceKey('*'))
      if (keys.length === 0) return 0
      await this.redis.client.del(...keys)
      return keys.length
    } catch (error) {
      this.logger.warn({ err: error }, 'presence mirror clear failed')
      return 0
    }
  }
}
