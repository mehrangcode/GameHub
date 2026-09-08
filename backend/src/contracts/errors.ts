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
  'SEAT_TAKEN',
  'ILLEGAL_MOVE',
  'NOT_YOUR_TURN',
  'INVITE_EXPIRED',
  'RATE_LIMITED',
  'ILLEGAL_PHASE_TRANSITION',
  'INSUFFICIENT_FUNDS',
  'CAP_REJECTED',
  'SEAT_NOT_RECLAIMABLE',
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
