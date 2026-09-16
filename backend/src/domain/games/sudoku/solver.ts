import {
  ALL_DIGITS_MASK,
  CELLS,
  EMPTY,
  PEERS_OF,
  SIZE,
  UNITS,
  UNITS_OF,
  BOX_UNITS,
  COL_UNITS,
  ROW_UNITS,
  candidateMasks,
  colOf,
  digitsOf,
  formatGrid,
  maskOf,
  parseGrid,
  popcount,
  rowOf,
  soleDigitOf,
  unitLabel,
} from './grid.js'

/**
 * ★ The solver — `games/sudoku.md` §5 (grading) and §13.2 (hints).
 *
 * One module answers three questions that look separate and are not:
 *
 *   1. **Does this puzzle have exactly one solution?** — {@link countSolutions}.
 *      A puzzle with two is not a Sudoku, and the generator must never ship one.
 *   2. **How hard is it?** — {@link grade}. By the *hardest technique a human
 *      needs*, not by how many digits were removed. A 25-given puzzle solvable
 *      by singles is easy, and given count alone would call it expert.
 *   3. **What should this player do next?** — {@link nextHint}. Run the same
 *      technique ladder against the player's live grid and return the first
 *      thing that can actually be proven.
 *
 * They share a module because they share the ladder. Building the hint finder
 * on top of the grader is the whole reason a hint can say *why* a cell is
 * forced instead of just handing over the answer: the grader already had to
 * know which technique fired, so a hint that names it costs nothing extra.
 *
 * **Everything here is pure.** No clock, no randomness except where an `Rng` is
 * passed in explicitly, no I/O. `generator.ts` is the only caller that needs
 * randomness and it injects its own (I1).
 */

/**
 * The ladder, easiest first. **Order is the ranking** — `grade` reports the
 * highest index reached, and `nextHint` returns the first rung that fires.
 *
 * `guess` is the floor under everything: a puzzle nothing above it can crack is
 * still solvable by search, but not by a technique anyone would call reasoning,
 * so it grades as expert and a hint falls back to "here is a cell that is
 * provably this digit" without a technique to teach.
 */
export const TECHNIQUES = [
  'nakedSingle',
  'hiddenSingle',
  'nakedPair',
  'hiddenPair',
  'pointingPair',
  'boxLineReduction',
  'xWing',
  'guess',
] as const

export type Technique = (typeof TECHNIQUES)[number]

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert'

/** §1's table, as the map from "hardest technique needed" to a band. */
const BAND_OF: Readonly<Record<Technique, Difficulty>> = {
  nakedSingle: 'easy',
  hiddenSingle: 'easy',
  nakedPair: 'medium',
  hiddenPair: 'medium',
  pointingPair: 'hard',
  boxLineReduction: 'hard',
  xWing: 'expert',
  guess: 'expert',
}

export function bandOf(technique: Technique): Difficulty {
  return BAND_OF[technique]
}

export function rankOf(technique: Technique): number {
  return TECHNIQUES.indexOf(technique)
}

/** The i18n key a hint carries. Never a rendered sentence (§13.2). */
export function techniqueKey(technique: Technique): string {
  return `sudoku.technique.${technique}`
}

// ── The working board ────────────────────────────────────────────────────────

interface Board {
  readonly cells: number[]
  readonly masks: number[]
}

function boardFrom(cells: readonly number[]): Board | null {
  const masks = candidateMasks(cells)
  if (masks === null) return null
  return { cells: [...cells], masks }
}

/**
 * Place a digit and propagate the elimination to every peer.
 *
 * Returns `false` the moment the placement starves an empty cell of candidates
 * — a contradiction. Callers treat that as "this branch is dead", which is what
 * makes the backtracking search below correct and what makes an impossible
 * player grid detectable rather than an infinite loop.
 */
function place(board: Board, index: number, digit: number): boolean {
  board.cells[index] = digit
  board.masks[index] = 0

  const bit = maskOf(digit)
  for (const peer of PEERS_OF[index] as readonly number[]) {
    if (board.cells[peer] !== EMPTY) continue
    const next = (board.masks[peer] as number) & ~bit
    if (next === 0) return false
    board.masks[peer] = next
  }
  return true
}

function emptyCount(board: Board): number {
  let n = 0
  for (let i = 0; i < CELLS; i++) if (board.cells[i] === EMPTY) n++
  return n
}

// ── Uniqueness ───────────────────────────────────────────────────────────────

