import type { Rng } from '../shared/rng.js'
import {
  CELLS,
  EMPTY,
  PEERS_OF,
  SIZE,
  formatGrid,
  maskOf,
  parseGrid,
  popcount,
  digitsOf,
  ALL_DIGITS_MASK,
} from './grid.js'
import { type Difficulty, type Grade, countSolutions, grade } from './solver.js'

/**
 * ★ Puzzle generation — `games/sudoku.md` §5.
 *
 * Three steps, and the middle one is the only interesting one:
 *
 *   1. **Build a full valid grid** by randomized backtracking.
 *   2. **Dig holes**, putting a cell back the moment its removal makes the
 *      puzzle ambiguous. A grid with two solutions is not a Sudoku — a player
 *      who "solves" it and is told they are wrong has been cheated by the
 *      generator, so the uniqueness check is not an optimisation to skip under
 *      time pressure.
 *   3. **Grade** by the hardest technique required, and retry if the result
 *      missed the requested band.
 *
 * **Determinism (I1).** Every random choice comes from the injected `Rng`, so
 * `(seed, difficulty)` always yields the same puzzle. That is what makes race
 * mode fair — both seats provably get the same grid — and what reduces a
 * "this puzzle was broken" report to a seed.
 */

/** §1's table: the given-count band each difficulty digs toward. */
export const GIVEN_BANDS: Readonly<Record<Difficulty, readonly [number, number]>> = {
  easy: [36, 40],
  medium: [30, 35],
  hard: [26, 29],
  expert: [22, 25],
}

export interface GeneratedPuzzle {
  readonly puzzle: string
  readonly solution: string
  /** The band that was asked for. */
  readonly requested: Difficulty
  /** What the grader actually says it is — usually, but not always, equal. */
  readonly graded: Difficulty
  readonly hardest: Grade['hardest']
  readonly givens: number
}

/**
 * A complete, valid, randomly-ordered grid.
 *
 * Fills cells in index order, trying digits in a shuffled order and backtracking
 * on a dead end. Shuffling the *digits* rather than the *cells* is what makes
 * this both uniform enough and fast: cell order barely matters when every cell
 * must be filled, but a fixed digit order would produce the same grid every
 * time up to relabelling.
 */
export function fullGrid(rng: Rng): string {
  const cells = new Array<number>(CELLS).fill(EMPTY)
  const masks = new Array<number>(CELLS).fill(ALL_DIGITS_MASK)

  const fill = (at: number): boolean => {
    if (at === CELLS) return true

    for (const digit of rng.shuffle(digitsOf(masks[at] as number))) {
      const touched: number[] = []
      const bit = maskOf(digit)
      let ok = true

      for (const peer of PEERS_OF[at] as readonly number[]) {
        if (cells[peer] !== EMPTY) continue
        if (((masks[peer] as number) & bit) === 0) continue
        masks[peer] = (masks[peer] as number) & ~bit
        touched.push(peer)
        if (masks[peer] === 0) {
          ok = false
          break
        }
      }

      if (ok) {
        cells[at] = digit
        const savedMask = masks[at] as number
        masks[at] = 0
        if (fill(at + 1)) return true
        masks[at] = savedMask
        cells[at] = EMPTY
      }

      for (const peer of touched) masks[peer] = (masks[peer] as number) | bit
    }

    return false
  }

  if (!fill(0)) {
    // Unreachable: an empty 9×9 always completes. Loud rather than silent.
    throw new Error('sudoku: could not build a full grid')
  }
  return formatGrid(cells)
}

/**
 * ★ Remove givens until the puzzle *requires* the requested technique band,
 * keeping it uniquely solvable at every step.
 *
 * **Digging to a given count and hoping the grade lands in the band does not
 * work**, and measuring it is how you find that out: digging to 30–35 givens
 * produced an `easy` puzzle four times in five, because most puzzles in that
 * range are still solvable by singles alone. §5 says as much in words — "given
 * count alone is a poor proxy" — so the generator has to take it literally and
 * make the *technique* the stopping condition, with the given band demoted to a
 * floor that stops a nominally-easy puzzle being dug into a 22-given one.
 *
 * Three rules, checked per candidate removal:
 *
 *   - **Ambiguous → put it back.** A second solution means it is not a Sudoku.
 *   - **Too hard → put it back.** A removal that pushes the grade past the
 *     requested band is refused, so an "easy" puzzle can never need an X-wing.
 *     This is what makes the difficulty a promise rather than an average.
 *   - **Otherwise keep it**, and stop once the grade has reached the requested
 *     band and the given count is inside it.
 *
 * No backtracking: a cell that cannot be removed now will not become removable
 * later, and proving otherwise costs far more than the few extra givens it
 * would save.
 */
