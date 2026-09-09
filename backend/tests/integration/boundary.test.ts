import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { getEnv } from '../../src/config/env.js'
import { SlidingWindowRateLimiter } from '../../src/infrastructure/rateLimit/slidingWindow.js'
import { buildTestApp, productionEnv } from '../helpers/app.js'

/**
 * S12 — the boundary rejects malformed and abusive input before any controller
 * sees it (P7). Exercised through `/_probe`, whose schema exists for exactly
 * this purpose.
 */
const { app } = buildTestApp()
const baseEnv = getEnv()

const probe = (body: unknown) =>
  request(app)
    .post('/api/v1/_probe')
    .set('content-type', 'application/json')
    .send(body as object)

describe('Zod validation at the boundary', () => {
  it('accepts a valid body and hands back the parsed value', async () => {
    const res = await probe({ n: 5, label: 'hello' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, echo: { n: 5, label: 'hello' } })
  })

  it('★ names the missing field in fieldErrors', async () => {
    const res = await probe({})

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.i18nKey).toBe('errors.validationFailed')
    expect(Object.keys(res.body.fieldErrors)).toContain('n')
  })

  it('★ refuses to coerce "5" into 5', async () => {
    const res = await probe({ n: '5' })

    // A coercing boundary turns a client bug into a server-side type confusion
    // three layers down. `z.coerce` appears nowhere in a request schema.
    expect(res.status).toBe(400)
    expect(Object.keys(res.body.fieldErrors)).toContain('n')
  })

  it('★ rejects an unknown extra field rather than dropping it', async () => {
    const res = await probe({ n: 5, sneaky: true })

    // Silently ignoring `sneaky` is how a misspelled field becomes a setting
    // that quietly never applied.
    expect(res.status).toBe(400)
    expect(res.body.fieldErrors.sneaky).toEqual(['errors.field.unknownKey'])
  })

  it('★ every field error is an i18n key, never English prose', async () => {
    const res = await probe({ n: '5', label: 'x' })

    // The hard rule: errors carry a machine code and a translation key so the
    // client renders them in the reader's language. "Expected number, received
    // string" in front of a Persian speaker is the failure this prevents.
    const keys = Object.values(res.body.fieldErrors as Record<string, string[]>).flat()
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key, key).toMatch(/^errors\.[A-Za-z.]+$/)
      expect(key).not.toContain(' ')
    }
  })

  it('enforces the range, not just the type', async () => {
    expect((await probe({ n: 99 })).status).toBe(400)
    expect((await probe({ n: 0 })).status).toBe(400)
  })

  it('turns malformed JSON into a 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/v1/_probe')
      .set('content-type', 'application/json')
      .send('{"n": ')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a body over the 100kb limit as a 400', async () => {
    const res = await request(app)
      .post('/api/v1/_probe')
      .set('content-type', 'application/json')
      .send({ n: 5, label: 'x'.repeat(200_000) })

    expect(res.status).toBe(400)
  })

  it('never returns an English sentence for the client to render', async () => {
    const res = await probe({})
    expect(res.body).not.toHaveProperty('message')
    expect(res.body).not.toHaveProperty('stack')
  })
})

describe('security headers', () => {
  it('sets the headers helmet exists for, on every response', async () => {
    const res = await request(app).get('/health')

    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['x-frame-options']).toBeDefined()
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })

  it('still does not advertise Express', async () => {
    expect((await request(app).get('/health')).headers['x-powered-by']).toBeUndefined()
  })

  it('announces no pending middleware — every S12 slot is filled', async () => {
    // The stub header was a development aid while the chain had holes in it.
    expect((await request(app).get('/health')).headers['x-pending-middleware']).toBeUndefined()
  })
})

describe('credentialed CORS', () => {
  it('allows the configured frontend origin, with credentials', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173')

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('★ refuses an unknown origin — no allow-origin header to read the body with', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.test')

    // A wildcard plus credentials is forbidden by the CORS spec, so a single
    // exact origin is the only correct configuration. Anything else gets no
    // header and the browser discards the response.
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('★ refuses a state-changing request from a foreign origin outright', async () => {
    const res = await request(app)
      .post('/api/v1/_probe')
      .set('Origin', 'https://evil.test')
      .send({ n: 5 })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('answers the preflight for the CSRF header', async () => {
    const res = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-csrf-token')

    expect(res.status).toBeLessThan(300)
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain('x-csrf-token')
  })
})

describe('rate limiting', () => {
  it('★ flips to 429 with retryAfterMs once the window is spent', async () => {
    const limiter = new SlidingWindowRateLimiter(0)
    const { app: limited } = buildTestApp({
      rateLimiter: limiter,
      env: { ...baseEnv, RATE_LIMIT_MAX: 5, RATE_LIMIT_WINDOW_SEC: 60 },
    })

    const codes: number[] = []
    for (let i = 0; i < 8; i += 1) {
      codes.push((await request(limited).get('/api/v1/no-such-route')).status)
    }
    limiter.dispose()

    expect(codes.filter((code) => code === 429)).toHaveLength(3)
    expect(codes.slice(0, 5).every((code) => code === 404)).toBe(true)
  })

  it('reports Retry-After and the remaining budget', async () => {
    const limiter = new SlidingWindowRateLimiter(0)
    const { app: limited } = buildTestApp({
      rateLimiter: limiter,
      env: { ...baseEnv, RATE_LIMIT_MAX: 1, RATE_LIMIT_WINDOW_SEC: 60 },
    })

    const first = await request(limited).get('/api/v1/no-such-route')
    expect(first.headers['x-ratelimit-limit']).toBe('1')
    expect(first.headers['x-ratelimit-remaining']).toBe('0')

    const denied = await request(limited).get('/api/v1/no-such-route')
    limiter.dispose()

    expect(denied.status).toBe(429)
    expect(denied.body.code).toBe('RATE_LIMITED')
    expect(denied.body.retryAfterMs).toBeGreaterThan(0)
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('★ never rate-limits the health probes', async () => {
    const limiter = new SlidingWindowRateLimiter(0)
    const { app: limited } = buildTestApp({
      rateLimiter: limiter,
      env: { ...baseEnv, RATE_LIMIT_MAX: 1, RATE_LIMIT_WINDOW_SEC: 60 },
    })

    // An orchestrator polling every 5 s must not be able to take the instance
    // out of rotation by exhausting our own limiter.
    for (let i = 0; i < 5; i += 1) {
      expect((await request(limited).get('/health')).status).toBe(200)
    }
    limiter.dispose()
  })
})

describe('the dev-only probe', () => {
  it('is not mounted in production', async () => {
    const { app: prod } = buildTestApp({ env: productionEnv() })
    const res = await request(prod).post('/api/v1/_probe').send({ n: 5 })

    expect(res.status).toBe(404)
  })
})