/**
 * How many solutions this grid has, **short-circuiting at `limit`** (default 2).
 *
 * The generator only ever needs to know "one, or more than one", and counting
 * past that on a nearly-empty grid is unbounded work for an answer nobody
 * reads. Branching on the most-constrained cell first is what keeps this in
 * microseconds rather than seconds.
 */
export function countSolutions(cells: readonly number[], limit = 2): number {
  const board = boardFrom(cells)
  if (board === null) return 0

  let found = 0

  const recurse = (b: Board): void => {
    if (found >= limit) return

    let best = -1
    let bestCount = SIZE + 1
    for (let i = 0; i < CELLS; i++) {
      if (b.cells[i] !== EMPTY) continue
      const n = popcount(b.masks[i] as number)
      if (n < bestCount) {
        bestCount = n
        best = i
        if (n === 1) break
      }
    }

    if (best === -1) {
      found++
      return
    }

    for (const digit of digitsOf(b.masks[best] as number)) {
      const next: Board = { cells: [...b.cells], masks: [...b.masks] }
      if (place(next, best, digit)) recurse(next)
      if (found >= limit) return
    }
  }

  recurse(board)
  return found
}

export function hasUniqueSolution(cells: readonly number[]): boolean {
  return countSolutions(cells, 2) === 1
}

/** The single solution, or `null` if there are none or several. */
export function solveUnique(cells: readonly number[]): string | null {
  const board = boardFrom(cells)
  if (board === null) return null

  let solution: number[] | null = null
  let found = 0

  const recurse = (b: Board): void => {
    if (found >= 2) return

    let best = -1
    let bestCount = SIZE + 1
    for (let i = 0; i < CELLS; i++) {
      if (b.cells[i] !== EMPTY) continue
      const n = popcount(b.masks[i] as number)
      if (n < bestCount) {
        bestCount = n
        best = i
        if (n === 1) break
      }
    }

    if (best === -1) {
      found++
      if (found === 1) solution = [...b.cells]
      return
    }

    for (const digit of digitsOf(b.masks[best] as number)) {
      const next: Board = { cells: [...b.cells], masks: [...b.masks] }
      if (place(next, best, digit)) recurse(next)
      if (found >= 2) return
    }
  }

  recurse(board)
  return found === 1 && solution !== null ? formatGrid(solution) : null
}

// ── Techniques ───────────────────────────────────────────────────────────────

/** A cell a technique proved. The unit is carried for the hint's explanation. */
interface Placement {
  readonly index: number
  readonly digit: number
  readonly technique: Technique
  readonly unit: number | null
}

/** A technique that removed candidates without placing anything. */
interface Elimination {
  readonly technique: Technique
  readonly unit: number | null
  readonly removed: number
}

type Step = { kind: 'place'; at: Placement } | { kind: 'eliminate'; at: Elimination } | null

function findNakedSingle(board: Board): Placement | null {
  for (let i = 0; i < CELLS; i++) {
    if (board.cells[i] !== EMPTY) continue
    const mask = board.masks[i] as number
    if (popcount(mask) === 1) {
      return { index: i, digit: soleDigitOf(mask), technique: 'nakedSingle', unit: null }
    }
  }
  return null
}

function findHiddenSingle(board: Board): Placement | null {
  for (let unitIdx = 0; unitIdx < UNITS.length; unitIdx++) {
    const unit = UNITS[unitIdx] as readonly number[]
    for (let digit = 1; digit <= SIZE; digit++) {
      const bit = maskOf(digit)
      let seat = -1
      let count = 0
      let taken = false

      for (const cell of unit) {
        if (board.cells[cell] === digit) {
          taken = true
          break
        }
        if (board.cells[cell] === EMPTY && ((board.masks[cell] as number) & bit) !== 0) {
          seat = cell
          count++
        }
      }

      if (!taken && count === 1) {
        return { index: seat, digit, technique: 'hiddenSingle', unit: unitIdx }
      }
    }
  }
  return null
}

