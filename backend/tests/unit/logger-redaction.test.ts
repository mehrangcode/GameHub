import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { REDACTED, createLogger } from '../../src/infrastructure/logger.js'

/**
 * The secrets in this file are the point: each one is logged carelessly, the
 * way it would be at 1 a.m. while debugging, and must still come out
 * `[Redacted]`. If someone deletes a path from the logger config, one of these
 * lines starts containing a real password and the test says so.
 */
const PASSWORD = 'hunter2-super-secret'
const COOKIE = 'refreshToken=eyJhbGciOi.SECRET-COOKIE-VALUE; Path=/'
const BEARER = 'Bearer eyJhbGciOi.SECRET-ACCESS-TOKEN'

function capture(): { logger: ReturnType<typeof createLogger>; lines: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  const logger = createLogger(stream)
  // The test env pins LOG_LEVEL to `error`; these assertions need to see every
  // line the redaction config touches, including the info-level request logs.
  logger.level = 'trace'
  return { logger, lines: () => chunks.join('') }
}

describe('logger redaction (02 §11)', () => {
  it('redacts a password at the top level', () => {
    const { logger, lines } = capture()
    logger.error({ email: 'a@b.dev', password: PASSWORD }, 'login failed')

    expect(lines()).not.toContain(PASSWORD)
    expect(lines()).toContain(REDACTED)
    // Everything else still logs — redaction is surgical, not a blanket drop.
    expect(lines()).toContain('a@b.dev')
  })

  it('redacts a password nested one level down, e.g. a whole request body', () => {
    const { logger, lines } = capture()
    logger.error({ body: { email: 'a@b.dev', password: PASSWORD } }, 'validation failed')

    expect(lines()).not.toContain(PASSWORD)
  })

  it('redacts a cookie header', () => {
    const { logger, lines } = capture()
    logger.error({ headers: { cookie: COOKIE } }, 'bad token')

    expect(lines()).not.toContain('SECRET-COOKIE-VALUE')
  })

  it('redacts an authorization header', () => {
    const { logger, lines } = capture()
    logger.error({ headers: { authorization: BEARER } }, 'unauthorized')

    expect(lines()).not.toContain('SECRET-ACCESS-TOKEN')
  })

  it('redacts token fields whatever they are called', () => {
    const { logger, lines } = capture()
    logger.error(
      {
        accessToken: 'AAA-access',
        refreshToken: 'BBB-refresh',
        tokenHash: 'CCC-hash',
        passwordHash: 'DDD-argon',
      },
      'rotation',
    )

    const output = lines()
    for (const secret of ['AAA-access', 'BBB-refresh', 'CCC-hash', 'DDD-argon']) {
      expect(output, `${secret} leaked`).not.toContain(secret)
    }
  })

  it('redacts the request/response paths pino-http populates', () => {
    const { logger, lines } = capture()
    logger.info(
      {
        req: {
          method: 'POST',
          url: '/auth/login',
          headers: { cookie: COOKIE, authorization: BEARER },
        },
      },
      'request completed',
    )

    const output = lines()
    expect(output).not.toContain('SECRET-COOKIE-VALUE')
    expect(output).not.toContain('SECRET-ACCESS-TOKEN')
    // The useful half survives.
    expect(output).toContain('/auth/login')
  })

  it('emits parseable JSON with a level and an ISO timestamp', () => {
    const { logger, lines } = capture()
    logger.warn({ requestId: 'req-1' }, 'something')

    const line = JSON.parse(lines().trim()) as Record<string, unknown>
    expect(line.requestId).toBe('req-1')
    expect(line.msg).toBe('something')
    expect(line.service).toBe('api')
    expect(String(line.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
