import { expect } from 'vitest'
import {
  SPECTATOR,
  seatViewer,
  type AnyGameEngine,
  type Viewer,
} from '../../src/domain/games/GameEngine.js'
import { seatId, type SeatId } from '../../src/domain/value-objects/seat.js'

/**
 * ★ The generic leak-test harness — S30, and the second-highest-ROI test suite
 * in the project (the technical PRD's testing priorities, item 2).
 *
 * Written generically **here**, one milestone before the first real game, so
 * that M1 onward reuses it unchanged: adding Sudoku, Blackjack, Shelem, Poker
 * and Chess should each cost one call to {@link runLeakSuite} and no new
 * assertion logic. A per-game leak test written five times is a leak test
 * written well once and badly four times.
 *
 * ### What it actually checks, and why it is a string search
 *
 * A projection is asserted to contain **no trace** of another seat's hidden
 * information, by serializing it and searching the JSON for the secret's own
 * text. That is deliberately cruder than comparing object shapes, and it is
 * cruder in the direction that matters:
 *
 *   - It catches the leak wherever it hides — nested three levels down, inside
 *     a string, in a key rather than a value, in a debug field somebody added
 *     for one afternoon.
 *   - It cannot be satisfied by a `projectState` that deletes the obvious field
 *     and leaves a derived one. `deckCount: 52` is fine; `deck: [...]` is not,
 *     and neither is `nextCard` — the classic trap 02's architecture notes
 *     name, because it leaks the entire future of the game.
 *
 * This is exactly why `Card` is the two-character string type: I4 becomes
 * testable by substring assertion on a serialized projection.
 *
 * ### Using it for a real game
 *
 * ```ts
 * runLeakSuite({
 *   engine: shelemEngine,
 *   state,
 *   seats: [0, 1, 2, 3],
 *   secretsOf: (state, seat) => state.hands[seat],   // the cards only that seat may see
 * })
 * ```
 */

export interface LeakSuite<S> {
  readonly engine: AnyGameEngine
  readonly state: S
  readonly seats: readonly number[]
  /**
   * Everything `seat` may know and nobody else may. Returned as the exact
   * strings that would appear in a serialized payload — card codes, a hidden
   * number, a solution grid rendered the way the state holds it.
   */
  secretsOf(state: S, seat: SeatId): readonly (string | number)[]
  /** Label used in the test names; defaults to the engine's slug. */
  readonly label?: string
}

export function serializeProjection(engine: AnyGameEngine, state: unknown, viewer: Viewer): string {
  return JSON.stringify(engine.projectState(state, viewer))
}

/**
 * @throws via `expect` when any of `forbidden` appears anywhere in the viewer's
 * serialized projection.
 */
export function assertProjectionHides(
  engine: AnyGameEngine,
  state: unknown,
  viewer: Viewer,
  forbidden: readonly (string | number)[],
  because: string,
): void {
  const json = serializeProjection(engine, state, viewer)

  for (const secret of forbidden) {
    const needle = String(secret)
    expect(
      json.includes(needle),
      `${because}: '${needle}' appears in the projection for ${describe(viewer)} — ` +
        `projectState must strip it (I4, 04 §4.1)\n${json}`,
    ).toBe(false)
  }
}

export function assertProjectionShows(
  engine: AnyGameEngine,
  state: unknown,
  viewer: Viewer,
  expected: readonly (string | number)[],
  because: string,
): void {
  const json = serializeProjection(engine, state, viewer)

  for (const value of expected) {
    expect(
      json.includes(String(value)),
      `${because}: '${String(value)}' is missing from the projection for ${describe(viewer)} — ` +
        `a projection that hides the viewer's own information is unplayable\n${json}`,
    ).toBe(true)
  }
}

/**
 * The whole matrix: every seat against every other seat, plus the spectator.
 *
 * Returns the assertions rather than running them inside a `describe`, so the
 * caller owns the test names and a failure points at the game rather than at
 * this file.
 */
export function runLeakSuite<S>(suite: LeakSuite<S>): void {
  const { engine, state } = suite
  const seats = suite.seats.map((seat) => seatId(seat))
  const label = suite.label ?? engine.meta.slug

  for (const viewerSeat of seats) {
    const viewer = seatViewer(viewerSeat)
    const own = suite.secretsOf(state, viewerSeat)

    // A seat must see its own hand, or the game is unplayable — the failure
    // mode of an over-eager projection, and one a leak-only suite misses.
    const json = serializeProjection(engine, state, viewer)
    for (const secret of own) {
      expect(
        json.includes(String(secret)),
        `${label}: seat ${viewerSeat} cannot see its own '${String(secret)}'\n${json}`,
      ).toBe(true)
    }

    for (const otherSeat of seats) {
      if (otherSeat === viewerSeat) continue
      assertProjectionHides(
        engine,
        state,
        viewer,
        suite.secretsOf(state, otherSeat),
        `${label}: seat ${viewerSeat} sees seat ${otherSeat}'s hidden information`,
      )
    }
  }

  // ★ The spectator holds no seat, so it may hold no seat's secret. This is the
  // arm that catches "spectators get the omniscient view" — a shortcut that is
  // tempting precisely because spectators are not players.
  for (const seat of seats) {
    assertProjectionHides(
      engine,
      state,
      SPECTATOR,
      suite.secretsOf(state, seat),
      `${label}: a spectator sees seat ${seat}'s hidden information`,
    )
  }
}

/**
 * Two viewers of one state must receive **different** payloads.
 *
 * The single assertion that proves projection is per-viewer rather than
 * per-broadcast. An engine that returned the same object for every viewer would
 * pass every leak assertion above by hiding everything from everybody, and
 * would be useless — this is the other half of the pincer.
 */
export function assertProjectionsDiffer(
  engine: AnyGameEngine,
  state: unknown,
  a: Viewer,
  b: Viewer,
): void {
  expect(
    serializeProjection(engine, state, a),
    `${describe(a)} and ${describe(b)} received byte-identical projections — ` +
      'projectState is not per-viewer',
  ).not.toBe(serializeProjection(engine, state, b))
}

function describe(viewer: Viewer): string {
  return viewer.kind === 'seat' ? `seat ${viewer.seat}` : viewer.kind
}