function findNakedPair(board: Board): Elimination | null {
  for (let unitIdx = 0; unitIdx < UNITS.length; unitIdx++) {
    const unit = UNITS[unitIdx] as readonly number[]
    const pairs: number[] = []
    for (const cell of unit) {
      if (board.cells[cell] === EMPTY && popcount(board.masks[cell] as number) === 2) {
        pairs.push(cell)
      }
    }

    for (let a = 0; a < pairs.length; a++) {
      for (let b = a + 1; b < pairs.length; b++) {
        const ia = pairs[a] as number
        const ib = pairs[b] as number
        const mask = board.masks[ia] as number
        if (mask !== board.masks[ib]) continue

        let removed = 0
        for (const cell of unit) {
          if (cell === ia || cell === ib) continue
          if (board.cells[cell] !== EMPTY) continue
          const before = board.masks[cell] as number
          const after = before & ~mask
          if (after !== before) {
            if (after === 0) return null
            board.masks[cell] = after
            removed += popcount(before) - popcount(after)
          }
        }
        if (removed > 0) return { technique: 'nakedPair', unit: unitIdx, removed }
      }
    }
  }
  return null
}

function findHiddenPair(board: Board): Elimination | null {
  for (let unitIdx = 0; unitIdx < UNITS.length; unitIdx++) {
    const unit = UNITS[unitIdx] as readonly number[]

    for (let d1 = 1; d1 <= SIZE; d1++) {
      for (let d2 = d1 + 1; d2 <= SIZE; d2++) {
        const bits = maskOf(d1) | maskOf(d2)
        const hosts: number[] = []
        let ok = true

        for (const cell of unit) {
          if (board.cells[cell] === d1 || board.cells[cell] === d2) {
            ok = false
            break
          }
          if (board.cells[cell] !== EMPTY) continue
          if (((board.masks[cell] as number) & bits) !== 0) hosts.push(cell)
        }
        if (!ok || hosts.length !== 2) continue

        // Both digits must actually be confined to these two cells.
        const m0 = board.masks[hosts[0] as number] as number
        const m1 = board.masks[hosts[1] as number] as number
        if ((m0 & bits) === 0 || (m1 & bits) === 0) continue
        if (((m0 | m1) & bits) !== bits) continue

        let removed = 0
        for (const cell of hosts) {
          const before = board.masks[cell] as number
          const after = before & bits
          if (after !== before) {
            board.masks[cell] = after
            removed += popcount(before) - popcount(after)
          }
        }
        if (removed > 0) return { technique: 'hiddenPair', unit: unitIdx, removed }
      }
    }
  }
  return null
}

/**
 * A digit confined to one row (or column) *within a box* can be struck from the
 * rest of that row outside the box.
 */
function findPointingPair(board: Board): Elimination | null {
  for (let b = 0; b < SIZE; b++) {
    const box = BOX_UNITS[b] as readonly number[]
    const boxUnitIdx = SIZE * 2 + b

    for (let digit = 1; digit <= SIZE; digit++) {
      const bit = maskOf(digit)
      const hosts = box.filter(
        (cell) => board.cells[cell] === EMPTY && ((board.masks[cell] as number) & bit) !== 0,
      )
      if (hosts.length < 2) continue

      const sameRow = hosts.every((c) => rowOf(c) === rowOf(hosts[0] as number))
      const sameCol = hosts.every((c) => colOf(c) === colOf(hosts[0] as number))
      if (!sameRow && !sameCol) continue

      const line = sameRow
        ? (ROW_UNITS[rowOf(hosts[0] as number)] as readonly number[])
        : (COL_UNITS[colOf(hosts[0] as number)] as readonly number[])

      let removed = 0
      for (const cell of line) {
        if (box.includes(cell)) continue
        if (board.cells[cell] !== EMPTY) continue
        const before = board.masks[cell] as number
        const after = before & ~bit
        if (after !== before) {
          if (after === 0) return null
          board.masks[cell] = after
          removed++
        }
      }
      if (removed > 0) return { technique: 'pointingPair', unit: boxUnitIdx, removed }
    }
  }
  return null
}

/**
 * The mirror of pointing: a digit confined to one box *within a row or column*
 * can be struck from the rest of that box.
 */
function findBoxLineReduction(board: Board): Elimination | null {
  const lines = [...ROW_UNITS, ...COL_UNITS]

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l] as readonly number[]
    const lineUnitIdx = l

    for (let digit = 1; digit <= SIZE; digit++) {
      const bit = maskOf(digit)
      const hosts = line.filter(
        (cell) => board.cells[cell] === EMPTY && ((board.masks[cell] as number) & bit) !== 0,
      )
      if (hosts.length < 2) continue

      const boxIdx = (UNITS_OF[hosts[0] as number] as readonly number[])[2] as number
      if (!hosts.every((c) => ((UNITS_OF[c] as readonly number[])[2] as number) === boxIdx)) {
        continue
      }

      let removed = 0
      for (const cell of UNITS[boxIdx] as readonly number[]) {
        if (line.includes(cell)) continue
        if (board.cells[cell] !== EMPTY) continue
        const before = board.masks[cell] as number
        const after = before & ~bit
        if (after !== before) {
          if (after === 0) return null
          board.masks[cell] = after
          removed++
        }
      }
      if (removed > 0) return { technique: 'boxLineReduction', unit: lineUnitIdx, removed }
    }
  }
  return null
}

