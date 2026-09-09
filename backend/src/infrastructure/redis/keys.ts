/**
 * ★ Every Redis key the platform will ever write, built here and nowhere else
 * — S27, 02 §3.2.
 *
 * ### The rule this file exists to enforce
 *
 * 02 §3.2 lists four things that may **never** live in Redis:
 *
 * | Must never be in Redis | Why |
 * |---|---|
 * | Wallet balances or ledger rows | Redis is not durable. A lost write is lost money (E1) |
 * | Matchmaking cooldowns | Losing one is a farming exploit, not a free extra request (09 §7.1) |
 * | Game state | The event log is the source of truth; a cache that can disagree with it is worse than no cache |
 * | Reward idempotency keys | The DB unique constraint *is* the double-credit protection (E2). A key in Redis is a key that can evaporate between two retries |
 *
 * "Never write those to Redis" is a rule somebody breaks by accident eighteen
 * months from now, in a caching PR that looks entirely reasonable. Funnelling
 * every key through named builders turns it into something a **test** can
 * check: `tests/unit/redis-keys.test.ts` asserts that no builder here produces
 * a key matching the forbidden vocabulary, and that no file outside this
 * directory constructs a Redis key at all.
 *
 * Redis holds what is *cheap to lose and expensive to compute*. That is the
 * whole list below: rate-limit windows, socket-adapter traffic, and a presence
 * mirror that is recomputed from live sockets on restart anyway.
 */

export const REDIS_NAMESPACE = 'bg'

/** Sliding-window rate limits (S12's port, S27's implementation). */
export function rateLimitKey(bucketKey: string): string {
  return `${REDIS_NAMESPACE}:ratelimit:${bucketKey}`
}

/**
 * Presence, mirrored per table.
 *
 * A *mirror*, not the source: `PresenceService` holds the live state in
 * process, and after a restart it is recomputed from `io.fetchSockets()`. The
 * mirror exists so a second API instance can render the seat map without asking
 * the first one, and losing it costs one recomputation.
 */
export function presenceKey(tableId: string): string {
  return `${REDIS_NAMESPACE}:presence:${tableId}`
}

/** The channel prefix `@socket.io/redis-adapter` publishes room traffic on. */
export const SOCKET_ADAPTER_PREFIX = `${REDIS_NAMESPACE}:socket.io`

/**
 * The vocabulary that must never appear in a Redis key, as a machine-checkable
 * list rather than a paragraph in a document.
 *
 * Deliberately broad — `reward`, `idempotenc`, `ledger` — because the point is
 * to catch the *shape* of a mistake early, not to be precise about a mistake
 * that has already shipped. A false positive here is a two-minute conversation;
 * a false negative is a balance that disagrees with its ledger.
 */
export const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  'wallet',
  'ledger',
  'balance',
  'coin',
  'transaction',
  'idempotenc',
  'reward',
  'cooldown',
  'gamestate',
  'game:state',
  'snapshot',
]

/** Used by the guard test *and* by the client, which refuses such a key at runtime. */
export function isForbiddenKey(key: string): boolean {
  const lowered = key.toLowerCase()
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))
}
