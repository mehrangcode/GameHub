import { describe, expect, it } from 'vitest'
import {
  OMNISCIENT,
  SPECTATOR,
  seatViewer,
  type GameConfig,
} from '../../../src/domain/games/GameEngine.js'
import { IllegalMoveError, NotYourTurnError } from '../../../src/domain/errors/errors.js'
import {
  fixtureEngine,
  type FixtureMove,
  type FixtureState,
  type FixtureView,
} from '../../../src/domain/games/_fixture/engine.js'
import { fixtureMeta } from '../../../src/domain/games/_fixture/meta.js'
import { DEAL_RNG_KEY, createSeededRng, gameRng } from '../../../src/domain/games/shared/rng.js'
import { seatId } from '../../../src/domain/value-objects/seat.js'
import { assertProjectionsDiffer, runLeakSuite, serializeProjection } from '../../helpers/leak.js'
import { replayFixture, replayTwice } from '../../helpers/replay.js'

/**
 * ★ The five invariants of 05 §2, on the first engine that implements them.
 *
 * These tests are the template every real engine's suite is copied from, which
 * is why each invariant gets its own named `describe` rather than being folded
 * into a behaviour test. When Sudoku's suite is written at M1, the five
 * headings below should appear in it verbatim.
 */

const SEED = 'phase-g-fixture-seed'

function config(seats: number[] = [0, 1, 2], target = 3): GameConfig {
  return {
    seats: seats.map((seat) => seatId(seat)),
    options: { target, strikesResetOnAction: true },
  }
}

function deal(seats: number[] = [0, 1, 2], target = 3): FixtureState {
  return fixtureEngine.createInitialState(config(seats, target), gameRng(SEED, DEAL_RNG_KEY))
}

const press: FixtureMove = { kind: 'press' }
const pass: FixtureMove = { kind: 'pass' }

function play(state: FixtureState, seat: number, move: FixtureMove, key = 1): FixtureState {
  return fixtureEngine.applyMove(state, seatId(seat), move, gameRng(SEED, key)).state
}

// ═══════════════════════════════════════════════════════════════════════════
// I1 — pure and deterministic
// ═══════════════════════════════════════════════════════════════════════════

