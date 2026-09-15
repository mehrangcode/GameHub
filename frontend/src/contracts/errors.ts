// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'

/**
 * 02-technical-prd.md §5.6. Errors cross the wire as a stable machine `code`
 * plus an `i18nKey` — never a rendered English sentence, so the client renders
 * the message in the reader's language from the same payload.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  /**
   * Beyond §5.6's nine REST rows, like the four below it. Registration needs a
   * code distinct from `VALIDATION_FAILED`: "that email is already registered"
   * is not a malformed request, and the sign-up form has to render it under the
   * email field in the reader's language.
   */
  'EMAIL_TAKEN',
  'SEAT_TAKEN',
  'ILLEGAL_MOVE',
  'NOT_YOUR_TURN',
  'INVITE_EXPIRED',
  'RATE_LIMITED',
  'ILLEGAL_PHASE_TRANSITION',
  'INSUFFICIENT_FUNDS',
  'CAP_REJECTED',
  'SEAT_NOT_RECLAIMABLE',

  /**
   * 12-admin-console.md §5.1 — the admin console's six. They live in the shared
   * taxonomy rather than a parallel one because `AppError.code` is typed by
   * `ErrorCode`: a second enum would mean a second base class, a second error
   * middleware, and eventually two answers to "what does a 403 body look like".
   *
   * The public API can never emit any of them — no route on `:3000` constructs
   * one — but the *shape* is identical, which is what lets `admin-frontend/`
   * (MA) reuse the same error rendering.
   */
  'STEP_UP_REQUIRED',
  'MFA_REQUIRED',
  'MFA_ENROLLMENT_REQUIRED',
  'ADMIN_LOCKED',
  'REASON_REQUIRED',
  'SELF_TARGET_FORBIDDEN',

  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]
export const ErrorCodeSchema = z.enum(ERROR_CODES)

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  i18nKey: z.string(),
  details: z.record(z.unknown()).optional(),
  fieldErrors: z.record(z.array(z.string())).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
})

export type ApiError = z.infer<typeof ApiErrorSchema>

/** Socket acks are a discriminated union so a handler cannot forget the failure arm. */
export type SocketAck<T = undefined> =
  | { ok: true; data: T }
  | ({ ok: false } & Pick<
      ApiError,
      'code' | 'i18nKey' | 'details' | 'fieldErrors' | 'retryAfterMs'
    >)