/**
 * Two rows in which a digit has exactly the same two candidate columns force
 * that digit into those columns, so it leaves every other row's copy of them.
 * Transposed for columns.
 */
function findXWing(board: Board): Elimination | null {
  for (const orientation of ['row', 'col'] as const) {
    const lines = orientation === 'row' ? ROW_UNITS : COL_UNITS
    const crossOf = orientation === 'row' ? colOf : rowOf

    for (let digit = 1; digit <= SIZE; digit++) {
      const bit = maskOf(digit)

      const positions = lines.map((line) =>
        (line as readonly number[]).filter(
          (cell) => board.cells[cell] === EMPTY && ((board.masks[cell] as number) & bit) !== 0,
        ),
      )

      for (let a = 0; a < positions.length; a++) {
        const pa = positions[a] as number[]
        if (pa.length !== 2) continue

        for (let b = a + 1; b < positions.length; b++) {
          const pb = positions[b] as number[]
          if (pb.length !== 2) continue
          if (crossOf(pa[0] as number) !== crossOf(pb[0] as number)) continue
          if (crossOf(pa[1] as number) !== crossOf(pb[1] as number)) continue

          const crossLines = orientation === 'row' ? COL_UNITS : ROW_UNITS
          let removed = 0

          for (const corner of [pa[0] as number, pa[1] as number]) {
            const cross = crossLines[crossOf(corner)] as readonly number[]
            for (const cell of cross) {
              if (pa.includes(cell) || pb.includes(cell)) continue
              if (board.cells[cell] !== EMPTY) continue
              const before = board.masks[cell] as number
              const after = before & ~bit
              if (after !== before) {
                if (after === 0) return null
                board.masks[cell] = after
                removed++
              }
            }
          }

          if (removed > 0) return { technique: 'xWing', unit: null, removed }
        }
      }
    }
  }
  return null
}

/**
 * The floor: when no technique fires, branch on the most-constrained cell and
 * keep whichever digit survives. Reported as `guess`, which is what pushes a
 * puzzle into the expert band.
 */
function findBySearch(board: Board): Placement | null {
  let best = -1
  let bestCount = SIZE + 1
  for (let i = 0; i < CELLS; i++) {
    if (board.cells[i] !== EMPTY) continue
    const n = popcount(board.masks[i] as number)
    if (n < bestCount) {
      bestCount = n
      best = i
    }
  }
  if (best === -1) return null

  for (const digit of digitsOf(board.masks[best] as number)) {
    const probe: Board = { cells: [...board.cells], masks: [...board.masks] }
    if (!place(probe, best, digit)) continue
    if (countSolutions(probe.cells, 1) === 1) {
      return { index: best, digit, technique: 'guess', unit: null }
    }
  }
  return null
}

/**
 * One rung of the ladder, cheapest first. **Mutates `board`** for the
 * elimination techniques — they exist to shrink candidate masks, and copying
 * the board per attempt would triple the grader's cost for no benefit, since a
 * failed technique changes nothing by construction.
 */
function step(board: Board): Step {
  const naked = findNakedSingle(board)
  if (naked !== null) return { kind: 'place', at: naked }

  const hidden = findHiddenSingle(board)
  if (hidden !== null) return { kind: 'place', at: hidden }

  const np = findNakedPair(board)
  if (np !== null) return { kind: 'eliminate', at: np }

  const hp = findHiddenPair(board)
  if (hp !== null) return { kind: 'eliminate', at: hp }

  const pp = findPointingPair(board)
  if (pp !== null) return { kind: 'eliminate', at: pp }

  const bl = findBoxLineReduction(board)
  if (bl !== null) return { kind: 'eliminate', at: bl }

  const xw = findXWing(board)
  if (xw !== null) return { kind: 'eliminate', at: xw }

  const guess = findBySearch(board)
  if (guess !== null) return { kind: 'place', at: guess }

  return null
}

// ── Grading ──────────────────────────────────────────────────────────────────

