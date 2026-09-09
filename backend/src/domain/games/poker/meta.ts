import { z } from 'zod'
import type { GameMeta } from '../GameEngine.js'

/**
 * Poker — No-Limit Texas Hold'em, M5. `games/poker-holdem.md` §8 options, §9
 * timings.
 *
 * Cash-game structure only; blind escalation is deliberately out of scope.
 * `smallBlind`/`bigBlind`/`startingStack` are **table chips** (E5, P9) — no
 * wallet, no ledger, no cash-out. That boundary is what keeps this a card game.
 *
 * The `timeBankSec` one-shot is consumed automatically *before* a strike fires,
 * so a player thinking hard about an all-in is not treated as idle (04 §6.2).
 */
export const pokerOptionsSchema = z
  .object({
    smallBlind: z.number().int().min(1).default(5),
    bigBlind: z.number().int().min(2).default(10),
    startingStack: z.number().int().min(20).default(1000),
    maxSeats: z.number().int().min(2).max(6).default(6),
    allowRebuy: z.boolean().default(true),
    actionTimeoutSec: z.number().int().min(10).max(120).default(30),
    /** Extra one-shot time a player may spend on a hard decision. */
    timeBankSec: z.number().int().min(0).max(120).default(30),
    /** Must losers show? Default no. */
    showdownRevealMuck: z.boolean().default(false),
    runoutDelayMs: z.number().int().min(0).max(5000).default(1200),
    graceSec: z.number().int().min(15).max(120).default(45),
  })
  .strict()

export const pokerMeta: GameMeta = {
  slug: 'poker',
  minPlayers: 2,
  maxPlayers: 6,
  playableCounts: [2, 3, 4, 5, 6],

  optionsSchema: pokerOptionsSchema,
  defaultOptions: pokerOptionsSchema.parse({}),

  comingSoon: true,
  preview: {
    nameKey: 'games.poker.name',
    taglineKey: 'games.poker.tagline',
    complexity: 'heavy',
    avgMinutes: [20, 60],
    art: '/art/games/poker.svg',
    hasHiddenInfo: true,
    usesStandardDeck: true,
  },

  turnTimeoutMs: 30_000,
  disconnectGraceMs: 45_000,
  /** Next hand boundary: inheriting a bot's committed chips is unfair both ways (§9). */
  reclaimAt: 'HAND_BOUNDARY',

  /**
   * Check when checking is free, otherwise fold. Never call, never raise — a
   * default action must not spend chips the player did not commit (04 §6.5).
   * Wired to a real move object in M5.
   */
  defaultActionOnTimeout: () => null,

  supportsSpectators: true,
  supportsBots: true,

  matchmaking: {
    enabled: true,
    presets: [
      {
        id: 'poker-6max-blinds-5-10',
        nameKey: 'matchmaking.presets.poker6Max',
        seatCount: 6,
        options: { smallBlind: 5, bigBlind: 10, maxSeats: 6 },
        preferHumansMs: 45_000,
      },
      {
        id: 'poker-heads-up-5-10',
        nameKey: 'matchmaking.presets.pokerHeadsUp',
        seatCount: 2,
        options: { smallBlind: 5, bigBlind: 10, maxSeats: 2 },
        preferHumansMs: 20_000,
      },
    ],
  },
}
