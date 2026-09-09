import { describe, expect, it } from 'vitest'
import { ERROR_CODES, type ErrorCode } from '../../src/contracts/errors.js'
import { AppError, isAppError } from '../../src/domain/errors/AppError.js'
import {
  CapRejectedError,
  EmailTakenError,
  ForbiddenError,
  IllegalMoveError,
  IllegalPhaseTransitionError,
  InsufficientFundsError,
  InternalError,
  InviteExpiredError,
  NotFoundError,
  NotYourTurnError,
  RateLimitError,
  SeatNotReclaimableError,
  SeatTakenError,
  UnauthorizedError,
  ValidationError,
} from '../../src/domain/errors/errors.js'

/**
 * The spec table from 02-technical-prd.md §5.6, transcribed. If a row here and
 * a class disagree, one of them is a bug — and the exhaustiveness test below
 * makes adding a code to `contracts/errors.ts` without a class fail too.
 */
const TAXONOMY: ReadonlyArray<{
  code: ErrorCode
  httpStatus: number
  i18nKey: string
  build: () => AppError
}> = [
  {
    code: 'VALIDATION_FAILED',
    httpStatus: 400,
    i18nKey: 'errors.validationFailed',
    build: () => new ValidationError(),
  },
  {
    code: 'UNAUTHORIZED',
    httpStatus: 401,
    i18nKey: 'errors.unauthorized',
    build: () => new UnauthorizedError(),
  },
  {
    code: 'FORBIDDEN',
    httpStatus: 403,
    i18nKey: 'errors.forbidden',
    build: () => new ForbiddenError(),
  },
  {
    code: 'NOT_FOUND',
    httpStatus: 404,
    i18nKey: 'errors.notFound',
    build: () => new NotFoundError('Table'),
  },
  {
    code: 'EMAIL_TAKEN',
    httpStatus: 409,
    i18nKey: 'errors.emailTaken',
    build: () => new EmailTakenError(),
  },
  {
    code: 'SEAT_TAKEN',
    httpStatus: 409,
    i18nKey: 'errors.seatTaken',
    build: () => new SeatTakenError(2),
  },
  {
    code: 'ILLEGAL_MOVE',
    httpStatus: 422,
    i18nKey: 'errors.illegalMove',
    build: () => new IllegalMoveError(),
  },
  {
    code: 'NOT_YOUR_TURN',
    httpStatus: 422,
    i18nKey: 'errors.notYourTurn',
    build: () => new NotYourTurnError(),
  },
  {
    code: 'INVITE_EXPIRED',
    httpStatus: 410,
    i18nKey: 'errors.inviteExpired',
    build: () => new InviteExpiredError(),
  },
  {
    code: 'RATE_LIMITED',
    httpStatus: 429,
    i18nKey: 'errors.rateLimited',
    build: () => new RateLimitError(1500),
  },
  {
    code: 'ILLEGAL_PHASE_TRANSITION',
    httpStatus: 409,
    i18nKey: 'errors.illegalPhaseTransition',
    build: () => new IllegalPhaseTransitionError('BIDDING', 'PLAYING'),
  },
  {
    code: 'INSUFFICIENT_FUNDS',
    httpStatus: 409,
    i18nKey: 'errors.insufficientFunds',
    build: () => new InsufficientFundsError(500, 120),
  },
  {
    code: 'CAP_REJECTED',
    httpStatus: 429,
    i18nKey: 'errors.capRejected',
    build: () => new CapRejectedError(),
  },
  {
    code: 'SEAT_NOT_RECLAIMABLE',
    httpStatus: 409,
    i18nKey: 'errors.seatNotReclaimable',
    build: () => new SeatNotReclaimableError(),
  },
  {
    code: 'INTERNAL',
    httpStatus: 500,
    i18nKey: 'errors.internal',
    build: () => new InternalError(),
  },
]

describe('error taxonomy (02 §5.6)', () => {
  it.each(TAXONOMY)(
    '$code → HTTP $httpStatus, $i18nKey',
    ({ code, httpStatus, i18nKey, build }) => {
      const error = build()
      expect(error.code).toBe(code)
      expect(error.httpStatus).toBe(httpStatus)
      expect(error.i18nKey).toBe(i18nKey)
    },
  )

  it('covers every code in the contract — no code without a class', () => {
    expect([...TAXONOMY.map((row) => row.code)].sort()).toEqual([...ERROR_CODES].sort())
  })

  it.each(TAXONOMY)('$code is an Error, an AppError, and keeps its class name', ({ build }) => {
    const error = build()
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(AppError)
    expect(isAppError(error)).toBe(true)
    expect(error.name).toBe(error.constructor.name)
    expect(error.stack).toBeTruthy()
  })

  it.each(TAXONOMY)('$code serialises to the wire shape without leaking prose', ({ build }) => {
    const error = build()
    const payload = error.toApiError()

    expect(payload.code).toBe(error.code)
    expect(payload.i18nKey).toBe(error.i18nKey)
    // The English `message` is for logs. Anything the client renders comes from
    // the i18nKey, so the payload must never carry a rendered sentence.
    expect(Object.keys(payload)).not.toContain('message')
    expect(Object.keys(payload)).not.toContain('stack')
  })

  it('every i18nKey is namespaced and unique', () => {
    const keys = TAXONOMY.map((row) => row.i18nKey)
    expect(keys.every((k) => k.startsWith('errors.'))).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('errors that carry structured detail', () => {
  it('ValidationError carries per-field messages, not a sentence', () => {
    const error = new ValidationError('bad body', { email: ['errors.email.invalid'] })
    expect(error.toApiError().fieldErrors).toEqual({ email: ['errors.email.invalid'] })
  })

  it('ValidationError omits fieldErrors entirely when there are none', () => {
    expect(new ValidationError().toApiError()).not.toHaveProperty('fieldErrors')
  })

  it('RateLimitError tells the client when to come back', () => {
    expect(new RateLimitError(2500).toApiError().retryAfterMs).toBe(2500)
  })

  it('RateLimitError floors a fractional or negative delay to a sane integer', () => {
    expect(new RateLimitError(1200.9).retryAfterMs).toBe(1200)
    expect(new RateLimitError(-5).retryAfterMs).toBe(0)
  })

  it('SeatTakenError reports which seat, so the client can re-render the map', () => {
    expect(new SeatTakenError(3).toApiError().details).toEqual({ seat: 3 })
  })

  it('IllegalPhaseTransitionError names both phases', () => {
    const error = new IllegalPhaseTransitionError('DEALING', 'SCORING')
    expect(error.toApiError().details).toEqual({ from: 'DEALING', to: 'SCORING' })
    expect(error.message).toContain('DEALING')
  })

  it('InsufficientFundsError reports the shortfall without revealing anything else', () => {
    expect(new InsufficientFundsError(500, 120).toApiError().details).toEqual({
      required: 500,
      available: 120,
    })
  })

  it('CapRejectedError is optional-retry: no retryAfterMs unless one is known', () => {
    expect(new CapRejectedError('daily cap').toApiError()).not.toHaveProperty('retryAfterMs')
    expect(new CapRejectedError('hourly cap', 60_000).toApiError().retryAfterMs).toBe(60_000)
  })
})

describe('isAppError', () => {
  it('rejects everything that is not one', () => {
    for (const value of [new Error('plain'), new TypeError('t'), 'string', null, undefined, {}]) {
      expect(isAppError(value)).toBe(false)
    }
  })
})
