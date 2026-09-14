import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { isApiError } from '@/api/client'
import type { ApiError } from '@/contracts/errors'
import { translateServerKey } from '@/i18n'

/**
 * Server errors → form state — 02 §5.6, S39.
 *
 * ★ Every message rendered from here is produced by {@link translateServerKey}
 * from the server's `i18nKey`. The server never sends English prose, so a
 * Persian user typing a taken email sees a Persian message from the same
 * payload an English user sees an English one from. Nothing here ever displays
 * a raw server string, and there is no code path that could.
 */

/** Falls back to the generic key for a value that is not an ApiError at all. */
export function messageOf(error: unknown): string {
  if (!isApiError(error)) return translateServerKey('errors.internal')
  return translateServerKey(error.i18nKey, error.details)
}

/**
 * Maps `fieldErrors` onto the right inputs, returning the errors it could not
 * place.
 *
 * A key the form has no field for — `EMAIL_TAKEN` arriving without
 * `fieldErrors`, or a nested `options.target` on a form that has no such input
 * — must still reach the user somewhere, so the caller renders the remainder
 * as a form-level message. Silently dropping them is how a form "does nothing"
 * when you press submit.
 */
export function applyFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
): { placed: number; formMessage: string | null } {
  if (!isApiError(error)) return { placed: 0, formMessage: messageOf(error) }

  let placed = 0
  const unplaced: string[] = []

  for (const [name, keys] of Object.entries(error.fieldErrors ?? {})) {
    const key = keys[0]
    if (key === undefined) continue

    if ((fields as readonly string[]).includes(name)) {
      setError(name as Path<T>, { type: 'server', message: translateServerKey(key) })
      placed += 1
    } else {
      unplaced.push(translateServerKey(key))
    }
  }

  // A coded error with no fieldErrors is the common case for EMAIL_TAKEN and
  // friends; route it to the field it is about when we can name one.
  if (placed === 0 && unplaced.length === 0) {
    const field = FIELD_FOR_CODE[error.code]
    if (field !== undefined && (fields as readonly string[]).includes(field)) {
      setError(field as Path<T>, { type: 'server', message: messageOf(error) })
      return { placed: 1, formMessage: null }
    }
    return { placed: 0, formMessage: messageOf(error) }
  }

  return {
    placed,
    formMessage: unplaced.length > 0 ? unplaced.join(' ') : null,
  }
}

/**
 * The codes that are unambiguously *about* one input. Kept small on purpose:
 * guessing which field a `FORBIDDEN` belongs to would put a red line under a
 * random box.
 */
const FIELD_FOR_CODE: Partial<Record<ApiError['code'], string>> = {
  EMAIL_TAKEN: 'email',
}
