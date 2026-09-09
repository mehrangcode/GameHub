import { z } from 'zod'
import type { GameMeta } from '../GameEngine.js'

/**
 * ⭐ Shelem — M4, the flagship. `games/shelem.md` §7 options, §8 timings.
 *
 * The `[C##]` markers tie each option back to that document's §0 sourcing
 * table: a ✅ option is a **sourced default** and should not be changed
 * casually; `matchTarget`, `sarShelemEnabled` and `lastTrickBonus` are
 * best guesses awaiting a real match (§0.4, still open).
 *
 * Four seats, two partnerships, teams by seat parity.
 */
export const shelemOptionsSchema = z
  .object({
    // ── scoring ──
    pointValues: z.enum(['standard', 'aces15']).default('standard'), // C1
    minBid: z.number().int().min(50).max(165).default(100), // C3 ✅
    bidIncrement: z.number().int().min(5).max(10).default(5), // C4 ✅
    contractMadeScoring: z.enum(['collected', 'bid']).default('collected'), // C7 ✅
    setPenaltyDoubleWhen: z
      .enum(['lessThanOpponents', 'lessThanHalfBid', 'never'])
      .default('lessThanOpponents'), // C8 ✅
    shelemScoring: z.enum(['flat330', 'doubleBid']).default('flat330'), // C10 ✅
    trickPoints: z.number().int().min(0).max(10).default(5), // C1 ✅
    discardCountsAsTrick: z.boolean().default(true), // §0.3
    lastTrickBonus: z.number().int().min(0).max(25).default(0), // C12
    sarShelemEnabled: z.boolean().default(false), // C11 — unsourced
    sarShelemValue: z.number().int().default(660), // C11
    matchTarget: z.number().int().min(200).max(3000).default(1165), // C13 — unsourced

    // ── play variants ──
    mustTrumpIfVoid: z.boolean().default(false),
    allowPointCardsInDiscard: z.boolean().default(true), // C15
    allPassBehaviour: z.enum(['redeal', 'forcedDealerBid']).default('redeal'), // C17

    // ── timing ──
    bidTimeoutSec: z.number().int().min(15).max(120).default(45),
    playTimeoutSec: z.number().int().min(15).max(120).default(30),
    graceSec: z.number().int().min(30).max(300).default(90),
  })
  .strict()

export const shelemMeta: GameMeta = {
  slug: 'shelem',
  minPlayers: 4,
  maxPlayers: 4,
  playableCounts: [4],
  teams: { size: 2, count: 2 },

  optionsSchema: shelemOptionsSchema,
  defaultOptions: shelemOptionsSchema.parse({}),

  comingSoon: true,
  preview: {
    nameKey: 'games.shelem.name',
    taglineKey: 'games.shelem.tagline',
    complexity: 'heavy',
    avgMinutes: [30, 60],
    art: '/art/games/shelem.svg',
    hasHiddenInfo: true,
    usesStandardDeck: true,
  },

  turnTimeoutMs: 30_000,
  /** Bidding genuinely needs longer thought than following suit (04 §6.1). */
  turnTimeoutByPhaseMs: { BIDDING: 45_000, TRICK_PLAY: 30_000 },
  /** Generous: a four-player partnership match is ruined by a forfeit (§8). */
  disconnectGraceMs: 90_000,
  /** Mid-trick — a Shelem hand is long, and a boundary could bench someone for five minutes. */
  reclaimAt: 'IMMEDIATE',

  /** Lowest legal card of the led suit. Implemented with the engine in M4. */
  defaultActionOnTimeout: () => null,

  supportsSpectators: true,
  supportsBots: true,

  matchmaking: {
    enabled: true,
    presets: [
      {
        id: 'shelem-standard-1000',
        nameKey: 'matchmaking.presets.shelemStandard',
        seatCount: 4,
        // The default rule set only. Fifteen options in the pool key would mean
        // two players who disagreed about `bidTimeoutSec` never meeting (09 §2).
        options: {},
        preferHumansMs: 45_000,
      },
    ],
  },
}
