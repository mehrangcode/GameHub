import { describe, expect, it } from 'vitest'
import {
  OMNISCIENT,
  SPECTATOR,
  seatViewer,
  type GameConfig,
} from '../../../src/domain/games/GameEngine.js'
import { IllegalMoveError } from '../../../src/domain/errors/errors.js'
import {
  sudokuEngine,
  type SudokuMove,
  type SudokuOmniscientView,
  type SudokuState,
  type SudokuView,
} from '../../../src/domain/games/sudoku/engine.js'
import { sudokuMeta } from '../../../src/domain/games/sudoku/meta.js'
import { CELLS, isGiven, parseGrid } from '../../../src/domain/games/sudoku/grid.js'
import { countSolutions, grade, nextHint } from '../../../src/domain/games/sudoku/solver.js'
import { generate } from '../../../src/domain/games/sudoku/generator.js'
import { DEAL_RNG_KEY, createSeededRng, gameRng } from '../../../src/domain/games/shared/rng.js'
import { seatId } from '../../../src/domain/value-objects/seat.js'
import { assertProjectionsDiffer, runLeakSuite, serializeProjection } from '../../helpers/leak.js'
import { replayTwice } from '../../helpers/replay.js'

/**
 * ★ Sudoku — `games/sudoku.md` §10, and the five invariants of 05 §2.
 *
 * The headings mirror `fixture-engine.test.ts` verbatim, as that file asks. The
 * one that carries the most weight here is I4: Sudoku's `solution` is the first
 * piece of genuinely valuable hidden information on the platform, and shipping
 * it to a client would be invisible in every functional test while making the
 * entire game pointless.
 */

const SEED = 'm1-sudoku-seed'

function config(seats: number[] = [0], options: Record<string, unknown> = {}): GameConfig {
  return {
    seats: seats.map((seat) => seatId(seat)),
    options: sudokuMeta.optionsSchema.parse(options) as Record<string, unknown>,
  }
}

function deal(seats: number[] = [0], options: Record<string, unknown> = {}): SudokuState {
  return sudokuEngine.createInitialState(config(seats, options), gameRng(SEED, DEAL_RNG_KEY))
}

const rng = gameRng(SEED, 1)

function apply(state: SudokuState, seat: number, move: SudokuMove): SudokuState {
  return sudokuEngine.applyMove(state, seatId(seat), move, rng).state
}

/** Fill every non-given cell of a seat's grid from `source`. */
function fillFrom(state: SudokuState, seat: number, source: string): SudokuState {
  let next = state
  for (let index = 0; index < CELLS; index++) {
    if (isGiven(state.puzzle, index)) continue
    next = apply(next, seat, { type: 'SET_CELL', index, value: Number(source[index]) })
  }
  return next
}

function seatView(state: SudokuState, seat: number): SudokuView {
  return sudokuEngine.projectState(state, seatViewer(seatId(seat))) as SudokuView
}

describe('sudoku · generation', () => {
  it('produces a puzzle with exactly one solution', () => {
    for (const difficulty of ['easy', 'medium', 'hard', 'expert'] as const) {
      for (let i = 0; i < 6; i++) {
        const puzzle = generate(createSeededRng(`gen-${difficulty}-${i}`), difficulty)
        expect(countSolutions(parseGrid(puzzle.puzzle), 2), `${difficulty} #${i}`).toBe(1)
      }
    }
  })

  it('grades ≥90% of puzzles into the requested band (§10 case 4)', () => {
    for (const difficulty of ['easy', 'medium', 'hard', 'expert'] as const) {
      const results = Array.from({ length: 10 }, (_u, i) =>
        generate(createSeededRng(`band-${difficulty}-${i}`), difficulty),
      )
      const exact = results.filter((r) => r.graded === difficulty).length
      expect(exact, `${difficulty}: ${results.map((r) => r.graded).join(',')}`).toBeGreaterThanOrEqual(9)
    }
  })

  it('never digs below the absolute floor or above the easy ceiling (§10 case 3)', () => {
    for (const difficulty of ['easy', 'medium', 'hard', 'expert'] as const) {
      const { givens } = generate(createSeededRng(`givens-${difficulty}`), difficulty)
      expect(givens).toBeGreaterThanOrEqual(20)
      expect(givens).toBeLessThanOrEqual(41)
    }
  })

  it('a puzzle never requires a technique above its band', () => {
    // An "easy" puzzle that needs an X-wing would make the difficulty label a
    // lie, which is worse than a puzzle that is easier than advertised.
    const easy = generate(createSeededRng('ceiling'), 'easy')
    expect(grade(easy.puzzle)?.difficulty).toBe('easy')
  })

  it('every implemented technique fires on a fixture (§10 case 4a)', () => {
    // A technique that never fires silently degrades grading to `guess`, and
    // nothing else in the suite would notice.
    const xwing = '100000569492056108056109240009640801064010000218035604040500016905061402621000005'
    const scored = grade(xwing)
    expect(scored?.hardest).toBe('xWing')
    expect(scored?.used).toEqual(
      expect.arrayContaining(['nakedSingle', 'hiddenSingle', 'pointingPair', 'xWing']),
    )
  })
})

