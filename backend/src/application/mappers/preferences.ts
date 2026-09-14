import {
  DEFAULT_PREFERENCES,
  type PreferencesResponse,
} from '../../contracts/dto/preferences.js'
import {
  ANIMATION_SPEEDS,
  LOCALES,
  NUMERAL_SYSTEMS,
  THEMES,
  type Locale,
} from '../../contracts/enums.js'
import type { GuestSession, UserPreferences } from '../../domain/entities/user.js'

/**
 * `GuestSession.prefsJson` → a `UserPreferences` patch (03 §6.1 step 3).
 *
 * ★ **This is a whitelist, and it has to be.** `prefsJson` is a JSON column
 * whose contents were written by a client, and `IPreferencesRepository.upsert`
 * spreads its patch straight into a Prisma `upsert`. Passing the blob through
 * unfiltered would mean an unknown key crashes the claim transaction — and a
 * key that happened to match a *different* column would let a guest set it. So
 * every field is named here, every enumerated value is checked against
 * `contracts/enums.ts`, and anything else is dropped rather than rejected:
 * losing an unrecognised theme preference must never cost somebody their seat.
 *
 * What a guest chose before signing up is small but it is theirs — the dark
 * theme and the Persian numerals they picked on the invite landing page. Losing
 * them at the exact moment they commit to an account is a bad first impression
 * for no reason.
 */

const KNOWN_STRING_ENUMS = {
  theme: THEMES,
  locale: LOCALES,
  numeralSystem: NUMERAL_SYSTEMS,
  animationSpeed: ANIMATION_SPEEDS,
} as const

const KNOWN_NULLABLE_IDS = ['cardBackId', 'cardFaceId', 'feltId'] as const
const KNOWN_BOOLEANS = ['soundEnabled', 'showLegalMoveHints', 'reducedMotion'] as const

export function preferencesFromGuest(
  guest: Pick<GuestSession, 'prefs' | 'locale'>,
  localeOverride?: Locale,
): Partial<UserPreferences> {
  const patch: Record<string, unknown> = {}
  const source = guest.prefs ?? {}

  for (const [key, allowed] of Object.entries(KNOWN_STRING_ENUMS)) {
    const value = source[key]
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      patch[key] = value
    }
  }
  for (const key of KNOWN_NULLABLE_IDS) {
    const value = source[key]
    if (typeof value === 'string' || value === null) patch[key] = value
  }
  for (const key of KNOWN_BOOLEANS) {
    if (typeof source[key] === 'boolean') patch[key] = source[key]
  }
  if (typeof source.soundVolume === 'number' && Number.isFinite(source.soundVolume)) {
    patch.soundVolume = Math.min(100, Math.max(0, Math.trunc(source.soundVolume)))
  }

  // The session's own locale is the stronger signal than anything in the blob:
  // it is what the server has been answering them in. An explicit choice in the
  // sign-up form beats both.
  patch.locale = localeOverride ?? guest.locale

  return patch as Partial<UserPreferences>
}

/**
 * `UserPreferences` → the wire shape — S40.
 *
 * A `null` row is a user who has never changed a setting, which is a valid
 * state the repository documents. Answering with the defaults rather than a
 * 404 means a brand-new account's settings page renders instead of erroring,
 * and `updatedAt` is the epoch so a client can tell "never saved" from "saved
 * long ago" without a nullable field.
 *
 * `extra` is deliberately not published. It is migration headroom (03 §3.1),
 * not a bag of settings for clients to discover — anything a client should read
 * gets a named column and a contract field.
 */
export function toPreferencesResponse(row: UserPreferences | null): PreferencesResponse {
  if (row === null) {
    return { ...DEFAULT_PREFERENCES, updatedAt: new Date(0).toISOString() }
  }

  return {
    theme: row.theme,
    locale: row.locale,
    numeralSystem: row.numeralSystem,
    cardBackId: row.cardBackId,
    cardFaceId: row.cardFaceId,
    feltId: row.feltId,
    animationSpeed: row.animationSpeed,
    soundEnabled: row.soundEnabled,
    soundVolume: row.soundVolume,
    showLegalMoveHints: row.showLegalMoveHints,
    reducedMotion: row.reducedMotion,
    updatedAt: row.updatedAt.toISOString(),
  }
}
