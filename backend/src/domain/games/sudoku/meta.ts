import { z } from 'zod'
import type { GameMeta } from '../GameEngine.js'

/**
 * Sudoku — M1. `games/sudoku.md` §7 for the options, §12 for the timings.
 *
 * The one game with **no turn limit**: a puzzle has no turns, so 04 §6.1 gives
 * it a match-long idle timer instead. `turnTimeoutMs: null` is that statement,
 * and the session service reads it as "arm nothing".
 */
export const sudokuOptionsSchema = z
  .object({
    difficulty: z.enum(['easy', 'medium', 'hard', 'expert']).default('medium'),
    mode: z.enum(['solo', 'race']).default('solo'),
    maxHints: z.number().int().min(0).max(10).default(3),
    allowNotes: z.boolean().default(true),
    autoCheckOnComplete: z.boolean().default(true),
    raceFinishWindowSec: z.number().int().min(0).max(300).default(60),
  })
  .strict()

export const sudokuMeta: GameMeta = {
  slug: 'sudoku',
  minPlayers: 1,
  maxPlayers: 4,
  /** Solo, plus race mode's 2–4 (`games/sudoku.md` §6). */
  playableCounts: [1, 2, 3, 4],

  optionsSchema: sudokuOptionsSchema,
  defaultOptions: sudokuOptionsSchema.parse({}),

  comingSoon: true,
  preview: {
    nameKey: 'games.sudoku.name',
    taglineKey: 'games.sudoku.tagline',
    complexity: 'light',
    avgMinutes: [5, 20],
    art: '/art/games/sudoku.svg',
    hasHiddenInfo: false,
    usesStandardDeck: false,
  },

  turnTimeoutMs: null,
  /** ∞ in solo; 60 s in race, after which the seat is marked abandoned (§12). */
  disconnectGraceMs: 60_000,
  reclaimAt: 'IMMEDIATE',

  defaultActionOnTimeout: () => null,

  supportsSpectators: true,
  supportsBots: false,

  matchmaking: {
    enabled: true,
    // Three presets rather than one with a difficulty option: the pool key is
    // the preset id, so "race" and "race on hard" have to be different buckets
    // or a player gets a puzzle they did not queue for (09 §2).
    presets: [
      {
        id: 'sudoku-race-2-easy',
        nameKey: 'matchmaking.presets.sudokuRaceEasy',
        seatCount: 2,
        options: { mode: 'race', difficulty: 'easy' },
        preferHumansMs: 20_000,
      },
      {
        id: 'sudoku-race-2-medium',
        nameKey: 'matchmaking.presets.sudokuRaceMedium',
        seatCount: 2,
        options: { mode: 'race', difficulty: 'medium' },
        preferHumansMs: 20_000,
      },
      {
        id: 'sudoku-race-2-hard',
        nameKey: 'matchmaking.presets.sudokuRaceHard',
        seatCount: 2,
        options: { mode: 'race', difficulty: 'hard' },
        preferHumansMs: 20_000,
      },
    ],
  },
}
