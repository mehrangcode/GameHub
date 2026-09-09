import { z } from 'zod'
import type { GameMeta } from '../GameEngine.js'

/**
 * Blackjack — M2. `games/blackjack.md` §9 for the options, §10 for the timings.
 *
 * `minBet`/`maxBet`/`startingChips` are **table chips**, not wallet coins (E5,
 * P9). They are ephemeral per-match tokens with no ledger relationship — the
 * lint guard on `domain/games/**` exists so that stays true.
 */
export const blackjackOptionsSchema = z
  .object({
    decks: z
      .union([z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8)])
      .default(6),
    penetration: z.number().min(0.5).max(0.9).default(0.75),
    dealerHitsSoft17: z.boolean().default(false),
    blackjackPays: z.enum(['3:2', '6:5']).default('3:2'),
    doubleRule: z.enum(['any2', '9to11']).default('any2'),
    doubleAfterSplit: z.boolean().default(true),
    maxSplits: z.number().int().min(0).max(3).default(3),
    splitOn: z.enum(['value', 'rank']).default('value'),
    resplitAces: z.boolean().default(false),
    insurance: z.boolean().default(true),
    lateSurrender: z.boolean().default(true),
    dealerPeek: z.boolean().default(true),
    minBet: z.number().int().min(2).default(10),
    maxBet: z.number().int().default(500),
    startingChips: z.number().int().default(1000),
    betTimeoutSec: z.number().int().min(10).max(120).default(30),
    actionTimeoutSec: z.number().int().min(10).max(120).default(30),
  })
  .strict()

export const blackjackMeta: GameMeta = {
  slug: 'blackjack',
  minPlayers: 1,
  maxPlayers: 5,
  playableCounts: [1, 2, 3, 4, 5],

  optionsSchema: blackjackOptionsSchema,
  defaultOptions: blackjackOptionsSchema.parse({}),

  comingSoon: true,
  preview: {
    nameKey: 'games.blackjack.name',
    taglineKey: 'games.blackjack.tagline',
    complexity: 'light',
    avgMinutes: [5, 15],
    art: '/art/games/blackjack.svg',
    hasHiddenInfo: true,
    usesStandardDeck: true,
  },

  turnTimeoutMs: 30_000,
  turnTimeoutByPhaseMs: { BETTING: 30_000, PLAYER_TURNS: 30_000 },
  disconnectGraceMs: 45_000,
  /** 120 s, at the next round boundary — a mid-hand handover is jarring (§10). */
  reclaimAt: 'HAND_BOUNDARY',

  /**
   * Stand. The only safe automatic action: hitting can bust the hand the
   * player was holding, and doubling or insuring spends chips they never
   * authorized (04 §6.5). Wired to a real move object in M2.
   */
  defaultActionOnTimeout: () => null,

  supportsSpectators: true,
  supportsBots: true,

  matchmaking: {
    enabled: true,
    presets: [
      {
        id: 'blackjack-standard-3',
        nameKey: 'matchmaking.presets.blackjackStandard3',
        seatCount: 3,
        options: {},
        preferHumansMs: 20_000,
      },
      {
        id: 'blackjack-standard-5',
        nameKey: 'matchmaking.presets.blackjackStandard5',
        seatCount: 5,
        options: {},
        preferHumansMs: 30_000,
      },
    ],
  },
}
