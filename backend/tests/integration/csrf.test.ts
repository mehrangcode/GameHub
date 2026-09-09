import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { AUTH_COOKIES, CSRF_HEADER } from '../../src/contracts/dto/auth.js'
import { buildTestApp } from '../helpers/app.js'
import { resetDb } from '../helpers/db.js'

/**
 * CSRF — 07 §5.4.
 *
 * Two checks on every state-changing request: the `Origin` must be ours, and
 * the non-httpOnly `csrf` cookie must be echoed in `X-CSRF-Token`. A request
 * with **no** `Origin` did not come from a browser and therefore carries no
 * ambient cookies to ride, so the token is not demanded — which is why `curl`
 * and the `.http` files work while a hostile page does not.
 */
const { app } = buildTestApp()
const ORIGIN = 'http://localhost:5173'

beforeEach(async () => {
  await resetDb()
})

const csrfOf = (res: request.Response): string => {
  const headers = (res.headers['set-cookie'] ?? []) as unknown as string[]
  const cookie = headers.find((h) => h.startsWith(`${AUTH_COOKIES.csrf}=`)) ?? ''
  return cookie.split('=')[1]?.split(';')[0] ?? ''
}

describe('the csrf cookie', () => {
  it('is seeded on the first request, readable by JS', async () => {
    const res = await request(app).get('/api/v1/health')
    const headers = (res.headers['set-cookie'] ?? []) as unknown as string[]
    const cookie = headers.find((h) => h.startsWith(`${AUTH_COOKIES.csrf}=`)) ?? ''

    expect(cookie).toBeTruthy()
    expect(cookie).not.toMatch(/HttpOnly/i)
    expect(csrfOf(res)).toHaveLength(32) // 24 random bytes, base64url
  })

  it('is not re-issued once the client has one', async () => {
    const agent = request.agent(app)
    await agent.get('/api/v1/health')
    const second = await agent.get('/api/v1/health')

    const headers = (second.headers['set-cookie'] ?? []) as unknown as string[]
    expect(headers.some((h) => h.startsWith(`${AUTH_COOKIES.csrf}=`))).toBe(false)
  })
})

describe('browser requests must present the token', () => {
  it('★ accepts a same-origin POST that echoes the cookie', async () => {
    const agent = request.agent(app)
    const seeded = await agent.get('/api/v1/health')
    const token = csrfOf(seeded)

    const res = await agent
      .post('/api/v1/_probe')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, token)
      .send({ n: 5 })

    expect(res.status).toBe(200)
  })

  it('★ refuses a same-origin POST with the cookie but no header', async () => {
    const agent = request.agent(app)
    await agent.get('/api/v1/health')

    // This is the forged-request shape: an attacker's page makes the browser
    // send the cookie, but cannot read it to build the header.
    const res = await agent.post('/api/v1/_probe').set('Origin', ORIGIN).send({ n: 5 })

    expect(res.status).toBe(403)
    expect(res.body.details.reason).toBe('CSRF_FAILED')
  })

  it('refuses a mismatched token', async () => {
    const agent = request.agent(app)
    await agent.get('/api/v1/health')

    const res = await agent
      .post('/api/v1/_probe')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, 'not-the-token-in-the-cookie')
      .send({ n: 5 })

    expect(res.status).toBe(403)
  })

  it('★ refuses a foreign origin even with a valid token', async () => {
    const agent = request.agent(app)
    const token = csrfOf(await agent.get('/api/v1/health'))

    // The Origin check is the primary defence and does not depend on the token
    // at all — it fails first, and no token can talk it round.
    const res = await agent
      .post('/api/v1/_probe')
      .set('Origin', 'https://evil.test')
      .set(CSRF_HEADER, token)
      .send({ n: 5 })

    expect(res.status).toBe(403)
    expect(res.body.details.reason).toBe('ORIGIN_MISMATCH')
  })

  it('★ refuses an opaque origin — a sandboxed iframe is still a browser', async () => {
    const agent = request.agent(app)
    const token = csrfOf(await agent.get('/api/v1/health'))

    const res = await agent
      .post('/api/v1/_probe')
      .set('Origin', 'null')
      .set(CSRF_HEADER, token)
      .send({ n: 5 })

    expect(res.status).toBe(403)
    expect(res.body.details.reason).toBe('ORIGIN_MISMATCH')
  })

  it('falls back to Referer when Origin is absent', async () => {
    const agent = request.agent(app)
    await agent.get('/api/v1/health')

    const res = await agent
      .post('/api/v1/_probe')
      .set('Referer', 'https://evil.test/attack.html')
      .send({ n: 5 })

    expect(res.status).toBe(403)
  })
})

describe('non-browser clients', () => {
  it('★ a request with no Origin and no Referer needs no token', async () => {
    // curl, the .http files, a future mobile app. None of them has a cookie
    // jar an attacker's page can ride, so there is no CSRF to prevent — and
    // demanding a token would break every verification step in the build plan.
    const res = await request(app).post('/api/v1/_probe').send({ n: 5 })
    expect(res.status).toBe(200)
  })

  it('registration works from a plain client, cookies and all', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'csrf-free@test.dev',
      password: 'correct-horse-battery',
      displayName: 'Curl User',
    })

    expect(res.status).toBe(201)
  })
})

describe('safe methods', () => {
  it('are never blocked, whatever the origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.test')
    expect(res.status).toBe(200)
  })
})
