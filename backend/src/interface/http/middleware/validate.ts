import type { Request, RequestHandler } from 'express'
import type { ZodType, ZodError } from 'zod'
import { InternalError, ValidationError } from '../../../domain/errors/errors.js'

/**
 * The boundary parser — 02 §7, P7.
 *
 * Every inbound body, query and params object is parsed by a Zod schema before
 * a controller sees it, and the *parsed output* is what the controller reads.
 * Three properties this buys, all of which matter more than they sound:
 *
 *   1. **No silent coercion.** `{"n": "5"}` where a number is required is a
 *      400, not a `5`. A coercing boundary means a client bug becomes a
 *      server-side type confusion three layers down.
 *   2. **No unknown keys.** Request schemas are `.strict()`, so a typo'd field
 *      name fails during development instead of becoming a setting that
 *      silently never applied.
 *   3. **Field-level errors.** The response carries `fieldErrors`, which is the
 *      shape a form renders directly — with `i18nKey`s, never English prose.
 */

export interface ValidationSchemas {
  readonly body?: ZodType
  readonly query?: ZodType
  readonly params?: ZodType
}

type Source = keyof ValidationSchemas

export function zodValidate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const fieldErrors: Record<string, string[]> = {}
    const prose: string[] = []
    const validated: { body?: unknown; query?: unknown; params?: unknown } = {}

    for (const source of ['body', 'query', 'params'] as const) {
      const schema = schemas[source]
      if (!schema) continue

      const result = schema.safeParse(req[source])
      if (result.success) {
        validated[source] = result.data
      } else {
        collectIssues(result.error, source, fieldErrors, prose)
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      // The English detail goes in `message`, which is logged and never sent.
      next(new ValidationError(`Request failed validation: ${prose.join('; ')}`, fieldErrors))
      return
    }

    req.validated = validated
    // `body` is a plain property, so handing controllers the parsed value there
    // too keeps existing Express idioms working. `query` and `params` are
    // getters in Express 5 and are deliberately left alone — read them through
    // `validQuery`/`validParams`.
    if ('body' in validated) req.body = validated.body
    next()
  }
}

/**
 * Zod issue code → i18n key.
 *
 * **`fieldErrors` may never carry a rendered English sentence.** Zod's defaults
 * ("Expected number, received string") are exactly that, and shipping them
 * would put untranslatable prose in front of a Persian-speaking user — the one
 * failure the whole `code` + `i18nKey` error contract exists to prevent. A
 * schema that wants a more specific key says so in its own message (see
 * `PasswordSchema`); everything else lands on one of these.
 */
const ISSUE_KEYS: Record<string, string> = {
  invalid_type: 'errors.field.invalidType',
  invalid_literal: 'errors.field.invalidValue',
  invalid_enum_value: 'errors.field.invalidOption',
  invalid_union: 'errors.field.invalidValue',
  invalid_union_discriminator: 'errors.field.invalidOption',
  invalid_string: 'errors.field.invalidFormat',
  invalid_date: 'errors.field.invalidDate',
  too_small: 'errors.field.tooSmall',
  too_big: 'errors.field.tooBig',
  not_multiple_of: 'errors.field.invalidValue',
  unrecognized_keys: 'errors.field.unknownKey',
  custom: 'errors.field.invalid',
}

/**
 * `email: ['errors.field.invalidFormat']` for a body field, `query.limit: [...]`
 * for anything else — a form binds to the bare name, and the prefix stops a
 * `limit` in the query from colliding with a `limit` in the body.
 *
 * `prose` collects Zod's own wording for the log line. It is genuinely useful
 * when debugging a schema, and it stays on the server.
 */
function collectIssues(
  error: ZodError,
  source: Source,
  into: Record<string, string[]>,
  prose: string[],
): void {
  for (const issue of error.issues) {
    prose.push(`${source}.${issue.path.join('.') || '(root)'}: ${issue.message}`)

    // An unrecognised key has an empty path, so name the offending keys
    // instead of filing them all under the object itself.
    const paths =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key].join('.'))
        : [issue.path.join('.')]

    for (const path of paths) {
      const key = source === 'body' ? path || '_' : `${source}.${path || '_'}`
      ;(into[key] ??= []).push(i18nKeyFor(issue))
    }
  }
}

/**
 * A schema's own message wins when it already *is* a key — that is how
 * `errors.passwordTooShort` reaches the form instead of a generic "too small".
 */
function i18nKeyFor(issue: ZodError['issues'][number]): string {
  if (issue.message.startsWith('errors.')) return issue.message
  return ISSUE_KEYS[issue.code] ?? 'errors.field.invalid'
}

function read<T>(req: Request, source: Source): T {
  const value = req.validated?.[source]
  if (value === undefined) {
    // Reaching this means a route asked for validated input without declaring
    // a schema for it. That is a wiring bug in our code, not bad input, so it
    // must not present to the caller as a 400.
    throw new InternalError(`route read validated ${source} without a ${source} schema`)
  }
  return value as T
}

export const validBody = <T>(req: Request): T => read<T>(req, 'body')
export const validQuery = <T>(req: Request): T => read<T>(req, 'query')
export const validParams = <T>(req: Request): T => read<T>(req, 'params')
