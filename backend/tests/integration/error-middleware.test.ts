import { Writable } from 'node:stream'
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import {
  CapRejectedError,
  RateLimitError,
  SeatTakenError,
  UnauthorizedError,
  ValidationError,
} from '../../src/domain/errors/errors.js'
import { createLogger } from '../../src/infrastructure/logger.js'
import {
  asyncHandler,
  errorHandler,
  notFoundHandler,
} from '../../src/interface/http/middleware/error.js'
import { requestId } from '../../src/interface/http/middleware/requestId.js'

const SECRET_IN_STACK = 'internal-implementation-detail'

function buildProbeApp() {
  const logged: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logged.push(String(chunk))
      callback()
    },
  })
  const app = express()
  app.use(requestId())

  app.get('/seat-taken', () => {
    throw new SeatTakenError(2)
  })
  app.get('/validation', () => {
    throw new ValidationError('bad body', { email: ['errors.email.invalid'] })
  })
  app.get('/unauthorized', () => {
    throw new UnauthorizedError()
  })
  app.get('/rate-limited', () => {
    throw new RateLimitError(2500)
  })
  app.get('/capped', () => {
    throw new CapRejectedError('daily cap', 60_000)
  })
  app.get('/boom', () => {
    throw new Error(SECRET_IN_STACK)
  })
  app.get(
    '/async-boom',
    asyncHandler(async () => {
      await Promise.resolve()
      throw new Error(SECRET_IN_STACK)
    }),
  )

  app.use(notFoundHandler())
  app.use(errorHandler(createLogger(stream)))

  return { app, logged: () => logged.join('') }
}

describe('error middleware (02 §5.6)', () => {
  it('maps an AppError to its documented status and wire shape', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/seat-taken')

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      code: 'SEAT_TAKEN',
      i18nKey: 'errors.seatTaken',
      details: { seat: 2 },
    })
  })

  it('carries fieldErrors through for a validation failure', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/validation')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.fieldErrors).toEqual({ email: ['errors.email.invalid'] })
  })

  it('maps 401 without leaking why', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/unauthorized')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })
  })

  it('sets Retry-After alongside retryAfterMs on a 429', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/rate-limited')

    expect(res.status).toBe(429)
    expect(res.body.retryAfterMs).toBe(2500)
    expect(res.headers['retry-after']).toBe('3')
  })

  it('does the same for a capped earn', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/capped')

    expect(res.status).toBe(429)
    expect(res.body.code).toBe('CAP_REJECTED')
    expect(res.body.retryAfterMs).toBe(60_000)
  })

  it('★ turns an unexpected error into an opaque 500 with no stack in the body', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/boom')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'INTERNAL', i18nKey: 'errors.internal' })
    const serialised = JSON.stringify(res.body)
    expect(serialised).not.toContain(SECRET_IN_STACK)
    expect(serialised).not.toContain('stack')
    expect(serialised).not.toContain('at ')
  })

  it('does the same for a rejected async handler', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/async-boom')

    expect(res.status).toBe(500)
    expect(res.body.code).toBe('INTERNAL')
  })

  it('logs the real error with the requestId, so support can find it', async () => {
    const { app, logged } = buildProbeApp()
    const res = await request(app).get('/boom').set('x-request-id', 'trace-me-123')

    expect(res.headers['x-request-id']).toBe('trace-me-123')
    const output = logged()
    expect(output).toContain('trace-me-123')
    // What the client never sees, the operator always does.
    expect(output).toContain(SECRET_IN_STACK)
  })

  it('answers an unknown route with a plain 404 in the same shape', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/no-such-route')

    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
    expect(res.body.i18nKey).toBe('errors.notFound')
  })

  it('generates a requestId when the client does not supply one', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/seat-taken')

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('ignores an absurdly long inbound requestId rather than logging it', async () => {
    const { app } = buildProbeApp()
    const res = await request(app).get('/seat-taken').set('x-request-id', 'x'.repeat(500))

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})
