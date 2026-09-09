import { z } from 'zod'
import type { GameMeta } from './GameEngine.js'

/**
 * A Zod schema over `GameMeta` itself — 11-build-plan.md S17.
 *
 * TypeScript already checks the *shape*; this checks the things a type cannot:
 * that `playableCounts` sits inside `[minPlayers..maxPlayers]`, that the
 * preview carries i18n **keys** rather than English, that a matchmaking preset
 * declares a seat count the game can actually seat.
 *
 * The registry runs it over every entry at construction, so a malformed catalog
 * fails at boot with a readable message instead of surfacing as an empty
 * welcome page (P7 — fail fast at the boundary, and the catalog is one).
 */

/**
 * Anything localisable must be a dotted key, never a rendered sentence: the
 * client owns language (02 §8.1). `games.shelem.name` passes; `Shelem` does
 * not, and neither does a key with a space in it.
 */
const I18nKeySchema = z
  .string()
  .min(3)
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+)+$/, 'must be a dotted i18n key, not literal text')

const PreviewSchema = z
  .object({
    nameKey: I18nKeySchema,
    taglineKey: I18nKeySchema,
    complexity: z.enum(['light', 'medium', 'heavy']),
    avgMinutes: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    art: z.string().min(1),
    hasHiddenInfo: z.boolean(),
    usesStandardDeck: z.boolean(),
  })
  .strict()

const PresetSchema = z
  .object({
    id: z.string().min(3),
    nameKey: I18nKeySchema,
    seatCount: z.number().int().positive(),
    options: z.record(z.unknown()),
    preferHumansMs: z.number().int().nonnegative(),
  })
  .strict()

const zodSchema = z.custom<z.ZodTypeAny>(
  (value) => typeof value === 'object' && value !== null && 'safeParse' in value,
  'must be a Zod schema',
)

export const GameMetaSchema = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(32)
      .regex(/^[a-z][a-z0-9-]*$/, 'slug must be lower-kebab-case'),
    minPlayers: z.number().int().positive(),
    maxPlayers: z.number().int().positive(),
    playableCounts: z.array(z.number().int().positive()).min(1),
    teams: z
      .object({ size: z.number().int().positive(), count: z.number().int().positive() })
      .strict()
      .optional(),

    optionsSchema: zodSchema,
    defaultOptions: z.record(z.unknown()),

    comingSoon: z.boolean(),
    preview: PreviewSchema,

    turnTimeoutMs: z.number().int().positive().nullable(),
    turnTimeoutByPhaseMs: z.record(z.number().int().positive()).optional(),
    defaultActionOnTimeout: z.function(),

    disconnectGraceMs: z.number().int().nonnegative(),
    reclaimAt: z.enum(['IMMEDIATE', 'HAND_BOUNDARY', 'NEVER']),

    supportsSpectators: z.boolean(),
    supportsBots: z.boolean(),

    matchmaking: z.object({ enabled: z.boolean(), presets: z.array(PresetSchema) }).strict(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    if (meta.minPlayers > meta.maxPlayers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minPlayers'],
        message: `minPlayers ${meta.minPlayers} exceeds maxPlayers ${meta.maxPlayers}`,
      })
    }

    // The property S17 asks for by name: a count offered to a player must be a
    // count the engine can seat.
    for (const count of meta.playableCounts) {
      if (count < meta.minPlayers || count > meta.maxPlayers) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['playableCounts'],
          message: `${count} is outside [${meta.minPlayers}..${meta.maxPlayers}]`,
        })
      }
    }

    const [low, high] = meta.preview.avgMinutes
    if (low > high) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preview', 'avgMinutes'],
        message: `avgMinutes is reversed: [${low}, ${high}]`,
      })
    }

    for (const [index, preset] of meta.matchmaking.presets.entries()) {
      if (!meta.playableCounts.includes(preset.seatCount)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['matchmaking', 'presets', index, 'seatCount'],
          message: `preset ${preset.id} forms ${preset.seatCount} seats, which is not playable`,
        })
      }

      // A preset's options are a fixed literal (09 §2) and are what a queued
      // player actually plays, so they must satisfy the game's own schema.
      const parsed = meta.optionsSchema.safeParse(preset.options)
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['matchmaking', 'presets', index, 'options'],
          message: `preset ${preset.id} options fail optionsSchema: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join(', ')}`,
        })
      }
    }

    if (!meta.optionsSchema.safeParse(meta.defaultOptions).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultOptions'],
        message: 'defaultOptions do not satisfy optionsSchema',
      })
    }
  })

/** Throws a `ZodError` naming the offending slug. Called by the registry at construction. */
export function assertValidMeta(meta: GameMeta): GameMeta {
  const result = GameMetaSchema.safeParse(meta)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new TypeError(`GameMeta for '${meta.slug}' is malformed:\n${detail}`)
  }
  return meta
}
