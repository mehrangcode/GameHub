import type { ApiError } from '../../contracts/errors.js'
import { AppError } from './AppError.js'

/**
 * The concrete taxonomy — 02-technical-prd.md §5.6, one class per member of
 * `ERROR_CODES`. `tests/unit/errors.test.ts` asserts that mapping is total in
 * both directions, so a code added to the contract without a class here (or a
 * class with a status that drifts from the spec table) fails the build.
 *
 * The four codes below the §5.6 table have no status in the spec because they
 * surface mainly as socket acks. The values chosen here, and why:
 *
 *   - `ILLEGAL_PHASE_TRANSITION` → **409**. The request is well-formed; the
 *     game is simply not in a state that permits it. That is Conflict, not
 *     Unprocessable.
 *   - `INSUFFICIENT_FUNDS`       → **409**, deliberately *not* 402. Coins are
 *     earned, never bought (10 §6.5); 402 Payment Required would imply the
 *     purchasable currency this platform refuses to have.
 *   - `CAP_REJECTED`             → **429**, with `retryAfterMs`. An earn cap is
 *     a rate limit on the economy, and the honest answer to "why did I get
 *     nothing?" is "come back later".
 *   - `SEAT_NOT_RECLAIMABLE`     → **409**. The seat exists and a bot holds it;
 *     the reclaim window (04 §6.4) has closed.
 */

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const
  readonly httpStatus = 400
  readonly i18nKey = 'errors.validationFailed'

  /** Per-field messages, the shape a form renders directly. */
  readonly fieldErrors?: Record<string, string[]>

  constructor(
    message = 'Validation failed',
    fieldErrors?: Record<string, string[]>,
    details?: Record<string, unknown>,
  ) {
    super(message, details)
    if (fieldErrors !== undefined) this.fieldErrors = fieldErrors
  }

  override toApiError(): ApiError {
    return {
      ...super.toApiError(),
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
    }
  }
}

export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED' as const
  readonly httpStatus = 401
  readonly i18nKey = 'errors.unauthorized'

  constructor(message = 'Authentication required', details?: Record<string, unknown>) {
    super(message, details)
  }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN' as const
  readonly httpStatus = 403
  readonly i18nKey = 'errors.forbidden'

  constructor(message = 'Not permitted', details?: Record<string, unknown>) {
    super(message, details)
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const
  readonly httpStatus = 404
  readonly i18nKey = 'errors.notFound'

  constructor(resource = 'Resource', details?: Record<string, unknown>) {
    super(`${resource} not found`, details)
  }
}

/**
 * Registration hit the `User.email` unique constraint.
 *
 * Thrown by `IUserRepository.create`, **not** by a `findByEmail` check in the
 * service. Same reasoning as `SeatTakenError`: the database is the arbiter of
 * uniqueness, and a read-then-write check is simply wrong under concurrency —
 * two simultaneous sign-ups with one address would both pass it.
 *
 * The body deliberately carries no `details`. Confirming *which* address is
 * taken is unavoidable here (the user typed it), but nothing else about the
 * existing account leaks.
 */
export class EmailTakenError extends AppError {
  readonly code = 'EMAIL_TAKEN' as const
  readonly httpStatus = 409
  readonly i18nKey = 'errors.emailTaken'

  constructor(message = 'Email already registered') {
    super(message)
  }
}

/**
 * Raised by `claimSeat` returning null — i.e. by a unique-constraint violation
 * on `(tableId, seat)`, never by a read-then-write check (03 §6.3).
 */
export class SeatTakenError extends AppError {
  readonly code = 'SEAT_TAKEN' as const
  readonly httpStatus = 409
  readonly i18nKey = 'errors.seatTaken'

  constructor(seat?: number, details?: Record<string, unknown>) {
    super(seat === undefined ? 'Seat already taken' : `Seat ${seat} already taken`, {
      ...(seat === undefined ? {} : { seat }),
      ...details,
    })
  }
}

