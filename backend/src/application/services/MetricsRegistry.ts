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

  // Phase G. Three of these are the ones worth watching:
  //
  //   `moves_replayed` counts `clientMoveId`s that collided — the database
  //   refusing to play a card twice. Like `wallet_credits_replayed`, a spike
  //   means something upstream is retrying and a permanent zero probably means
  //   the client stopped sending stable keys.
  //
  //   `game_rebuilds` against `moves_applied` is roughly 1:1 by design, because
  //   state is never held in memory. If it ever drifts far above that, some
  //   path is rebuilding for a read it could have taken from the broadcast.
  //
  //   `game_states_projected` divided by `moves_applied` is the table's average
  //   viewer count — and, more usefully, it is *supposed* to be a multiple: a
  //   value equal to `moves_applied` would mean one payload per move, which is
  //   the broadcast-the-state bug this architecture exists to make impossible.
  'game_rebuilds',
  'moves_replayed',
  'game_snapshots_written',
  'game_states_projected',
  'game_resyncs_full',
  'game_resyncs_delta',
  'game_snapshots_pruned',

  // Phase H — turn enforcement. Four of these are worth reading together:
  //
  //   `turn_warnings_sent` against `turn_timeouts` is how well the warning
  //   works. A warning that almost never converts into a timeout is doing its
  //   job; one that always does means players are not seeing it.
  //
  //   `ejections` (declared above, since Phase C, and finally incremented
  //   here) against `seats_reclaimed` is the incentive design of 04 §6.4
  //   measured directly — half reward for coming back is supposed to make
  //   reclaiming the common case.
  //
  //   `turn_timers_rearmed` is only ever incremented at boot, so a non-zero
  //   value on a long-running process means something restarted the sweep.
  'turn_timers_armed',
  'turn_warnings_sent',
  'turn_timeouts',
  'turn_timers_rearmed',
  'bot_moves_applied',
  'seats_reclaimed',
  'seats_abandoned',
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
