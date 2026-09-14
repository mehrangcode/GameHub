import { z } from 'zod'
import {
  AnimationSpeedSchema,
  LocaleSchema,
  NumeralSystemSchema,
  ThemeSchema,
} from '../enums.js'

/**
 * The preferences wire shapes — 03 §3.1 `UserPreferences`, 06 §3.5.
 *
 * These are **display and convenience settings only**, and the distinction is
 * load-bearing: `showLegalMoveHints` decides whether the client *draws* the
 * hints, never whether the server sends `legalMoves` or what `applyMove`
 * enforces. A preference that could change what is legal would be a rules
 * engine in the client wearing a settings page.
 *
 * Guests have no row here. Their choices live in `localStorage` and are carried
 * into the account by the claim transaction (03 §6.1 step 3), which is why
 * `preferencesFromGuest` exists and why this schema's field names match it.
 */

const VolumeSchema = z.number().int().min(0).max(100)

/** A cosmetic id, or `null` for "the default". Ownership is checked at M2. */
const CosmeticIdSchema = z.string().trim().min(1).max(64).nullable()

export const PreferencesResponseSchema = z.object({
  theme: ThemeSchema,
  locale: LocaleSchema,
  numeralSystem: NumeralSystemSchema,
  cardBackId: CosmeticIdSchema,
  cardFaceId: CosmeticIdSchema,
  feltId: CosmeticIdSchema,
  animationSpeed: AnimationSpeedSchema,
  soundEnabled: z.boolean(),
  soundVolume: VolumeSchema,
  showLegalMoveHints: z.boolean(),
  reducedMotion: z.boolean(),
  /** ISO 8601. Lets a second tab notice it is holding stale settings. */
  updatedAt: z.string(),
})

export type PreferencesResponse = z.infer<typeof PreferencesResponseSchema>

/**
 * Every field optional — the customization page debounce-persists one setting
 * at a time (06 §6.2), and sending the whole object to change the felt would
 * make two tabs overwrite each other's unrelated choices.
 *
 * `.strict()` and a non-empty check for the same reason `PatchTableRequest` has
 * them: a typo'd field name should be a 400 during development, not a setting
 * that silently never saved.
 */
export const UpdatePreferencesRequestSchema = z
  .object({
    theme: ThemeSchema.optional(),
    locale: LocaleSchema.optional(),
    numeralSystem: NumeralSystemSchema.optional(),
    cardBackId: CosmeticIdSchema.optional(),
    cardFaceId: CosmeticIdSchema.optional(),
    feltId: CosmeticIdSchema.optional(),
    animationSpeed: AnimationSpeedSchema.optional(),
    soundEnabled: z.boolean().optional(),
    soundVolume: VolumeSchema.optional(),
    showLegalMoveHints: z.boolean().optional(),
    reducedMotion: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'errors.emptyPatch')

export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>

/**
 * What a client falls back to before `GET /me/preferences` answers, and what a
 * guest uses for its whole session. Hand-written rather than
 * `Schema.parse({})` because `contracts/` declares and never executes — the
 * same rule that moved `DEFAULT_TURN_ENFORCEMENT` here as a literal.
 *
 * Matches the Prisma column defaults; a test pins the two together.
 */
export const DEFAULT_PREFERENCES = {
  theme: 'system',
  locale: 'en',
  numeralSystem: 'auto',
  cardBackId: null,
  cardFaceId: null,
  feltId: null,
  animationSpeed: 'normal',
  soundEnabled: true,
  soundVolume: 70,
  showLegalMoveHints: true,
  reducedMotion: false,
} as const satisfies Omit<PreferencesResponse, 'updatedAt'>
