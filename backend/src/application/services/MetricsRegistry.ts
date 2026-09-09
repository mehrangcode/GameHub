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