describe('sudoku · I1 pure & deterministic', () => {
  it('the same seed yields the same puzzle', () => {
    expect(deal().puzzle).toBe(deal().puzzle)
    expect(deal().solution).toBe(deal().solution)
  })

  it('a replay produces byte-identical state twice (§10 case 2)', () => {
    const moves = [
      { seat: 0, move: { type: 'CHECK' } },
      { seat: 0, move: { type: 'HINT', funding: 'FREE' } },
      { seat: 0, move: { type: 'CHECK' } },
    ]
    const { first, second } = replayTwice({
      engine: sudokuEngine,
      config: config(),
      rngSeed: SEED,
      moves,
    })
    expect(first).toBe(second)
  })

  it('different seeds yield different puzzles', () => {
    const a = sudokuEngine.createInitialState(config(), gameRng('seed-a', DEAL_RNG_KEY))
    const b = sudokuEngine.createInitialState(config(), gameRng('seed-b', DEAL_RNG_KEY))
    expect(a.puzzle).not.toBe(b.puzzle)
  })
})

describe('sudoku · I2 immutable', () => {
  it('a frozen state is not mutated by applyMove (§10 case 15)', () => {
    const state = deal()
    const frozen = Object.freeze(state)
    const index = state.puzzle.indexOf('0')

    expect(() => apply(frozen, 0, { type: 'SET_CELL', index, value: 5 })).not.toThrow()
    expect(state.players['0']?.grid).toBe(state.puzzle)
  })
})

describe('sudoku · I3 totally legal', () => {
  it('rejects SET_CELL on a given (§10 case 5)', () => {
    const state = deal()
    const given = parseGrid(state.puzzle).findIndex((d) => d !== 0)
    expect(() => apply(state, 0, { type: 'SET_CELL', index: given, value: 1 })).toThrow(
      IllegalMoveError,
    )
  })

  it('★ accepts SET_CELL with a wrong value (§10 case 6)', () => {
    // The deliberate asymmetry of §3: blocking a wrong entry would do the
    // player's deduction for them.
    const state = deal()
    const index = state.puzzle.indexOf('0')
    const correct = Number(state.solution[index])
    const wrong = correct === 9 ? 1 : correct + 1

    const next = apply(state, 0, { type: 'SET_CELL', index, value: wrong })
    expect(next.players['0']?.grid[index]).toBe(String(wrong))
    // ...and no flag until CHECK or completion.
    expect(next.players['0']?.flagged).toEqual({})
  })

  it('rejects an unknown move shape', () => {
    const state = deal()
    expect(() => apply(state, 0, { type: 'NOPE' } as unknown as SudokuMove)).toThrow(
      IllegalMoveError,
    )
    expect(() =>
      apply(state, 0, { type: 'SET_CELL', index: 99, value: 5 } as SudokuMove),
    ).toThrow(IllegalMoveError)
    expect(() =>
      apply(state, 0, { type: 'SET_CELL', index: 0, value: 0 } as SudokuMove),
    ).toThrow(IllegalMoveError)
  })

  it('rejects CLEAR_CELL on an empty cell and on a given', () => {
    const state = deal()
    const empty = state.puzzle.indexOf('0')
    const given = parseGrid(state.puzzle).findIndex((d) => d !== 0)
    expect(() => apply(state, 0, { type: 'CLEAR_CELL', index: empty })).toThrow(IllegalMoveError)
    expect(() => apply(state, 0, { type: 'CLEAR_CELL', index: given })).toThrow(IllegalMoveError)
  })

  it('rejects SET_NOTES on a filled cell', () => {
    const state = deal()
    const index = state.puzzle.indexOf('0')
    const filled = apply(state, 0, { type: 'SET_CELL', index, value: 5 })
    expect(() => apply(filled, 0, { type: 'SET_NOTES', index, digits: [1, 2] })).toThrow(
      IllegalMoveError,
    )
  })

  it('every enumerated legal move applies without throwing', () => {
    const state = deal()
    const legal = sudokuEngine.legalMoves(state, seatId(0))
    expect(legal.length).toBeGreaterThan(0)
    for (const move of legal) {
      expect(() => apply(state, 0, move), JSON.stringify(move)).not.toThrow()
    }
  })

  it('no move is legal once the game is over', () => {
    const state = fillFrom(deal(), 0, deal().solution)
    expect(state.phase).toBe('SOLVED')
    expect(sudokuEngine.legalMoves(state, seatId(0))).toEqual([])
    expect(() => apply(state, 0, { type: 'CHECK' })).toThrow(IllegalMoveError)
  })
})

