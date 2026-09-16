/**
 * ★ Sudoku's geometry — `games/sudoku.md` §1.
 *
 * Nothing here knows about a game, a seat or a player. It is the board: which
 * cells share a row, a column or a box, what may legally go where, and how a
 * grid moves between its two representations. The solver, the generator, the
 * hint finder and the engine all build on exactly this, which is why it has no
 * dependencies at all — not even on the engine contract.
 *
 * **Two representations, on purpose.**
 *
 *   - **A string of 81 characters**, `'0'` for empty. This is what crosses a
 *     wire and what lands in the event log: one JSON scalar, trivially
 *     serializable (I5), diffable by eye in a failing test, and impossible to
 *     get half-mutated.
 *   - **A `number[]` of 81 digits**, `0` for empty. This is what the solver
 *     works in, because the solver touches cells hundreds of thousands of times
 *     per generated puzzle and string concatenation there would dominate the
 *     runtime.
 *
 * Converting at the boundary costs a single pass and buys both properties. The
 * rule is that anything *stored* is a string and anything *computed* is an
 * array.
 *
 * **Candidates are bitmasks.** A cell's possibilities are one integer, bit
 * `d - 1` meaning "digit `d` is still possible". Union, intersection and "how
 * many are left" become `|`, `&` and a popcount, which is what makes the
 * technique solver in `solver.ts` readable rather than a nest of array scans.
 */

export const SIZE = 9
export const BOX = 3
export const CELLS = SIZE * SIZE
export const EMPTY = 0

/** Every digit, as a bitmask. `0b111111111`. */
export const ALL_DIGITS_MASK = (1 << SIZE) - 1

export type Digit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export function maskOf(digit: number): number {
  return 1 << (digit - 1)
}

/** How many digits a candidate mask still allows. */
export function popcount(mask: number): number {
  let n = 0
  let m = mask
  while (m !== 0) {
    m &= m - 1
    n++
  }
  return n
}

/** The digits in a mask, ascending. */
export function digitsOf(mask: number): number[] {
  const out: number[] = []
  for (let d = 1; d <= SIZE; d++) if ((mask & maskOf(d)) !== 0) out.push(d)
  return out
}

/** The single digit in a one-bit mask. Caller guarantees `popcount === 1`. */
export function soleDigitOf(mask: number): number {
  return 31 - Math.clz32(mask) + 1
}

export function rowOf(index: number): number {
  return Math.floor(index / SIZE)
}

export function colOf(index: number): number {
  return index % SIZE
}

export function boxOf(index: number): number {
  return Math.floor(rowOf(index) / BOX) * BOX + Math.floor(colOf(index) / BOX)
}

export function indexOf(row: number, col: number): number {
  return row * SIZE + col
}

function buildUnits(): readonly (readonly number[])[] {
  const units: number[][] = []

  for (let r = 0; r < SIZE; r++) {
    const unit: number[] = []
    for (let c = 0; c < SIZE; c++) unit.push(indexOf(r, c))
    units.push(unit)
  }
  for (let c = 0; c < SIZE; c++) {
    const unit: number[] = []
    for (let r = 0; r < SIZE; r++) unit.push(indexOf(r, c))
    units.push(unit)
  }
  for (let b = 0; b < SIZE; b++) {
    const unit: number[] = []
    const r0 = Math.floor(b / BOX) * BOX
    const c0 = (b % BOX) * BOX
    for (let dr = 0; dr < BOX; dr++) {
      for (let dc = 0; dc < BOX; dc++) unit.push(indexOf(r0 + dr, c0 + dc))
    }
    units.push(unit)
  }

  return units
}

/**
 * The 27 units: 9 rows, then 9 columns, then 9 boxes — **in that order**, which
 * `solver.ts` relies on to name the unit a technique fired in without storing a
 * label alongside every one.
 */
export const UNITS = buildUnits()

export const ROW_UNITS = UNITS.slice(0, SIZE)
export const COL_UNITS = UNITS.slice(SIZE, SIZE * 2)
export const BOX_UNITS = UNITS.slice(SIZE * 2)

/** Describes a unit for a hint's i18n params: `{ kind: 'box', n: 2 }`. */
export function unitLabel(unitIdx: number): { kind: 'row' | 'col' | 'box'; n: number } {
  if (unitIdx < SIZE) return { kind: 'row', n: unitIdx + 1 }
  if (unitIdx < SIZE * 2) return { kind: 'col', n: unitIdx - SIZE + 1 }
  return { kind: 'box', n: unitIdx - SIZE * 2 + 1 }
}

function buildUnitsOf(): readonly (readonly number[])[] {
  const out: number[][] = Array.from({ length: CELLS }, () => [])
  UNITS.forEach((unit, unitIdx) => {
    for (const cell of unit) (out[cell] as number[]).push(unitIdx)
  })
  return out
}

/** For each cell, the indices into {@link UNITS} of its row, column and box. */
export const UNITS_OF = buildUnitsOf()

