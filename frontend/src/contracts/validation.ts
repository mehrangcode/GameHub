// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

/**
 * Zod issue code → i18n key — shared by **both** sides of the wire.
 *
 * This table lives in `contracts/` rather than beside the REST boundary for the
 * same reason it was extracted from that boundary in the first place (S12): two
 * copies drift, and the copy that drifts is the one somebody forgets. Now there
 * are three consumers — the REST boundary, the socket boundary, and the login
 * and register forms in the browser, which validate with the *same schemas* the
 * server does and must therefore produce the *same message* for the same input.
 *
 * A client showing "Invalid email" where the server would have said
 * `errors.field.invalidFormat` is not a cosmetic difference: Zod's defaults are
 * untranslatable English prose, and putting one in front of a Persian reader is
 * precisely the failure the `code` + `i18nKey` contract exists to prevent.
 *
 * **How a schema overrides this:** give the rule its own message and make that
 * message a key — `z.string().min(10, 'errors.passwordTooShort')`. Callers
 * check for the `errors.` prefix first and fall back to this table, which is
 * how a specific rule beats a generic "too small".
 */
export const ZOD_ISSUE_KEYS: Record<string, string> = {
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

/** The fallback when an issue code is not in the table above. */
export const ZOD_FALLBACK_KEY = 'errors.field.invalid'

/** A schema message that starts with this already *is* a key, and wins. */
export const I18N_KEY_PREFIX = 'errors.'