describe('I1 — pure & deterministic', () => {
  it('★ the same seed deals the same game, twice', () => {
    expect(JSON.stringify(deal())).toBe(JSON.stringify(deal()))
  })

  it('different seeds deal different secrets', () => {
    const a = fixtureEngine.createInitialState(config(), gameRng('seed-a', DEAL_RNG_KEY))
    const b = fixtureEngine.createInitialState(config(), gameRng('seed-b', DEAL_RNG_KEY))

    expect(a.secrets).not.toEqual(b.secrets)
  })

  it('deals a distinct secret to every seat, so a leak cannot pass by coincidence', () => {
    const state = deal([0, 1, 2, 3])
    const values = Object.values(state.secrets)

    expect(new Set(values).size).toBe(values.length)
  })

  it('reads no ambient clock or randomness — proven by the source, not by hope', async () => {
    // The ESLint guard already bans `Math.random` under `src/domain/`. This adds
    // the other half: an engine that read `Date.now()` would be deterministic
    // under a seeded rng right up until midnight.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/domain/games/_fixture/engine.ts', 'utf8')

    expect(source).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// I2 — immutable
// ═══════════════════════════════════════════════════════════════════════════

describe('I2 — immutable', () => {
  it('★ applyMove does not mutate its input state', () => {
    const state = deal()
    const before = JSON.stringify(state)

    fixtureEngine.applyMove(state, seatId(0), press, gameRng(SEED, 1))

    expect(JSON.stringify(state)).toBe(before)
  })

  it('survives a deeply frozen input — the strongest form of the check', () => {
    const state = deepFreeze(deal())

    // A frozen input turns "did not mutate" from an assertion into a type of
    // exception: any write at all throws in strict mode, including one buried
    // in a nested record that a JSON comparison of the top level would miss.
    expect(() => fixtureEngine.applyMove(state, seatId(0), press, gameRng(SEED, 1))).not.toThrow()
    expect(() => fixtureEngine.advance?.(state, gameRng(SEED, 1))).not.toThrow()
    expect(() => fixtureEngine.projectState(state, seatViewer(seatId(0)))).not.toThrow()
  })

  it('returns a new counts record rather than the old one', () => {
    const state = deal()
    const next = play(state, 0, press)

    expect(next.counts).not.toBe(state.counts)
    expect(next.secrets).toEqual(state.secrets)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// I3 — totally legal
// ═══════════════════════════════════════════════════════════════════════════

describe('I3 — totally legal', () => {
  it('legalMoves is empty for every seat but the one to act', () => {
    const state = deal()

    expect(fixtureEngine.legalMoves(state, seatId(0))).toHaveLength(2)
    expect(fixtureEngine.legalMoves(state, seatId(1))).toEqual([])
    expect(fixtureEngine.legalMoves(state, seatId(2))).toEqual([])
  })

  it('★ every move outside legalMoves throws — applyMove is the enforcement point', () => {
    const state = deal()

    // Not the caller's turn.
    expect(() => play(state, 1, press)).toThrow(NotYourTurnError)
    // A seat that is not in the game at all.
    expect(() => play(state, 7, press)).toThrow(IllegalMoveError)
    // A move shape the grammar does not contain.
    expect(() => play(state, 0, { kind: 'detonate' } as unknown as FixtureMove)).toThrow(
      IllegalMoveError,
    )
  })

  it('refuses every move once the game is over', () => {
    let state = deal([0, 1], 1)
    state = play(state, 0, press)
    state = fixtureEngine.advance?.(state, gameRng(SEED, 1))?.state as FixtureState

    expect(state.phase).toBe('FINISHED')
    expect(fixtureEngine.legalMoves(state, seatId(1))).toEqual([])
    expect(() => play(state, 1, press)).toThrow(IllegalMoveError)
  })

  it('★ advance() terminates — it returns null on the second call', () => {
    let state = deal([0, 1], 1)
    state = play(state, 0, press)

    const first = fixtureEngine.advance?.(state, gameRng(SEED, 1))
    expect(first).not.toBeNull()

    const second = fixtureEngine.advance?.(first?.state as FixtureState, gameRng(SEED, 1))
    // A non-terminating advance hangs a request rather than failing it, which
    // is the difference between a stack trace and an outage.
    expect(second).toBeNull()
  })

  it('advance() does nothing while the game is merely in progress', () => {
    const state = play(deal(), 0, press)
    expect(fixtureEngine.advance?.(state, gameRng(SEED, 1))).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// I4 — projection-complete (the anti-cheat boundary)
// ═══════════════════════════════════════════════════════════════════════════

describe('I4 — projection-complete', () => {
  const state = deal([0, 1, 2, 3])

  it('★ the leak suite: no seat, and no spectator, sees another seat’s secret', () => {
    runLeakSuite({
      engine: fixtureEngine,
      state,
      seats: [0, 1, 2, 3],
      secretsOf: (current, seat) => [current.secrets[String(seat)] ?? 0],
    })
  })

  it('★ two viewers of one state receive different payloads', () => {
    // The other half of the pincer: an engine that hid everything from
    // everybody would pass every leak assertion and be unplayable.
    assertProjectionsDiffer(fixtureEngine, state, seatViewer(seatId(0)), seatViewer(seatId(1)))
    assertProjectionsDiffer(fixtureEngine, state, seatViewer(seatId(0)), SPECTATOR)
  })

  it('a seat sees its own secret and exactly one secret', () => {
    const view = fixtureEngine.projectState(state, seatViewer(seatId(2))) as FixtureView

    expect(view.secret).toBe(state.secrets['2'])
    expect(Object.keys(view)).not.toContain('secrets')
  })

  it('a spectator sees the public game and no secret at all', () => {
    const view = fixtureEngine.projectState(state, SPECTATOR) as FixtureView

    expect(view.secret).toBeNull()
    expect(view.toAct).toBe(0)
    expect(view.counts).toEqual({ '0': 0, '1': 0, '2': 0, '3': 0 })
  })

  it('omniscient sees everything — and is server-internal, never a room', () => {
    const json = serializeProjection(fixtureEngine, state, OMNISCIENT)

    for (const secret of Object.values(state.secrets)) {
      expect(json).toContain(String(secret))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// I5 — serializable
// ═══════════════════════════════════════════════════════════════════════════

describe('I5 — serializable', () => {
  it('★ state round-trips through JSON unchanged', () => {
    let state = deal([0, 1, 2, 3])
    state = play(state, 0, press)
    state = play(state, 1, pass, 2)

    const round = JSON.parse(JSON.stringify(state)) as FixtureState
    expect(round).toEqual(state)
  })

  it('holds no Set, Map, Date or class instance anywhere', () => {
    // The invariant stated as a property of the value rather than of the type,
    // because the type is what a future edit changes without noticing.
    walk(deal([0, 1, 2, 3]), (value, path) => {
      expect(value instanceof Set, `${path} is a Set`).toBe(false)
      expect(value instanceof Map, `${path} is a Map`).toBe(false)
      expect(value instanceof Date, `${path} is a Date`).toBe(false)
    })
  })

  it('a JSON round-trip of the state still plays', () => {
    // ★ This is what a snapshot actually is: `rebuildState` resumes from parsed
    // JSON, so an engine that needed its own class instances back would work
    // perfectly until the twenty-fifth event.
    const state = JSON.parse(JSON.stringify(deal())) as FixtureState
    const next = play(state, 0, press)

    expect(next.counts['0']).toBe(1)
    expect(next.toAct).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Behaviour, the meta, and the replay kit
// ═══════════════════════════════════════════════════════════════════════════

describe('the game itself', () => {
  it('rotates the turn and counts presses', () => {
    let state = deal([0, 1, 2])
    state = play(state, 0, press)
    expect(state.toAct).toBe(1)
    state = play(state, 1, pass, 2)
    expect(state.toAct).toBe(2)
    expect(state.counts).toEqual({ '0': 1, '1': 0, '2': 0 })
  })

  it('reaching the target finishes the game and names a winner', () => {
    const outcome = replayFixture({
      engine: fixtureEngine,
      config: config([0, 1], 2),
      rngSeed: SEED,
      moves: [
        { seat: 0, move: press },
        { seat: 1, move: press },
        { seat: 0, move: press },
      ],
    })

    const state = outcome.state as FixtureState
    expect(state.phase).toBe('FINISHED')
    expect(state.winner).toBe(0)
    expect(fixtureEngine.isTerminal(state)).toBe(true)
    expect(outcome.events.map((event) => event.kind)).toEqual(['MOVE', 'MOVE', 'MOVE', 'PHASE'])
  })

  it('result() reports a per-seat standing, and refuses a live state', () => {
    expect(() => fixtureEngine.result(deal())).toThrow(IllegalMoveError)

    const state = replayFixture({
      engine: fixtureEngine,
      config: config([0, 1], 1),
      rngSeed: SEED,
      moves: [{ seat: 0, move: press }],
    }).state as FixtureState

    const result = fixtureEngine.result(state)
    expect(result.reason).toBe('NORMAL')
    expect(result.standings).toEqual([
      { seat: 0, rank: 1, score: 1, outcome: 'COMPLETED', playedFraction: 1 },
      { seat: 1, rank: 2, score: 0, outcome: 'COMPLETED', playedFraction: 1 },
    ])
  })

  it('the bot presses, so a substituted seat keeps the table moving', () => {
    const state = deal()
    const legal = fixtureEngine.legalMoves(state, seatId(0))

    expect(fixtureEngine.bot?.chooseMove(state, seatId(0), legal, createSeededRng('b'))).toEqual(
      press,
    )
  })

  it('★ the timeout default passes — it never spends what the player did not', () => {
    const state = deal()

    // 04 §6.5: a strike costs the turn and nothing else. A default that
    // *pressed* would let an idle player win by walking away.
    expect(fixtureMeta.defaultActionOnTimeout(state, seatId(0))).toEqual(pass)
    // …and only for the seat that is actually to act.
    expect(fixtureMeta.defaultActionOnTimeout(state, seatId(1))).toBeNull()
  })

  it('describeMove is an i18n key with params, never a sentence', () => {
    const described = fixtureEngine.describeMove(deal(), seatId(0), press)

    expect(described.key).toBe('games.fixture.move.press')
    expect(described.key).not.toMatch(/\s/)
    expect(described.params).toEqual({ seat: 0 })
  })
})

describe('★ replayFixture is byte-identical across two runs', () => {
  it('same seed, same moves, same state', () => {
    const input = {
      engine: fixtureEngine,
      config: config([0, 1, 2, 3], 4),
      rngSeed: SEED,
      moves: [
        { seat: 0, move: press },
        { seat: 1, move: pass },
        { seat: 2, move: press },
        { seat: 3, move: press },
        { seat: 0, move: press },
      ],
    }

    const { first, second } = replayTwice(input)
    expect(first).toBe(second)
    // And it is not vacuously identical — the game actually moved.
    expect(JSON.parse(first)).toMatchObject({ turn: 5 })
  })

  it('a different seed produces a different game from the same moves', () => {
    const moves = [{ seat: 0, move: press }]
    const a = replayFixture({ engine: fixtureEngine, config: config(), rngSeed: 'a', moves })
    const b = replayFixture({ engine: fixtureEngine, config: config(), rngSeed: 'b', moves })

    expect(JSON.stringify(a.state)).not.toBe(JSON.stringify(b.state))
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

function walk(value: unknown, visit: (value: unknown, path: string) => void, path = '$'): void {
  visit(value, path)
  if (typeof value !== 'object' || value === null) return
  for (const [key, entry] of Object.entries(value)) walk(entry, visit, `${path}.${key}`)
}
