/**
 * Time, as a dependency — S25.
 *
 * Engines are forbidden a clock outright (invariant I1). Services are not: the
 * disconnect grace timer is a *service* concern precisely because it needs one.
 * But a service that reaches for the global `setTimeout` cannot be tested
 * without waiting, and a 90-second Shelem grace window is not something a test
 * suite can afford to sit through — so the timer comes in through the door.
 *
 * Vitest's fake timers were the obvious alternative and were rejected on
 * purpose: they replace the global for the whole file, including Prisma's
 * internals and Socket.IO's own ping loop, and the resulting failures read as
 * race conditions rather than as a stubbed clock. `tests/fakes/clock.ts` has
 * the hand-driven implementation.
 */

export interface TimerHandle {
  readonly id: symbol
}

export interface Clock {
  now(): number
  /** Must not keep the process alive — the real implementation `unref`s. */
  schedule(delayMs: number, fn: () => void): TimerHandle
  cancel(handle: TimerHandle): void
}

const handles = new Map<symbol, NodeJS.Timeout>()

export const systemClock: Clock = {
  now: () => Date.now(),

  schedule(delayMs, fn) {
    const id = Symbol('timer')
    const timeout = setTimeout(() => {
      // Dropped on fire as well as on cancel: a map that only ever grows is a
      // leak with a long fuse, and grace timers fire far more often than they
      // are cancelled.
      handles.delete(id)
      fn()
    }, delayMs)

    // A pending grace timer must never be the reason a shutdown hangs.
    timeout.unref?.()
    handles.set(id, timeout)
    return { id }
  },

  cancel(handle) {
    const timeout = handles.get(handle.id)
    if (timeout === undefined) return
    clearTimeout(timeout)
    handles.delete(handle.id)
  },
}
