import { z } from 'zod'

/**
 * The game catalog wire shapes — 02 §5 `/games`, 05 §5.
 *
 * **Everything localisable is an i18n key.** `nameKey: 'games.shelem.name'`,
 * never `name: 'Shelem'` — the client owns language (02 §8.1), and a Persian
 * reader must not receive an English game name the frontend cannot translate.
 * An integration test asserts the whole payload contains no literal English.
 *
 * These are the *wire* shapes, deliberately not `GameMeta` itself: the domain's
 * meta carries a live Zod schema and two functions, none of which survive
 * `JSON.stringify`. `application/mappers/games.ts` does the conversion, turning
 * `optionsSchema` into published JSON Schema on the way out.
 */

/**
 * A JSON Schema document, kept structurally open on purpose.
 *
 * Pinning the JSON Schema meta-schema in Zod would be a large, brittle type
 * that buys nothing: the client feeds this to a form renderer, and the *server*
 * remains the only thing that validates options.
 */
export const JsonSchemaSchema = z.record(z.unknown())
export type JsonSchema = z.infer<typeof JsonSchemaSchema>

export const GameComplexitySchema = z.enum(['light', 'medium', 'heavy'])
export type GameComplexity = z.infer<typeof GameComplexitySchema>

export const ReclaimPolicySchema = z.enum(['IMMEDIATE', 'HAND_BOUNDARY', 'NEVER'])
export type ReclaimPolicy = z.infer<typeof ReclaimPolicySchema>

export const GamePreviewSchema = z.object({
  nameKey: z.string(),
  taglineKey: z.string(),
  complexity: GameComplexitySchema,
  /** `[min, max]` minutes for a typical match. */
  avgMinutes: z.tuple([z.number(), z.number()]),
  art: z.string(),
  hasHiddenInfo: z.boolean(),
  usesStandardDeck: z.boolean(),
})

export type GamePreview = z.infer<typeof GamePreviewSchema>

/** One preview card on the welcome page. */
export const GameSummarySchema = z.object({
  slug: z.string(),
  /** Announced, not yet playable. The card renders greyed out and `POST /tables` refuses it. */
  comingSoon: z.boolean(),
  minPlayers: z.number().int(),
  maxPlayers: z.number().int(),
  /** The only counts a table may be created with. */
  playableCounts: z.array(z.number().int()),
  teams: z.object({ size: z.number().int(), count: z.number().int() }).nullable(),
  preview: GamePreviewSchema,
  /** `null` = untimed. Sudoku is a puzzle; chess's own clock is the limit. */
  turnTimeoutMs: z.number().int().nullable(),
  supportsSpectators: z.boolean(),
  supportsBots: z.boolean(),
  matchmakingEnabled: z.boolean(),
})

export type GameSummary = z.infer<typeof GameSummarySchema>

export const MatchmakingPresetSchema = z.object({
  id: z.string(),
  nameKey: z.string(),
  seatCount: z.number().int(),
  options: z.record(z.unknown()),
  preferHumansMs: z.number().int(),
})

export type MatchmakingPreset = z.infer<typeof MatchmakingPresetSchema>

/** `GET /games/:slug` — everything the table-creation form needs. */
export const GameDetailSchema = GameSummarySchema.extend({
  /** JSON Schema derived from the engine's own Zod `optionsSchema`. */
  optionsSchema: JsonSchemaSchema,
  defaultOptions: z.record(z.unknown()),
  turnTimeoutByPhaseMs: z.record(z.number().int()).nullable(),
  disconnectGraceMs: z.number().int(),
  reclaimAt: ReclaimPolicySchema,
  matchmakingPresets: z.array(MatchmakingPresetSchema),
})

export type GameDetail = z.infer<typeof GameDetailSchema>

/**
 * Loose on purpose. A tight slug pattern would answer `/games/NOPE!` with a
 * 400 while `/games/nope` got a 404, for no gain — the registry is the only
 * thing that knows which slugs exist, so let it give the one honest answer.
 */
export const GameSlugParamsSchema = z.object({ slug: z.string().min(1).max(64) })
export type GameSlugParams = z.infer<typeof GameSlugParamsSchema>