describe('sudoku · I4 projection-complete', () => {
  it('★ the solution appears in no seat projection (§10 case 11)', () => {
    const state = deal([0, 1], { mode: 'race' })
    for (const seat of [0, 1]) {
      const json = serializeProjection(sudokuEngine, state, seatViewer(seatId(seat)))
      expect(json).not.toContain(state.solution)
    }
  })

  it('★ the solution appears in no spectator projection (§10 case 12)', () => {
    const state = deal([0, 1], { mode: 'race' })
    expect(serializeProjection(sudokuEngine, state, SPECTATOR)).not.toContain(state.solution)
  })

  it('★ an opponent’s grid never leaves in race mode (§10 case 13)', () => {
    let state = deal([0, 1], { mode: 'race' })
    // Give seat 1 a distinctive grid, then look for it in seat 0's payload.
    const index = state.puzzle.indexOf('0')
    state = apply(state, 1, { type: 'SET_CELL', index, value: Number(state.solution[index]) })

    const opponentGrid = state.players['1']?.grid as string
    const json = serializeProjection(sudokuEngine, state, seatViewer(seatId(0)))
    expect(json).not.toContain(opponentGrid)

    const view = seatView(state, 0)
    expect(view.others['1']).toEqual({
      filled: state.players['1']?.filled,
      mistakes: 0,
      hintsUsed: 0,
      solvedOrder: null,
      gaveUp: false,
    })
  })

  it('the leak matrix holds for every seat and the spectator', () => {
    // Every seat starts with a grid identical to the puzzle, which would make
    // "seat 0 must not see seat 1's grid" vacuous — the strings match, so the
    // assertion would pass on an engine that broadcast everything. Give each
    // seat a distinct entry first, so the probe can actually tell them apart.
    let state = deal([0, 1, 2], { mode: 'race' })
    const empties = parseGrid(state.puzzle)
      .map((d, i) => (d === 0 ? i : -1))
      .filter((i) => i >= 0)

    for (const seat of [0, 1, 2]) {
      state = apply(state, seat, {
        type: 'SET_CELL',
        index: empties[seat] as number,
        value: seat + 1,
      })
    }

    runLeakSuite({
      engine: sudokuEngine,
      state,
      seats: [0, 1, 2],
      // A seat's own board is the thing it must see and the others must not.
      // The solution is nobody's to see, so it is probed separately above
      // rather than handed to a harness whose first assertion is "the owner
      // can read this".
      secretsOf: (s: SudokuState, seat) => [s.players[String(seat)]?.grid ?? ''],
    })
  })

  it('two seats receive different payloads', () => {
    let state = deal([0, 1], { mode: 'race' })
    const index = state.puzzle.indexOf('0')
    state = apply(state, 0, { type: 'SET_CELL', index, value: 5 })
    assertProjectionsDiffer(
      sudokuEngine,
      state,
      seatViewer(seatId(0)),
      seatViewer(seatId(1)),
    )
  })

  it('a spectator sees progress but holds no board', () => {
    const state = deal([0, 1], { mode: 'race' })
    const view = sudokuEngine.projectState(state, SPECTATOR) as SudokuView
    expect(view.me).toBeNull()
    expect(Object.keys(view.others).sort()).toEqual(['0', '1'])
  })

  it('only the omniscient viewer sees the solution', () => {
    const state = deal()
    const view = sudokuEngine.projectState(state, OMNISCIENT) as SudokuOmniscientView
    expect(view.solution).toBe(state.solution)
  })

  it('flagged says which cells are wrong, never what belongs there', () => {
    let state = deal()
    const index = state.puzzle.indexOf('0')
    const correct = Number(state.solution[index])
    const wrong = correct === 9 ? 1 : correct + 1

    state = apply(state, 0, { type: 'SET_CELL', index, value: wrong })
    state = apply(state, 0, { type: 'CHECK' })

    const view = seatView(state, 0)
    expect(view.me?.flagged).toEqual({ [String(index)]: true })
    // The flag marks the cell; the right digit is not anywhere in the payload's
    // answer to "what is wrong here".
    expect(view.me?.grid[index]).toBe(String(wrong))
  })
})

