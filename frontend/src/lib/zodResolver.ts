import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form'
import type { ZodIssue, ZodType } from 'zod'
import { I18N_KEY_PREFIX, ZOD_FALLBACK_KEY, ZOD_ISSUE_KEYS } from '@/contracts/validation'
import { translateServerKey } from '@/i18n'

/**
 * ★ A Zod resolver whose messages are **localized**, not Zod's English.
 *
 * The forms validate with the same schemas the backend does — that is the point
 * of the shared `contracts/` mirror — but Zod's own messages ("String must
 * contain at least 10 character(s)") are untranslatable prose, and putting one
 * in front of a Persian reader is the exact failure the `code` + `i18nKey`
 * contract exists to prevent.
 *
 * So every issue is mapped through the **same table the server uses**
 * (`contracts/validation.ts`) and rendered through the same i18n bundle. A
 * password rejected in the browser and the same password rejected by the API
 * now produce the identical sentence — which is what stops the "it said
 * something different last time" class of bug report.
 *
 * Hand-written rather than configuring `@hookform/resolvers`' error map,
 * because the mapping is four lines and the alternative hides the one thing
 * this file exists to guarantee.
 */
export function localizedZodResolver<T extends FieldValues>(schema: ZodType<T>): Resolver<T> {
  return (values) => {
    const result = schema.safeParse(values)
    if (result.success) return Promise.resolve({ values: result.data, errors: {} })

    const errors: Record<string, { type: string; message: string }> = {}

    for (const issue of result.error.issues) {
      // An `unrecognized_keys` issue has an empty path and names its keys
      // instead — same shape the server handles, for the same reason.
      const paths =
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => [...issue.path, key].join('.'))
          : [issue.path.join('.')]

      for (const path of paths) {
        // First issue per field wins: showing three messages under one input
        // tells the reader less than showing the first.
        if (path === '' || errors[path] !== undefined) continue
        errors[path] = { type: issue.code, message: messageForIssue(issue) }
      }
    }

    return Promise.resolve({ values: {}, errors: errors as FieldErrors<T> })
  }
}

/** Zod issue → the key the server would have sent for it. */
export function keyForIssue(issue: ZodIssue): string {
  if (issue.message.startsWith(I18N_KEY_PREFIX)) return issue.message
  return ZOD_ISSUE_KEYS[issue.code] ?? ZOD_FALLBACK_KEY
}

/** Zod issue → a rendered, localized sentence. */
export function messageForIssue(issue: ZodIssue): string {
  return translateServerKey(keyForIssue(issue))
}