function buildPeers(): readonly (readonly number[])[] {
  return Array.from({ length: CELLS }, (_unused, cell) => {
    const seen = new Array<boolean>(CELLS).fill(false)
    for (const unitIdx of UNITS_OF[cell] as readonly number[]) {
      for (const peer of UNITS[unitIdx] as readonly number[]) seen[peer] = true
    }
    seen[cell] = false
    const peers: number[] = []
    for (let i = 0; i < CELLS; i++) if (seen[i] === true) peers.push(i)
    return peers
  })
}

/** For each cell, its 20 peers — every cell that may not repeat its digit. */
export const PEERS_OF = buildPeers()

// ── Representation ───────────────────────────────────────────────────────────

/** `'0'`-padded 81-character form. The storage and wire representation. */
export function isGridString(value: unknown): value is string {
  return typeof value === 'string' && value.length === CELLS && /^[0-9]{81}$/.test(value)
}

export function parseGrid(grid: string): number[] {
  const cells = new Array<number>(CELLS)
  for (let i = 0; i < CELLS; i++) cells[i] = grid.charCodeAt(i) - 48
  return cells
}

export function formatGrid(cells: readonly number[]): string {
  let out = ''
  for (let i = 0; i < CELLS; i++) out += String(cells[i])
  return out
}

export function emptyGrid(): string {
  return '0'.repeat(CELLS)
}

export function countFilled(grid: string): number {
  let n = 0
  for (let i = 0; i < CELLS; i++) if (grid.charCodeAt(i) !== 48) n++
  return n
}

export function isComplete(grid: string): boolean {
  return countFilled(grid) === CELLS
}

/** The indices a puzzle fixes and a player may never change. */
export function givenIndices(puzzle: string): number[] {
  const out: number[] = []
  for (let i = 0; i < CELLS; i++) if (puzzle.charCodeAt(i) !== 48) out.push(i)
  return out
}

export function isGiven(puzzle: string, index: number): boolean {
  return index >= 0 && index < CELLS && puzzle.charCodeAt(index) !== 48
}

// ── Legality ─────────────────────────────────────────────────────────────────

/**
 * May `digit` go in `index` without repeating in a peer?
 *
 * Note what this is **not**: a claim that the digit is *correct*. Sudoku's
 * deliberate asymmetry (§3) is that a wrong-but-non-repeating entry is a legal
 * move, because refusing it would do the player's deduction for them. Only
 * `CHECK`, completion, or a hint compares against the solution.
 */
export function canPlace(cells: readonly number[], index: number, digit: number): boolean {
  for (const peer of PEERS_OF[index] as readonly number[]) {
    if (cells[peer] === digit) return false
  }
  return true
}

/**
 * Every cell that repeats a digit within one of its units — the client's own
 * red-squiggle highlighting, computed server-side so both agree.
 *
 * Distinct from "flagged": a conflict is visible from the grid alone, while a
 * flag is the server confirming against the solution. §9 renders them
 * differently because one is an observation and the other is truth.
 */
export function conflictingCells(grid: string): number[] {
  const cells = parseGrid(grid)
  const bad = new Array<boolean>(CELLS).fill(false)

  for (const unit of UNITS) {
    for (let a = 0; a < unit.length; a++) {
      const ia = unit[a] as number
      if (cells[ia] === EMPTY) continue
      for (let b = a + 1; b < unit.length; b++) {
        const ib = unit[b] as number
        if (cells[ia] === cells[ib]) {
          bad[ia] = true
          bad[ib] = true
        }
      }
    }
  }

  const out: number[] = []
  for (let i = 0; i < CELLS; i++) if (bad[i] === true) out.push(i)
  return out
}

/** A complete grid with no repeats. Says nothing about matching any solution. */
export function isValidComplete(grid: string): boolean {
  return isComplete(grid) && conflictingCells(grid).length === 0
}

// ── Candidates ───────────────────────────────────────────────────────────────

/**
 * Candidate masks for every cell: a filled cell gets `0`, an empty one the
 * digits no peer has taken.
 *
 * Returns `null` when the grid is already broken — some empty cell has no
 * candidate left, or a filled cell repeats in a unit. `null` is the honest
 * answer to "what can go here", and every caller has to face it: the solver
 * treats it as a dead branch, and `nextHint` turns it into the `MISTAKE` result
 * that tells a player they went wrong somewhere rather than inventing a move
 * (§13.2).
 */
export function candidateMasks(cells: readonly number[]): number[] | null {
  const masks = new Array<number>(CELLS).fill(0)

  for (let i = 0; i < CELLS; i++) {
    if (cells[i] !== EMPTY) continue
    let mask = ALL_DIGITS_MASK
    for (const peer of PEERS_OF[i] as readonly number[]) {
      const d = cells[peer] as number
      if (d !== EMPTY) mask &= ~maskOf(d)
    }
    if (mask === 0) return null
    masks[i] = mask
  }

  for (const unit of UNITS) {
    let seen = 0
    for (const cell of unit) {
      const d = cells[cell] as number
      if (d === EMPTY) continue
      const m = maskOf(d)
      if ((seen & m) !== 0) return null
      seen |= m
    }
  }

  return masks
}
