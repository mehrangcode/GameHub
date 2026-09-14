import type { ZodError } from 'zod'
import {
  I18N_KEY_PREFIX,
  ZOD_FALLBACK_KEY,
  ZOD_ISSUE_KEYS,
} from '../../contracts/validation.js'

/**
 * Zod issue → `fieldErrors`, shared by the REST boundary and the socket
 * boundary — S12, extended in S23.
 *
 * Extracted the moment there were two callers, and for the usual reason: two
 * copies of a key table drift, and the one that drifts is the one somebody
 * forgets to update. A player would then see `errors.field.tooBig` on a form
 * and an untranslated `too_big` from a socket ack, which is exactly the kind of
 * inconsistency nobody reproduces on purpose.
 *
 * **`fieldErrors` may never carry a rendered English sentence.** Zod's defaults
 * ("Expected number, received string") are exactly that, and shipping one would
 * put untranslatable prose in front of a Persian-speaking reader — the failure
 * the whole `code` + `i18nKey` contract exists to prevent. Zod's own wording is
 * genuinely useful and stays in the logged message.
 */
/**
 * The table moved to `contracts/validation.ts` at S39, so the browser's login
 * and register forms — which validate with the *same schemas* — render the
 * *same* message the server would for the same input. Re-exported here because
 * this is where every existing caller looks for it.
 */
export const ISSUE_KEYS = ZOD_ISSUE_KEYS

/**
 * A schema's own message wins when it already *is* a key — that is how
 * `errors.passwordTooShort` reaches the form instead of a generic "too small".
 */
export function i18nKeyFor(issue: ZodError['issues'][number]): string {
  if (issue.message.startsWith(I18N_KEY_PREFIX)) return issue.message
  return ZOD_ISSUE_KEYS[issue.code] ?? ZOD_FALLBACK_KEY
}

export interface CollectOptions {
  /** Prefixes every path — `query.limit` — so two sources cannot collide. */
  readonly prefix?: string
  /** Receives Zod's own English, for the log line. */
  readonly prose?: string[]
}

/**
 * Fills `into` with `path → [i18nKey, …]`.
 *
 * An unrecognised key has an **empty path**, so its keys are named individually
 * rather than all being filed under the object itself — otherwise "you sent
 * `userId`, which does not exist here" renders as an error on the whole form.
 */
export function collectZodIssues(
  error: ZodError,
  into: Record<string, string[]>,
  options: CollectOptions = {},
): Record<string, string[]> {
  const prefix = options.prefix === undefined ? '' : `${options.prefix}.`

  for (const issue of error.issues) {
    options.prose?.push(`${prefix}${issue.path.join('.') || '(root)'}: ${issue.message}`)

    const paths =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key].join('.'))
        : [issue.path.join('.')]

    for (const path of paths) {
      ;(into[`${prefix}${path || '_'}`] ??= []).push(i18nKeyFor(issue))
    }
  }

  return into
}

/** The one-source convenience the socket boundary uses. */
export function zodFieldErrors(error: ZodError): Record<string, string[]> {
  return collectZodIssues(error, {})
}
