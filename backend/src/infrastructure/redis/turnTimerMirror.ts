import type { Logger } from 'pino'
import { assertStorableKey, type RedisConnection } from './client.js'
import { turnTimerKey } from './keys.js'

/**
 * Turn deadlines, mirrored — S31, 04 §6.1 and §5.4.
 *
 * ### Why this exists at all, given the deadline is already in the log
 *
 * 04 §6.1 asks for both, and they answer different questions. The `PHASE` event
 * is **durable**: it is what `TurnTimerService.resume()` reads after a restart,
 * and it is why a deploy cannot gift an idling player another thirty seconds.
 * This key is **shared**: it is how a second API instance renders a countdown
 * for a table whose timer a different instance armed.
 *
 * The ordering follows from that. The event is written first and the mirror
 * second; a mirror write that fails is logged and swallowed, because a Redis
 * hiccup must never be able to fail the move that just changed whose turn it
 * is. Nothing in this codebase reads the mirror to make a decision.
 *
 * ### And why a deadline is allowed in Redis when game state is not
 *
 * 02 §3.2 forbids game state here, and this is not game state: it is one
 * absolute timestamp, derivable from the log at any moment, and losing it costs
 * a countdown ring until the next turn arms a fresh one. `assertStorableKey`
 * checks the name against the forbidden vocabulary on every call anyway — the
 * runtime backstop for a key assembled from a runtime value.
 */

/**
 * A deadline outlives itself by a minute at most.
 *
 * Long enough that a clock skew between instances cannot expire a live
 * countdown; short enough that a process which dies without clearing its keys
 * leaves nothing behind worth finding.
 */
const TIMER_TTL_SEC = 60

export class RedisTurnTimerMirror {
  constructor(
    private readonly redis: RedisConnection,
    private readonly logger: Logger,
  ) {}

  async set(gameId: string, endsAt: Date): Promise<void> {
    if (!this.redis.isHealthy()) return
    const key = assertStorableKey(turnTimerKey(gameId))

    try {
      // Stored as an ISO string rather than epoch millis: the one time anybody
      // reads this by hand is `redis-cli GET` during S31's verification step,
      // and `2026-09-12T18:04:31.000Z` is checkable against a `game:turnTimer`
      // payload at a glance where `1789412671000` is not.
      await this.redis.client.set(key, endsAt.toISOString(), 'EX', TIMER_TTL_SEC)
    } catch (error) {
      this.logger.debug({ err: error, gameId }, 'turn timer mirror write failed')
    }
  }

  async clear(gameId: string): Promise<void> {
    if (!this.redis.isHealthy()) return

    try {
      await this.redis.client.del(turnTimerKey(gameId))
    } catch (error) {
      this.logger.debug({ err: error, gameId }, 'turn timer mirror clear failed')
    }
  }

  /** For a second instance rendering a countdown it did not arm. */
  async read(gameId: string): Promise<Date | null> {
    if (!this.redis.isHealthy()) return null

    try {
      const raw = await this.redis.client.get(turnTimerKey(gameId))
      if (raw === null) return null

      const endsAt = new Date(raw)
      return Number.isNaN(endsAt.getTime()) ? null : endsAt
    } catch (error) {
      this.logger.debug({ err: error, gameId }, 'turn timer mirror read failed')
      return null
    }
  }
}
