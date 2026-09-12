import type { RateLimitRule } from '../application/ports/rateLimiter.js'

/**
 * 04-realtime-protocol.md §8, transcribed — one table, one place.
 *
 * These are *policy* constants rather than environment variables, deliberately.
 * A limit that can be raised by an env var is a limit somebody raises at 2 a.m.
 * to make a symptom go away; a limit in the repository is a limit that gets a
 * commit message. The two that genuinely vary by deployment — the global HTTP
 * budget and the invite-resolve budget — already live in `env.ts`, because a
 * shared-IP office and a home connection really do need different numbers.
 *
 * Each rule is keyed per *socket* or per *identity*, and the difference matters:
 *
 *   - **Per socket** (`game:move`, seat changes): the cost being controlled is
 *     server work on one connection. Opening a second tab genuinely doubles the
 *     legitimate need.
 *   - **Per identity** (`chat:send`): the cost is other players' attention.
 *     Five tabs must not buy five times the spam.
 */

/** `chat:send` — 5 per 10 s per identity. Text is the one people abuse. */
export const CHAT_SEND_RULE: RateLimitRule = { limit: 5, windowMs: 10_000 }

/**
 * `chat:emote` — 10 per 10 s, its own bucket.
 *
 * Independent from text on purpose: an emote is a reaction, and reacting to
 * four things in a fast hand must not cost you the ability to say "nice one".
 * A shared bucket would make the cheaper action eat the more valuable one.
 */
export const CHAT_EMOTE_RULE: RateLimitRule = { limit: 10, windowMs: 10_000 }

/** `table:takeSeat` and friends — 5 per 10 s per socket. Seat-flapping is noise. */
export const SEAT_CHANGE_RULE: RateLimitRule = { limit: 5, windowMs: 10_000 }

/** `table:join` — generous; a reconnect loop on a bad line must not be punished. */
export const TABLE_JOIN_RULE: RateLimitRule = { limit: 20, windowMs: 10_000 }

/**
 * `game:move` — 10 per 5 s per socket (04 §8).
 *
 * Per socket, because the cost is server work on one connection. The real
 * protection against a move flood is not this number at all: a seat that is not
 * to act gets `NOT_YOUR_TURN` from the engine, which is cheaper than a limiter
 * and produces an `AUDIT` row the limiter would not. This is the backstop for a
 * client looping on its *own* turn.
 */
export const GAME_MOVE_RULE: RateLimitRule = { limit: 10, windowMs: 5_000 }

/**
 * `game:requestSync` — 3 per 10 s (04 §8).
 *
 * Tighter than `table:join` despite both being reconnection traffic, because a
 * sync is genuinely expensive (a rebuild plus a projection) where a join is
 * not. A client that needs a fourth sync in ten seconds has a bug, and serving
 * it faster would only hide the bug under load.
 */
export const GAME_SYNC_RULE: RateLimitRule = { limit: 3, windowMs: 10_000 }

/**
 * ★ The illegal-move throttle — 5 rejections in 30 s per identity (04 §8).
 *
 * Not a rate limit: exceeding it refuses nothing. It promotes the *next*
 * `SecurityEvent` from `INFO` to `ALERT`, because one rejected move is a
 * mis-click and five in half a minute is somebody walking the move grammar to
 * see what the server accepts — which is the clearest probing signal this
 * protocol produces, and the one thing here worth waking a human for.
 */
export const ILLEGAL_MOVE_ALERT_RULE: RateLimitRule = { limit: 5, windowMs: 30_000 }

/**
 * Handshake failures — 10 per minute per IP.
 *
 * The only budget that applies *before* identity exists, which is why it is
 * keyed by address. It counts failures only: a hundred successful reconnections
 * from a phone in a tunnel is the product working.
 */
export const HANDSHAKE_FAILURE_RULE: RateLimitRule = { limit: 10, windowMs: 60_000 }

/**
 * Concurrent sockets per identity — 5, oldest evicted.
 *
 * Not a rate limit: a limit on simultaneous state. Five covers a laptop, a
 * phone, a tablet and two stale tabs the browser has not yet reaped. Evicting
 * the *oldest* rather than refusing the newest is what keeps "it stopped
 * working until I closed every tab" from being a support conversation.
 */
export const MAX_SOCKETS_PER_IDENTITY = 5

/**
 * How long after its last heartbeat a seat is shown as `away` (04 §3.1).
 *
 * Three missed 15-second beats. Two would flag a garbage-collection pause on a
 * cheap phone; four is long enough that "are they still there?" has already
 * been asked out loud.
 */
export const PRESENCE_AWAY_AFTER_MS = 45_000

/** How often the away sweeper runs. Coarse — `away` is a hint, not a deadline. */
export const PRESENCE_SWEEP_MS = 10_000
