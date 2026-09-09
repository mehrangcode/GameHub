import { describe, expect, it } from 'vitest'
import {
  COUNTERS,
  GAUGES,
  MetricsRegistry,
} from '../../src/application/services/MetricsRegistry.js'

describe('MetricsRegistry', () => {
  it('★ reports every series, including the ones at zero', () => {
    const snapshot = new MetricsRegistry().snapshot()

    // A missing series reads as "no data", and "no illegal moves today" is a
    // very different statement from "we stopped counting".
    expect(Object.keys(snapshot.counters).sort()).toEqual([...COUNTERS].sort())
    expect(Object.keys(snapshot.gauges).sort()).toEqual([...GAUGES].sort())
    expect(Object.values(snapshot.counters).every((value) => value === 0)).toBe(true)
  })

  it('counts up', () => {
    const metrics = new MetricsRegistry()
    metrics.increment('logins')
    metrics.increment('logins')
    metrics.increment('games_started', 3)

    const { counters } = metrics.snapshot()
    expect(counters.logins).toBe(2)
    expect(counters.games_started).toBe(3)
    expect(counters.logins_failed).toBe(0)
  })

  it('gauges move both ways and never go negative', () => {
    const metrics = new MetricsRegistry()
    metrics.adjust('active_sockets', 3)
    metrics.adjust('active_sockets', -1)
    expect(metrics.snapshot().gauges.active_sockets).toBe(2)

    // A double-counted disconnect must not produce -1 active sockets.
    metrics.adjust('active_sockets', -5)
    expect(metrics.snapshot().gauges.active_sockets).toBe(0)

    metrics.set('active_games', 7)
    expect(metrics.snapshot().gauges.active_games).toBe(7)
  })

  it('contextualises the counters with an uptime', () => {
    let clock = 1_000_000
    const metrics = new MetricsRegistry(() => clock)
    clock += 90_000

    expect(metrics.snapshot().uptimeSec).toBe(90)
  })

  it('resets', () => {
    const metrics = new MetricsRegistry()
    metrics.increment('reconnects', 4)
    metrics.reset()
    expect(metrics.snapshot().counters.reconnects).toBe(0)
  })

  it('takes a snapshot by value, not by reference', () => {
    const metrics = new MetricsRegistry()
    const before = metrics.snapshot()
    metrics.increment('ejections')

    expect(before.counters.ejections).toBe(0)
  })
})
