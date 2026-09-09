import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../../../src/config/env.js'
import {
  AUTH_COOKIES,
  clearAuthCookies,
  REFRESH_COOKIE_PATH,
  setAccessCookie,
  setCsrfCookie,
  setGuestCookie,
  setRefreshCookie,
} from '../../../src/infrastructure/auth/cookies.js'

/** A one-route app whose only job is to emit `Set-Cookie` headers. */
function cookieApp(env: Env) {
  const app = express()
  app.get('/set', (_req, res) => {
    setAccessCookie(res, 'access-token', env)
    setRefreshCookie(res, 'refresh-token', env)
    setGuestCookie(res, 'guest-token', env)
    setCsrfCookie(res, 'csrf-token', env)
    res.json({ ok: true })
  })
  app.get('/clear', (_req, res) => {
    clearAuthCookies(res, env)
    res.json({ ok: true })
  })
  return app
}

async function setCookies(env: Env): Promise<string[]> {
  const res = await request(cookieApp(env)).get('/set')
  return res.headers['set-cookie'] as unknown as string[]
}

const find = (headers: string[], name: string): string =>
  headers.find((header) => header.startsWith(`${name}=`)) ?? ''

const devEnv = parseEnv({ ...process.env, NODE_ENV: 'development' })
const prodEnv = parseEnv({ ...process.env, NODE_ENV: 'production' })

describe('auth cookies', () => {
  it('marks the credential cookies httpOnly — XSS cannot read them', async () => {
    const headers = await setCookies(devEnv)

    for (const name of [AUTH_COOKIES.access, AUTH_COOKIES.refresh, AUTH_COOKIES.guest]) {
      expect(find(headers, name), name).toMatch(/HttpOnly/i)
    }
  })

  it('★ leaves the csrf cookie readable — the client has to echo it back', async () => {
    expect(find(await setCookies(devEnv), AUTH_COOKIES.csrf)).not.toMatch(/HttpOnly/i)
  })

  it('uses SameSite=Lax so the invite-link journey survives', async () => {
    const headers = await setCookies(devEnv)
    // Strict would break a friend arriving from WhatsApp — the product's
    // core journey (07 §5.4).
    expect(find(headers, AUTH_COOKIES.access)).toMatch(/SameSite=Lax/i)
    expect(find(headers, AUTH_COOKIES.guest)).toMatch(/SameSite=Lax/i)
  })

  it('★ sets Secure under NODE_ENV=production', async () => {
    const headers = await setCookies(prodEnv)

    for (const name of Object.values(AUTH_COOKIES)) {
      expect(find(headers, name), name).toMatch(/Secure/i)
    }
  })

  it('omits Secure in development — a Secure cookie is dropped over http', async () => {
    expect(find(await setCookies(devEnv), AUTH_COOKIES.access)).not.toMatch(/Secure/i)
  })

  it('★ scopes the refresh cookie to the auth path, not the whole API', async () => {
    const headers = await setCookies(devEnv)

    expect(find(headers, AUTH_COOKIES.refresh)).toContain(`Path=${REFRESH_COOKIE_PATH}`)
    expect(find(headers, AUTH_COOKIES.access)).toContain('Path=/')
  })

  it('gives each cookie its configured lifetime', async () => {
    const headers = await setCookies(devEnv)
    const maxAge = (header: string) => Number(/Max-Age=(\d+)/i.exec(header)?.[1])

    expect(maxAge(find(headers, AUTH_COOKIES.access))).toBe(devEnv.ACCESS_TOKEN_TTL_SEC)
    expect(maxAge(find(headers, AUTH_COOKIES.refresh))).toBe(devEnv.REFRESH_TOKEN_TTL_SEC)
    expect(maxAge(find(headers, AUTH_COOKIES.guest))).toBe(devEnv.GUEST_SESSION_TTL_SEC)
  })

  it('★ clears the refresh cookie on the path it was set with', async () => {
    const res = await request(cookieApp(devEnv)).get('/clear')
    const headers = res.headers['set-cookie'] as unknown as string[]

    // clearCookie matches on name *and* path. Getting this wrong leaves a live
    // refresh cookie in the browser while logout reports success.
    expect(find(headers, AUTH_COOKIES.refresh)).toContain(`Path=${REFRESH_COOKIE_PATH}`)
    for (const name of Object.values(AUTH_COOKIES)) {
      expect(find(headers, name), name).toMatch(/=;/)
    }
  })
})
