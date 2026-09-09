import type { Clock, TimerHandle } from '../../src/application/ports/clock.js'

/**
 * A clock the test drives by hand — the fake behind `application/ports/clock.ts`.
 *
 * Vitest's `vi.useFakeTimers()` was the obvious alternative and is the wrong
 * tool here: it replaces the global for the whole file, including Prisma's
 * internals, `ioredis`'s retry timer and Socket.IO's own ping loop. The
 * resulting failures read as race conditions rather than as a stubbed clock,
 * and every one of them costs an hour.
 *
 * `advance` re-checks after each callback, so a timer scheduled *inside* an
 * expiring timer still fires within the same window — which is exactly what the
 * strike ladder (S32) will do, and what a naive "collect then run" loop would
 * silently drop.
 */
export class FakeClock implements Clock {
  private current: number
  private readonly pending = new Map<symbol, { at: number; fn: () => void }>()

  constructor(startAt = 1_700_000_000_000) {
    this.current = startAt
  }

  now(): number {
    return this.current
  }

  schedule(delayMs: number, fn: () => void): TimerHandle {
    const id = Symbol('fake-timer')
    this.pending.set(id, { at: this.current + delayMs, fn })
    return { id }
  }

  cancel(handle: TimerHandle): void {
    this.pending.delete(handle.id)
  }

  /** Timers still armed. Proves a cancel actually cancelled, rather than merely not firing. */
  get armed(): number {
    return this.pending.size
  }

  advance(ms: number): void {
    const target = this.current + ms

    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)

      const next = due[0]
      if (next === undefined) break

      const [id, timer] = next
      this.pending.delete(id)
      this.current = timer.at
      timer.fn()
    }

    this.current = target
  }
}