export function dig(solution: string, rng: Rng, requested: Difficulty): string {
  const [low, high] = GIVEN_BANDS[requested]
  // A *random* stop point inside the band, not its ceiling. Stopping at `high`
  // every time made every easy puzzle a 40-given puzzle — technically in band,
  // and visibly the same shape twice in a row to anyone who plays two.
  const maxGivens = low + rng.int(high - low + 1)
  const ceiling = ORDER.indexOf(requested)
  const cells = parseGrid(solution)
  let givens = CELLS

  for (const index of rng.shuffle(Array.from({ length: CELLS }, (_u, i) => i))) {
    if (givens <= ABSOLUTE_MIN_GIVENS) break

    const saved = cells[index] as number
    cells[index] = EMPTY

    if (countSolutions(cells, 2) !== 1) {
      cells[index] = saved
      continue
    }

    const scored = grade(formatGrid(cells))
    if (scored === null || ORDER.indexOf(scored.difficulty) > ceiling) {
      cells[index] = saved
      continue
    }

    givens--
    if (scored.difficulty === requested && givens <= maxGivens) break
  }

  return formatGrid(cells)
}

/**
 * How many attempts before settling for the closest band we managed to hit.
 *
 * Sized for the *hard* band, which is the only one that regularly misses: a
 * puzzle that genuinely requires a pointing pair rather than merely permitting
 * one is uncommon, and roughly a quarter of hard digs come back medium. The
 * budget is affordable because §5 warms a background pool — generation is not
 * on the request path, so a rare 24-attempt dig costs a pool refill a few
 * hundred milliseconds and costs a player nothing.
 */
const MAX_ATTEMPTS = 24

/**
 * The dig floor, and the only given-count limit that actually binds.
 *
 * §1's per-difficulty given bands are a *description* of what each band tends
 * to produce, not a constraint to dig against — enforcing them as a floor stops
 * the dig before the requested technique is reached, which is how a "medium"
 * request comes back solvable by singles. The band's upper end still gates the
 * stopping condition; its lower end does not, and this number replaces it.
 *
 * 17 is the proven minimum for a unique 9×9 Sudoku. 20 keeps a margin, since
 * anything near the limit costs enormous search time for a puzzle no harder
 * than one with a few more givens.
 */
const ABSOLUTE_MIN_GIVENS = 20

const ORDER: readonly Difficulty[] = ['easy', 'medium', 'hard', 'expert']

function bandDistance(a: Difficulty, b: Difficulty): number {
  return Math.abs(ORDER.indexOf(a) - ORDER.indexOf(b))
}

/**
 * ★ A puzzle in the requested band.
 *
 * Generation is a rejection sampler: dig to the band's given count, grade the
 * result, keep it if the grade matches. Given count and technique difficulty
 * correlate but do not determine each other — that is the entire reason §5
 * grades by technique — so a miss is expected and cheap, and the loop simply
 * tries again with fresh randomness.
 *
 * **On exhausting the attempt budget it returns the closest miss rather than
 * throwing.** A thrown generator means a player pressing "new puzzle" gets an
 * error, which is a far worse outcome than an easy puzzle labelled medium; the
 * honest grade travels with the result in `graded`, so the caller can record
 * what was really produced instead of what was asked for. The alternative —
 * an unbounded loop — turns a rare miss into a hung request.
 */
export function generate(rng: Rng, requested: Difficulty): GeneratedPuzzle {
  let best: GeneratedPuzzle | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const solution = fullGrid(rng)
    const puzzle = dig(solution, rng, requested)

    const scored = grade(puzzle)
    if (scored === null) continue

    const candidate: GeneratedPuzzle = {
      puzzle,
      solution,
      requested,
      graded: scored.difficulty,
      hardest: scored.hardest,
      givens: countGivens(puzzle),
    }

    if (scored.difficulty === requested) return candidate

    if (
      best === null ||
      bandDistance(scored.difficulty, requested) < bandDistance(best.graded, requested)
    ) {
      best = candidate
    }
  }

  if (best === null) {
    throw new Error(`sudoku: could not generate a ${requested} puzzle in ${MAX_ATTEMPTS} attempts`)
  }
  return best
}

export function countGivens(puzzle: string): number {
  let n = 0
  for (let i = 0; i < CELLS; i++) if (puzzle.charCodeAt(i) !== 48) n++
  return n
}

/**
 * Candidate count for a cell, used by the digger's diagnostics and the tests.
 * Kept here rather than in `grid.ts` because it is about a *puzzle's* shape
 * rather than the board's geometry.
 */
export function clueSpread(puzzle: string): number {
  const cells = parseGrid(puzzle)
  let spread = 0
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] !== EMPTY) continue
    let mask = ALL_DIGITS_MASK
    for (const peer of PEERS_OF[i] as readonly number[]) {
      const d = cells[peer] as number
      if (d !== EMPTY) mask &= ~maskOf(d)
    }
    spread += popcount(mask)
  }
  return Math.round((spread / SIZE) * 10) / 10
}
