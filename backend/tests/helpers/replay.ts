import type { AnyGameEngine, GameConfig } from '../../src/domain/games/GameEngine.js'
import { DEAL_RNG_KEY, gameRng } from '../../src/domain/games/shared/rng.js'
import { seatId, type SeatId } from '../../src/domain/value-objects/seat.js'

/**
 * ★ `replayFixture(seed, moves)` — the test kit of S30, and the reason every
 * bug in a card game reduces to two values.
 *
 * Every engine takes an injected `Rng`, so a reported defect never has to stay
 * a story: `(seed, moves[])` reproduces the exact hand, and a "that scored
 * wrong" complaint becomes a regression test with a fixture file. This function
 * is what turns that promise into one call.
 *
 * ### It must key randomness exactly as the server does
 *
 * The one thing that would make this kit worse than useless is a replay that
 * diverges from production — you would then be debugging the replayer. So the
 * generator is derived with the *same* {@link gameRng} the service uses, keyed
 * by the same thing: the sequence number the input event took in the log.
 *
 * Here, that seq is simply `index + 1`, because a replay from an empty log
 * numbers its own events — and `GameSessionService` guarantees that is what the
 * live game did too (see the `inputSeq` assertion in `applyWithin`). If that
 * guarantee ever changes, this function changes with it, and both are one grep
 * from each other.
 */

export interface ReplayMove {
  readonly seat: number
  readonly move: unknown
}

export interface ReplayInput {
  readonly engine: AnyGameEngine
  readonly config: GameConfig
  readonly rngSeed: string
  readonly moves: readonly ReplayMove[]
}

export interface ReplayOutcome {
  readonly state: unknown
  /** Every event the engine emitted, in order — the log a real game would hold. */
  readonly events: readonly { kind: string; seat: SeatId | null }[]
  readonly seq: number
}

export function replayFixture(input: ReplayInput): ReplayOutcome {
  const { engine, config, rngSeed, moves } = input

  let state: unknown = engine.createInitialState(config, gameRng(rngSeed, DEAL_RNG_KEY))
  const events: { kind: string; seat: SeatId | null }[] = []
  let seq = 0

  for (const entry of moves) {
    const inputSeq = seq + 1
    const rng = gameRng(rngSeed, inputSeq)

    const applied = engine.applyMove(state, seatId(entry.seat), entry.move, rng)
    state = applied.state
    events.push(...applied.events.map((event) => ({ kind: event.kind, seat: event.seat })))

    // The same bounded advance loop the service runs, sharing the same
    // generator instance — which is what keeps the draw order identical.
    for (let step = 0; step < 1_000; step += 1) {
      const next = engine.advance?.(state, rng) ?? null
      if (next === null) break
      state = next.state
      events.push(...next.events.map((event) => ({ kind: event.kind, seat: event.seat })))
    }

    seq = events.length
  }

  return { state, events, seq }
}

/** The assertion that gives the kit its value: two runs, byte-identical. */
export function replayTwice(input: ReplayInput): { first: string; second: string } {
  return {
    first: JSON.stringify(replayFixture(input).state),
    second: JSON.stringify(replayFixture(input).state),
  }
}
