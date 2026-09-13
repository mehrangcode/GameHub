import type { SeatId } from '../../domain/value-objects/seat.js'

/**
 * ★ "The state moved on" — the one seam Phase H hangs off, S31.
 *
 * ### Why a port rather than a call
 *
 * `GameSessionService` must not know that turn timers exist. The dependency
 * genuinely runs the other way: the timer service applies a timed-out player's
 * default action *through* `applyMove`, and a bot-held seat plays *through*
 * `applyMove`, so a direct reference in both directions would be a cycle — and
 * the wrong cycle, because it would put "eject the player" inside the file that
 * owns the event log.
 *
 * So the log service announces, and whoever cares listens. One line at the end
 * of `broadcastState` covers every path that can change whose turn it is: the
 * deal, a human move, a timeout's default action, and a bot's move. There is
 * deliberately no second place to remember to re-arm a timer.
 *
 * ### Why it is synchronous and cannot throw
 *
 * An observer runs after a move has already committed to the log. Making the
 * move's success depend on the timer being armed would mean a Redis hiccup
 * could undo a played card; {@link MutableTurnObserver} therefore swallows and
 * logs, exactly like the grace-expiry hook in `PresenceService`.
 */
export interface TurnContext {
  readonly gameId: string
  readonly tableId: string
  readonly gameSlug: string
  /** Whose turn it now is, or `null` — nobody's, or a game that names no turn. */
  readonly seat: SeatId | null
  readonly phase: string | null
  /** The newest `seq` applied. Distinguishes a genuine turn change from a re-broadcast. */
  readonly seq: number
  readonly terminal: boolean
  /**
   * Who just moved, and whether a human did it. `null` for the deal.
   *
   * ★ `by` is what makes `strikesResetOnAction` implementable without putting
   * policy in the log service: a **human** move clears the seat's strike count,
   * a timeout's default action obviously does not (it *is* the strike), and a
   * bot's move is not the ejected player coming back. Deriving this from the
   * state afterwards is impossible — by then the three look identical.
   */
  readonly acted: { readonly seat: SeatId; readonly by: 'human' | 'timeout' | 'bot' } | null
}

export interface TurnObserver {
  onTurn(context: TurnContext): void | Promise<void>
}

/**
 * The payload key that marks a `PHASE` row as a persisted turn deadline.
 *
 * Lives in the port rather than in `TurnTimerService` because both sides of the
 * seam need it and neither should import the other: the timer service *writes*
 * these rows, and the log service *skips* them when replaying narration to a
 * reconnecting client, which would otherwise see one "phase changed" line per
 * turn of the whole match.
 */
export const TIMER_EVENT_MARKER = 'turnTimer'

/** Whether a logged event is a persisted turn deadline rather than real narration. */
export function isTimerEvent(payload: Record<string, unknown>): boolean {
  return Object.hasOwn(payload, TIMER_EVENT_MARKER)
}

/**
 * Fan-out with late binding — the same shape as `MutableRealtimePublisher`, and
 * for the same reason: the container builds the log service before the services
 * that observe it, and one of the three has to be attached afterwards.
 *
 * An observer list that starts empty is also the correct configuration for
 * every unit test of the move pipeline, which has no interest in timers.
 */
export class MutableTurnObserver implements TurnObserver {
  private readonly observers: TurnObserver[] = []

  constructor(private readonly onError?: (error: unknown) => void) {}

  attach(observer: TurnObserver): void {
    this.observers.push(observer)
  }

  detachAll(): void {
    this.observers.length = 0
  }

  /**
   * ★ Awaited by the caller, and that is the fix for a real bug.
   *
   * Fire-and-forget was the first design and was wrong: the timer's `PHASE`
   * append then ran *concurrently* with the next move's transaction, and the
   * two raced for the same `seq`. The retry loop in the event repository
   * absorbed it, so the symptom was not corruption but noise — a wall of
   * `Unique constraint failed on (gameId, seq)` lines under load, and a log
   * whose ordering depended on which write won.
   *
   * Awaiting costs one sequential write before a move's ack returns and makes
   * the order deterministic: the move's events, then the deadline that follows
   * from them. Failures are still swallowed below, so a timer that cannot be
   * armed still cannot undo a card that has already been played.
   */
  async onTurn(context: TurnContext): Promise<void> {
    await this.run(context)
  }

  /**
   * ★ Sequential, and the order of attachment is load-bearing.
   *
   * `SeatEnforcementService` is attached first because it clears the acting
   * seat's strike count (`strikesResetOnAction`), and `TurnTimerService` reads
   * that same count to put `strikes` on the deadline it broadcasts. Run
   * concurrently, the countdown would sometimes show the strike the player just
   * cleared — a cosmetic bug in the one place a player is most likely to be
   * looking, and an unreproducible one.
   */
  private async run(context: TurnContext): Promise<void> {
    for (const observer of this.observers) {
      try {
        await observer.onTurn(context)
      } catch (error) {
        // One bad observer must not stop the others, and must never fail the
        // move that has already been written to the log.
        this.onError?.(error)
      }
    }
  }
}