/** Audit-logged (07 §6): a rejected move is the primary cheating signal. */
export class IllegalMoveError extends AppError {
  readonly code = 'ILLEGAL_MOVE' as const
  readonly httpStatus = 422
  readonly i18nKey = 'errors.illegalMove'

  constructor(message = 'Illegal move', details?: Record<string, unknown>) {
    super(message, details)
  }
}

/** Also audit-logged. A client that sends these in bursts is being probed. */
export class NotYourTurnError extends AppError {
  readonly code = 'NOT_YOUR_TURN' as const
  readonly httpStatus = 422
  readonly i18nKey = 'errors.notYourTurn'

  constructor(message = 'Not your turn', details?: Record<string, unknown>) {
    super(message, details)
  }
}

export class InviteExpiredError extends AppError {
  readonly code = 'INVITE_EXPIRED' as const
  readonly httpStatus = 410
  readonly i18nKey = 'errors.inviteExpired'

  constructor(message = 'Invite is no longer valid', details?: Record<string, unknown>) {
    super(message, details)
  }
}

export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMITED' as const
  readonly httpStatus = 429
  readonly i18nKey = 'errors.rateLimited'

  readonly retryAfterMs: number

  constructor(retryAfterMs: number, details?: Record<string, unknown>) {
    super('Rate limit exceeded', details)
    this.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs))
  }

  override toApiError(): ApiError {
    return { ...super.toApiError(), retryAfterMs: this.retryAfterMs }
  }
}

export class IllegalPhaseTransitionError extends AppError {
  readonly code = 'ILLEGAL_PHASE_TRANSITION' as const
  readonly httpStatus = 409
  readonly i18nKey = 'errors.illegalPhaseTransition'

  constructor(from?: string, to?: string, details?: Record<string, unknown>) {
    super(from && to ? `Illegal phase transition ${from} → ${to}` : 'Illegal phase transition', {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...details,
    })
  }
}

export class InsufficientFundsError extends AppError {
  readonly code = 'INSUFFICIENT_FUNDS' as const
  readonly httpStatus = 409
  readonly i18nKey = 'errors.insufficientFunds'

  constructor(required?: number, available?: number, details?: Record<string, unknown>) {
    super('Insufficient funds', {
      ...(required === undefined ? {} : { required }),
      ...(available === undefined ? {} : { available }),
      ...details,
    })
  }
}

/**
 * The earn cap was hit. Note that in the reward *settlement* path this is
 * usually not thrown at all — it becomes a zero-amount `CAP_REJECTED` ledger
 * row instead, because a reward silently not granted is indistinguishable from
 * a bug (10 §2.4). The class exists for the paths where a caller asked for a
 * credit directly and deserves an answer.
 */
export class CapRejectedError extends AppError {
  readonly code = 'CAP_REJECTED' as const
  readonly httpStatus = 429
  readonly i18nKey = 'errors.capRejected'

  readonly retryAfterMs?: number

  constructor(
    reason = 'Earn cap reached',
    retryAfterMs?: number,
    details?: Record<string, unknown>,
  ) {
    super(reason, details)
    if (retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs))
  }

  override toApiError(): ApiError {
    return {
      ...super.toApiError(),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    }
  }
}

/** The reclaim window (04 §6.4) closed; the bot keeps the seat. */
export class SeatNotReclaimableError extends AppError {
  readonly code = 'SEAT_NOT_RECLAIMABLE' as const
  readonly httpStatus = 409
  readonly i18nKey = 'errors.seatNotReclaimable'

  constructor(message = 'Seat can no longer be reclaimed', details?: Record<string, unknown>) {
    super(message, details)
  }
}

/**
 * Never constructed from a request path — the error middleware wraps unknown
 * throwables in this so the client sees a code and nothing else. The original
 * error is logged with the `requestId`; the stack never leaves the process.
 */
export class InternalError extends AppError {
  readonly code = 'INTERNAL' as const
  readonly httpStatus = 500
  readonly i18nKey = 'errors.internal'

  constructor(message = 'Internal error') {
    super(message)
  }
}
