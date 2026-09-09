/**
 * In-process counters and gauges — 02 §11, S15.
 *
 * **Not an HTTP route.** `GET /metrics` lives on the admin process from S49
 * (12 §11.1); exposing it on `:3000` behind a role check is exactly the
 * arrangement the admin-isolation rule exists to prevent. This class produces
 * the numbers; something else decides who may read them.
 *
 * Deliberately not Prometheus: a single-process deployment with no scraper is
 * not a metrics *system*, and pulling in a client library now would be
 * infrastructure for an audience of one. The shape below — named series, a
 * snapshot, a reset — is what a Prometheus exporter would read from anyway.
 */

/** Monotonically increasing since process start. */
export const COUNTERS = [
  'games_started',
  'games_finished',
  'moves_applied',
  'moves_rejected',
  'illegal_moves',
  'not_your_turn',
  'reconnects',
  'ejections',
  'rate_limit_trips',
  'logins',
  'logins_failed',
  'registrations',
  'guest_sessions_created',
  'token_reuse_detected',
  'security_events',

  // Phase D. `invite_resolve_failures` counts the one refusal the *caller* is
  // told nothing about (07 §5.2): revoked, expired, exhausted and unknown all
  // answer identically, so this counter and the `INVITE_ABUSE` rows are the
  // only place the difference between "a friend reloaded a dead link" and
  // "someone is spraying codes" is visible at all.
  'tables_created',
  'tables_closed',
  'seats_claimed',
  'seats_released',
  'invites_minted',
  'invites_revoked',
  'invites_resolved',
  'invite_resolve_failures',
  'invite_resolve_rate_limited',

  // Phase E. `wallet_credits_replayed` is the one worth watching: it counts
  // idempotency keys that collided, which is the mechanism working — a spike
  // means something upstream is retrying, and a *zero* forever probably means
  // the keys stopped being derived.
  'wallet_credits',
  'wallet_credits_replayed',
  'wallet_caps_rejected',
  'wallet_caps_partial',
  'guest_claims',
  'guest_claims_failed',
  'coins_vested',
  'coins_forfeited',

  // Phase F. Three of these answer questions nothing else can:
  //
  //   `socket_handshake_rejected` is the only visible trace of somebody trying
  //   cookies that do not work — a legitimate client retries at most twice.
  //
  //   `socket_identity_spoof_attempts` counts inbound payloads carrying a
  //   `userId`/`seat`/`playerId` field. It should sit at exactly zero forever:
  //   our own clients never send one, so any movement at all is either a
  //   probe or a bug we introduced, and both are worth a look.
  //
  //   `presence_grace_expired` is the population S33 will start ejecting. Its
  //   ratio to `reconnects` is the honest answer to "is the grace window long
  //   enough?", which is otherwise a guess.
  'socket_connections',
  'socket_handshake_rejected',
  'socket_identity_spoof_attempts',
  'socket_events_rejected',
  'socket_rate_limited',
  'socket_evicted_oldest',
  'table_joins',
  'presence_grace_expired',
  'chat_messages',
  'chat_emotes',
  'chat_rate_limited',
  'redis_degraded',
] as const

/** Point-in-time values that go up and down. */
export const GAUGES = ['active_sockets', 'active_games'] as const

export type CounterName = (typeof COUNTERS)[number]
export type GaugeName = (typeof GAUGES)[number]

export interface MetricsSnapshot {
  readonly counters: Record<CounterName, number>
  readonly gauges: Record<GaugeName, number>
  /** Seconds since the registry was created. Contextualises every counter. */
  readonly uptimeSec: number
}

export class MetricsRegistry {
  private readonly counters = new Map<CounterName, number>()
  private readonly gauges = new Map<GaugeName, number>()
  private readonly startedAt: number

  constructor(now: () => number = Date.now) {
    this.now = now
    this.startedAt = now()
  }

  private readonly now: () => number

  increment(name: CounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  /** Gauges move both ways — a socket closing is a `-1`, not a new series. */
  adjust(name: GaugeName, by: number): void {
    this.gauges.set(name, Math.max(0, (this.gauges.get(name) ?? 0) + by))
  }

  set(name: GaugeName, value: number): void {
    this.gauges.set(name, Math.max(0, value))
  }

  /**
   * Every name appears, including the ones at zero. A missing series reads as
   * "no data", and "no illegal moves today" is a very different statement.
   */
  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(
        COUNTERS.map((name) => [name, this.counters.get(name) ?? 0]),
      ) as Record<CounterName, number>,
      gauges: Object.fromEntries(
        GAUGES.map((name) => [name, this.gauges.get(name) ?? 0]),
      ) as Record<GaugeName, number>,
      uptimeSec: Math.floor((this.now() - this.startedAt) / 1000),
    }
  }

  reset(): void {
    this.counters.clear()
    this.gauges.clear()
  }
}
