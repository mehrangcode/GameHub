import type { ApiError, ErrorCode } from '../../contracts/errors.js'

/**
 * 02-technical-prd.md §5.6 — the one error base class.
 *
 * Every failure the client is allowed to understand extends this. The three
 * fields that cross the wire are a stable machine `code`, an `i18nKey`, and
 * optional structured `details` — **never a rendered English sentence**, so
 * one payload renders correctly in `en` and `fa` alike.
 *
 * `message` exists for logs and stack traces only. It never reaches a client:
 * the Express error middleware (S10) and the socket ack wrapper (S23) both
 * serialise via {@link AppError.toApiError}, and anything that is *not* an
 * `AppError` becomes an opaque `INTERNAL` 500.
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode
  abstract readonly httpStatus: number
  abstract readonly i18nKey: string

  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    // Without this the subclass name is lost through TS's ES2015+ class
    // downlevelling and every error logs as plain "Error".
    this.name = new.target.name
    if (details !== undefined) this.details = details
    Error.captureStackTrace?.(this, new.target)
  }

  /** The exact object shape that goes over REST and in a socket ack. */
  toApiError(): ApiError {
    return {
      code: this.code,
      i18nKey: this.i18nKey,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