export interface Grade {
  readonly difficulty: Difficulty
  /** The single hardest technique the solve required. */
  readonly hardest: Technique
  /** Every technique that fired at least once, easiest first. */
  readonly used: readonly Technique[]
}

/**
 * Solve the puzzle the way a person would and report the hardest rung reached.
 *
 * Returns `null` for a puzzle that cannot be solved at all — which for a
 * generated puzzle means a bug, and for a player-supplied grid means a
 * contradiction.
 */
export function grade(puzzle: string): Grade | null {
  const board = boardFrom(parseGrid(puzzle))
  if (board === null) return null

  const seen = new Array<boolean>(TECHNIQUES.length).fill(false)
  let hardestRank = 0
  let progressed = true

  while (emptyCount(board) > 0 && progressed) {
    const next = step(board)
    if (next === null) {
      progressed = false
      break
    }

    const technique = next.kind === 'place' ? next.at.technique : next.at.technique
    seen[rankOf(technique)] = true
    hardestRank = Math.max(hardestRank, rankOf(technique))

    if (next.kind === 'place') {
      if (!place(board, next.at.index, next.at.digit)) return null
    }
  }

  if (emptyCount(board) > 0) return null

  const hardest = TECHNIQUES[hardestRank] as Technique
  const used = TECHNIQUES.filter((_t, i) => seen[i] === true)
  return { difficulty: bandOf(hardest), hardest, used }
}

// ── Hints ────────────────────────────────────────────────────────────────────

/**
 * ★ `games/sudoku.md` §13.2 — what a hint actually reveals.
 *
 * Three outcomes, and the `MISTAKE` one is why this is a discriminated union
 * rather than a nullable cell:
 *
 *   - `MOVE` — the next cell that can be *proved*, with the technique proving
 *     it. This is the answer to "what is my right next move".
 *   - `MISTAKE` — the player's grid contradicts the puzzle, so no technique can
 *     prove anything and the honest response is not a cell but "you went wrong,
 *     here". Per §13.3 this **costs nothing**.
 *   - `NONE` — nothing left to fill.
 */
export type HintResult =
  | {
      readonly kind: 'MOVE'
      readonly index: number
      readonly value: number
      readonly technique: Technique
      /** i18n params for the explanation: the unit the technique fired in. */
      readonly unit: { readonly kind: 'row' | 'col' | 'box'; readonly n: number } | null
    }
  | { readonly kind: 'MISTAKE'; readonly cells: readonly number[] }
  | { readonly kind: 'NONE' }

/**
 * The next provable cell in `grid`, given the immutable `puzzle` it came from.
 *
 * `solution` is taken as an argument rather than recomputed because the caller
 * already has it and because it is what makes `MISTAKE` precise: a grid can be
 * internally consistent (no repeated digit anywhere) and still be wrong, and
 * only the solution distinguishes "you have not finished" from "you cannot
 * finish". Comparing against it first is what stops the solver being handed an
 * unsolvable board and spending its search budget proving it.
 */
export function nextHint(grid: string, solution: string): HintResult {
  const wrong: number[] = []
  for (let i = 0; i < CELLS; i++) {
    const entered = grid.charCodeAt(i) - 48
    if (entered !== EMPTY && entered !== solution.charCodeAt(i) - 48) wrong.push(i)
  }
  if (wrong.length > 0) return { kind: 'MISTAKE', cells: wrong }

  const cells = parseGrid(grid)
  if (!cells.includes(EMPTY)) return { kind: 'NONE' }

  const board = boardFrom(cells)
  // Unreachable while the grid agrees with the solution, but a starved cell is
  // still a contradiction rather than a crash.
  if (board === null) return { kind: 'MISTAKE', cells: [] }

  for (;;) {
    const next = step(board)
    if (next === null) break

    if (next.kind === 'place') {
      return {
        kind: 'MOVE',
        index: next.at.index,
        value: next.at.digit,
        technique: next.at.technique,
        unit: next.at.unit === null ? null : unitLabel(next.at.unit),
      }
    }
    // An elimination shrank the masks; loop and let a placement fall out.
  }

  return { kind: 'NONE' }
}

/** Every digit still placeable in a cell — the client's pencil-mark helper. */
export function candidatesAt(grid: string, index: number): number[] {
  const masks = candidateMasks(parseGrid(grid))
  if (masks === null) return []
  return digitsOf((masks[index] as number) & ALL_DIGITS_MASK)
}
