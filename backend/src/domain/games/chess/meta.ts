import { z } from 'zod'
import type { GameMeta } from '../GameEngine.js'

/**
 * Chess — M6. `games/chess.md` §7 options, §8 disconnects.
 *
 * **The one game with no turn-timeout ejection.** The player's own clock *is*
 * the turn limit (04 §6.1), so `turnTimeoutMs` is `null` and flag-fall ends the
 * game the way it does at a physical board — nobody is removed, nobody is
 * bot-substituted, and there is nothing to forfeit.
 *
 * `whiteSeat: 'random'` is chess's only use of the RNG. Seeded, so a replay
 * assigns the same colours.
 */
export const chessOptionsSchema = z
  .object({
    /** 0 = untimed. */
    baseMinutes: z.number().int().min(0).max(180).default(10),
    incrementSeconds: z.number().int().min(0).max(60).default(5),
    whiteSeat: z.union([z.literal(0), z.literal(1), z.literal('random')]).default('random'),
    takebacksAllowed: z.boolean().default(false),
    /** false = a threefold repetition must be claimed. */
    autoDrawThreefold: z.boolean().default(true),
    /** Display only. The server always sends `legalMoves`; this changes nothing. */
    showLegalMoveHints: z.boolean().default(true),
    /** 0 = the clock is the grace. */
    graceSec: z.number().int().min(0).max(120).default(0),
  })
  .strict()

export const chessMeta: GameMeta = {
  slug: 'chess',
  minPlayers: 2,
  maxPlayers: 2,
  playableCounts: [2],

  optionsSchema: chessOptionsSchema,
  defaultOptions: chessOptionsSchema.parse({}),

  comingSoon: true,
  preview: {
    nameKey: 'games.chess.name',
    taglineKey: 'games.chess.tagline',
    complexity: 'heavy',
    avgMinutes: [10, 40],
    art: '/art/games/chess.svg',
    hasHiddenInfo: false,
    usesStandardDeck: false,
  },

  /** The clock is the limit. Never arm a turn timer for chess. */
  turnTimeoutMs: null,
  /**
   * Zero, and deliberately: in a timed game a disconnected player's clock keeps
   * running, which is the correct punishment and needs no grace window. An
   * untimed table's 120 s grace is decided per-game from `graceSec` (§8).
   */
  disconnectGraceMs: 0,
  reclaimAt: 'NEVER',

  defaultActionOnTimeout: () => null,

  supportsSpectators: true,
  supportsBots: true,

  matchmaking: {
    enabled: true,
    presets: [
      {
        id: 'chess-bullet-1-0',
        nameKey: 'matchmaking.presets.chessBullet',
        seatCount: 2,
        options: { baseMinutes: 1, incrementSeconds: 0 },
        preferHumansMs: 15_000,
      },
      {
        id: 'chess-blitz-5-3',
        nameKey: 'matchmaking.presets.chessBlitz',
        seatCount: 2,
        options: { baseMinutes: 5, incrementSeconds: 3 },
        preferHumansMs: 20_000,
      },
      {
        id: 'chess-rapid-10-5',
        nameKey: 'matchmaking.presets.chessRapid',
        seatCount: 2,
        options: { baseMinutes: 10, incrementSeconds: 5 },
        preferHumansMs: 30_000,
      },
    ],
  },
}
