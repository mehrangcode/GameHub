import { ValidationError } from '../../domain/errors/errors.js'

/**
 * Display-name policy — S16, 07 §5.1.
 *
 * Shape rules (length, no control characters) live in `contracts/dto/auth.ts`
 * so the sign-up form enforces them too. **Semantic** rules live here, and
 * deliberately do not ship to the browser: a blocklist in the client bundle is
 * both a bypass hint and a published list of slurs.
 *
 * The primary purpose is not politeness — it is **impersonation**. A guest who
 * calls themselves "Host" or "Admin" in a table of five friends can talk
 * someone out of a seat, and no amount of server authority helps, because the
 * lie happens in the chat window.
 */

/**
 * Names nobody may take. Matched after normalisation, so `H0st`, `A d m i n`
 * and `ADMlN` all collapse onto the same entry.
 */
export const RESERVED_DISPLAY_NAMES: readonly string[] = [
  'host',
  'admin',
  'admins',
  'administrator',
  'moderator',
  'mod',
  'support',
  'staff',
  'system',
  'server',
  'official',
  'bot',
  'dealer',
  'root',
  'anonymous',
  'guest',
  // Persian equivalents — the UI is bilingual, so the reserved set has to be.
  'مدیر',
  'ادمین',
  'میزبان',
  'پشتیبانی',
  'سیستم',
]

/**
 * A deliberately short profanity list, kept in one reviewable place rather than
 * pulled from a dependency that ships tens of thousands of entries and blocks
 * "Scunthorpe". Substring matching on a long list produces more false positives
 * than it prevents abuse; the real defence against a determined name is the
 * report flow (09 §8) plus an admin rename (12 §3).
 *
 * > **Open question:** the Persian entries need a native-speaker pass before
 * > M0 ships. Under-blocking is the safe direction for now.
 */
export const BLOCKED_SUBSTRINGS: readonly string[] = [
  'fuck',
  'shit',
  'cunt',
  'nigger',
  'faggot',
  'rape',
]

/**
 * Collapses the tricks used to slip past an exact-match list: case, spacing,
 * punctuation, and the common digit-for-letter substitutions.
 *
 * Note `i`, `l`, `1`, `|` and `!` all fold onto **one** letter rather than
 * being mapped individually. `Adm1n` could be reaching for `admin` or `admln`
 * and it does not matter which — folding the whole confusable group makes both
 * land on the same entry. It over-matches slightly (`will` → `wiii`), which
 * costs nothing: the comparison list is normalised the same way, so only names
 * that collide *with a reserved word* are affected.
 */
export function normalizeDisplayName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/[1l|!]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * @throws {ValidationError} with `displayName` in `fieldErrors` — the shape the
 * form binds to, carrying an `i18nKey` rather than an English sentence.
 */
export function assertDisplayNameAllowed(displayName: string): void {
  const normalized = normalizeDisplayName(displayName)

  if (normalized.length === 0) {
    throw reject('errors.displayNameInvalid')
  }
  if (RESERVED_DISPLAY_NAMES.some((reserved) => normalized === normalizeDisplayName(reserved))) {
    throw reject('errors.displayNameReserved')
  }
  if (BLOCKED_SUBSTRINGS.some((blocked) => normalized.includes(normalizeDisplayName(blocked)))) {
    throw reject('errors.displayNameBlocked')
  }
}

function reject(i18nKey: string): ValidationError {
  return new ValidationError('Display name is not allowed', { displayName: [i18nKey] })
}