describe('sudoku · I5 serializable', () => {
  it('state round-trips through JSON unchanged (§10 case 14)', () => {
    let state = deal([0, 1], { mode: 'race' })
    const index = state.puzzle.indexOf('0')
    state = apply(state, 0, { type: 'SET_CELL', index, value: 4 })
    state = apply(state, 1, { type: 'SET_NOTES', index, digits: [3, 1, 2] })
    state = apply(state, 0, { type: 'CHECK' })

    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  it('holds no Set, Map, Date or class instance', () => {
    const state = deal()
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return
      expect(value instanceof Set, `${path} is a Set`).toBe(false)
      expect(value instanceof Map, `${path} is a Map`).toBe(false)
      expect(value instanceof Date, `${path} is a Date`).toBe(false)
      const proto = Object.getPrototypeOf(value) as unknown
      expect(
        proto === Object.prototype || proto === Array.prototype || proto === null,
        `${path} is a class instance`,
      ).toBe(true)
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
    }
    walk(state, 'state')
  })
})

describe('sudoku · completion', () => {
  it('a complete but incorrect grid flags and continues (§10 case 7)', () => {
    const state = deal()
    // Swap two solution digits so the grid is full and wrong.
    const empties = parseGrid(state.puzzle)
      .map((d, i) => (d === 0 ? i : -1))
      .filter((i) => i >= 0)
    const [a, b] = [empties[0] as number, empties[1] as number]
    const chars = state.solution.split('')
    const tmp = chars[a] as string
    chars[a] = chars[b] as string
    chars[b] = tmp

    const filled = fillFrom(state, 0, chars.join(''))

    expect(filled.phase).toBe('PLAYING')
    expect(filled.players['0']?.mistakes).toBeGreaterThan(0)
    expect(Object.keys(filled.players['0']?.flagged ?? {}).length).toBeGreaterThan(0)
  })

  it('a complete and correct grid solves (§10 case 8)', () => {
    const state = deal()
    const solved = fillFrom(state, 0, state.solution)

    expect(solved.phase).toBe('SOLVED')
    expect(solved.players['0']?.solvedOrder).toBe(1)
    expect(solved.winnerSeat).toBe(0)
    expect(sudokuEngine.isTerminal(solved)).toBe(true)
    expect(sudokuEngine.result(solved).reason).toBe('NORMAL')
  })

  it('race: the earlier solver ranks first (§10 case 16)', () => {
    let state = deal([0, 1], { mode: 'race' })
    state = fillFrom(state, 1, state.solution)
    expect(state.phase).toBe('PLAYING')
    expect(state.winnerSeat).toBe(1)

    state = fillFrom(state, 0, state.solution)
    expect(state.phase).toBe('SOLVED')

    const standings = sudokuEngine.result(state).standings
    expect(standings[0]?.seat).toBe(1)
    expect(standings[0]?.rank).toBe(1)
    expect(standings[1]?.seat).toBe(0)
  })

  it('GIVE_UP resigns the seat', () => {
    const state = apply(deal(), 0, { type: 'GIVE_UP' })
    expect(state.phase).toBe('ABANDONED')
    expect(sudokuEngine.result(state).standings[0]?.outcome).toBe('RESIGNED')
  })

  it('result() throws while the game is live', () => {
    expect(() => sudokuEngine.result(deal())).toThrow(IllegalMoveError)
  })
})

describe('sudoku · hints', () => {
  it('nextHint names a cell that matches the solution (§10 case 9a)', () => {
    const state = deal()
    const hint = nextHint(state.puzzle, state.solution)
    expect(hint.kind).toBe('MOVE')
    if (hint.kind !== 'MOVE') return
    expect(String(hint.value)).toBe(state.solution[hint.index])
    expect(state.puzzle[hint.index]).toBe('0')
  })

  it('a FREE hint fills the cell and carries its technique', () => {
    const state = deal()
    const result = sudokuEngine.applyMove(state, seatId(0), { type: 'HINT', funding: 'FREE' }, rng)
    const player = result.state.players['0']

    expect(player?.hintsUsed).toBe(1)
    expect(player?.hintPointsSpent).toBe(0)
    expect(player?.lastHint?.techniqueKey).toMatch(/^sudoku\.technique\./)
    expect(player?.grid[player.lastHint?.index ?? 0]).toBe(
      state.solution[player?.lastHint?.index ?? 0],
    )
  })

  it('★ the broadcast carries the count, never the cell (§10 case 9i)', () => {
    const state = deal([0, 1], { mode: 'race' })
    const { events } = sudokuEngine.applyMove(
      state,
      seatId(0),
      { type: 'HINT', funding: 'FREE' },
      rng,
    )
    const payload = events[0]?.payload as Record<string, unknown>

    expect(payload['result']).toBe('HINT_USED')
    expect(payload['hintsUsed']).toBe(1)
    // Handing the table the cell would hand them the hint.
    expect(payload).not.toHaveProperty('index')
    expect(payload).not.toHaveProperty('value')
  })

  it('a FREE hint beyond maxHints is illegal (§10 case 9)', () => {
    let state = deal([0], { maxHints: 1 })
    state = apply(state, 0, { type: 'HINT', funding: 'FREE' })
    expect(() => apply(state, 0, { type: 'HINT', funding: 'FREE' })).toThrow(IllegalMoveError)
  })

  it('a POINT hint works past maxHints, and counts separately', () => {
    let state = deal([0], { maxHints: 0 })
    state = apply(state, 0, { type: 'HINT', funding: 'POINT' })
    const player = state.players['0']

    expect(player?.hintsUsed).toBe(1)
    expect(player?.hintPointsSpent).toBe(1)
  })

  it('a POINT hint is refused when the table disables hint points', () => {
    const state = deal([0], { maxHints: 0, allowHintPoints: false })
    expect(() => apply(state, 0, { type: 'HINT', funding: 'POINT' })).toThrow(IllegalMoveError)
  })

  it('★ a hint on a contradicted grid reports the mistake and charges nothing (§10 case 9b)', () => {
    let state = deal([0], { maxHints: 1 })
    const index = state.puzzle.indexOf('0')
    const correct = Number(state.solution[index])
    const wrong = correct === 9 ? 1 : correct + 1
    state = apply(state, 0, { type: 'SET_CELL', index, value: wrong })

    const result = sudokuEngine.applyMove(state, seatId(0), { type: 'HINT', funding: 'FREE' }, rng)
    const player = result.state.players['0']

    expect((result.events[0]?.payload as Record<string, unknown>)['result']).toBe('HINT_MISTAKE')
    expect(player?.flagged[String(index)]).toBe(true)
    // ★ §13.3 — a hint that cannot be given is never paid for.
    expect(player?.hintsUsed).toBe(0)
    expect(player?.hintPointsSpent).toBe(0)
  })

  it('a hint on a full grid reports NONE and charges nothing (§10 case 10)', () => {
    // autoCheckOnComplete off, so the grid can be full while the game is live.
    const state = deal([0], { autoCheckOnComplete: false })
    const full = fillFrom(state, 0, state.solution)

    const result = sudokuEngine.applyMove(full, seatId(0), { type: 'HINT', funding: 'FREE' }, rng)
    expect((result.events[0]?.payload as Record<string, unknown>)['result']).toBe('HINT_NONE')
    expect(result.state.players['0']?.hintsUsed).toBe(0)
  })

  it('a hint can finish the puzzle', () => {
    const state = deal([0], { autoCheckOnComplete: true, maxHints: 10 })
    // Fill everything but one cell, then hint it home.
    const target = state.puzzle.lastIndexOf('0')
    let next = state
    for (let index = 0; index < CELLS; index++) {
      if (isGiven(state.puzzle, index) || index === target) continue
      next = apply(next, 0, { type: 'SET_CELL', index, value: Number(state.solution[index]) })
    }
    expect(next.phase).toBe('PLAYING')

    next = apply(next, 0, { type: 'HINT', funding: 'FREE' })
    expect(next.phase).toBe('SOLVED')
  })

  it('freeHintsLeft shrinks with free hints and not with point hints', () => {
    let state = deal([0], { maxHints: 2 })
    expect(seatView(state, 0).me?.freeHintsLeft).toBe(2)

    state = apply(state, 0, { type: 'HINT', funding: 'FREE' })
    expect(seatView(state, 0).me?.freeHintsLeft).toBe(1)

    state = apply(state, 0, { type: 'HINT', funding: 'POINT' })
    expect(seatView(state, 0).me?.freeHintsLeft).toBe(1)
  })
})

describe('sudoku · notes and check', () => {
  it('notes survive a JSON round-trip and are sorted', () => {
    const state = apply(deal(), 0, {
      type: 'SET_NOTES',
      index: deal().puzzle.indexOf('0'),
      digits: [7, 2, 5],
    })
    const index = deal().puzzle.indexOf('0')
    expect(state.players['0']?.notes[String(index)]).toEqual([2, 5, 7])
  })

  it('setting a cell clears its notes', () => {
    const index = deal().puzzle.indexOf('0')
    let state = apply(deal(), 0, { type: 'SET_NOTES', index, digits: [1, 2] })
    state = apply(state, 0, { type: 'SET_CELL', index, value: 3 })
    expect(state.players['0']?.notes[String(index)]).toBeUndefined()
  })

  it('CHECK flags wrong cells and counts them as mistakes', () => {
    let state = deal()
    const empties = parseGrid(state.puzzle)
      .map((d, i) => (d === 0 ? i : -1))
      .filter((i) => i >= 0)
      .slice(0, 2)

    for (const index of empties) {
      const correct = Number(state.solution[index])
      state = apply(state, 0, { type: 'SET_CELL', index, value: correct === 9 ? 1 : correct + 1 })
    }
    state = apply(state, 0, { type: 'CHECK' })

    expect(state.players['0']?.mistakes).toBe(2)
    expect(Object.keys(state.players['0']?.flagged ?? {}).sort()).toEqual(
      empties.map(String).sort(),
    )
  })

  it('correcting a flagged cell clears its flag', () => {
    let state = deal()
    const index = state.puzzle.indexOf('0')
    const correct = Number(state.solution[index])

    state = apply(state, 0, { type: 'SET_CELL', index, value: correct === 9 ? 1 : correct + 1 })
    state = apply(state, 0, { type: 'CHECK' })
    expect(state.players['0']?.flagged[String(index)]).toBe(true)

    state = apply(state, 0, { type: 'SET_CELL', index, value: correct })
    expect(state.players['0']?.flagged[String(index)]).toBeUndefined()
  })
})

describe('sudoku · meta', () => {
  it('declares no turn limit — a puzzle has no turns', () => {
    expect(sudokuMeta.turnTimeoutMs).toBeNull()
    expect(sudokuMeta.supportsBots).toBe(false)
  })

  it('accepts the documented options and rejects unknown ones', () => {
    expect(() => sudokuMeta.optionsSchema.parse({ difficulty: 'hard' })).not.toThrow()
    expect(() => sudokuMeta.optionsSchema.parse({ nope: true })).toThrow()
  })
})
