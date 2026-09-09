import type { CookieOptions, Response } from 'express'
import { API_PREFIX } from '../../config/constants.js'
import { AUTH_COOKIES } from '../../contracts/dto/auth.js'
import type { Env } from '../../config/env.js'
import { getEnv } from '../../config/env.js'

/**
 * Every auth cookie the platform sets, in one place — 07 §5.3, §5.4.
 *
 * Three decisions worth defending:
 *
 *   1. **`httpOnly` on the credential cookies.** No JWT in `localStorage`: the
 *      single most common auth mistake in React apps. XSS cannot read what the
 *      browser will not hand to JS.
 *   2. **`sameSite: 'lax'`, not `'strict'`.** `Strict` breaks the invite-link
 *      journey — a friend arriving from WhatsApp is a cross-site navigation,
 *      and that journey is the product. `Lax` plus the CSRF double-submit is
 *      the correct trade (07 §5.4).
 *   3. **The refresh cookie is scoped to the auth path.** It is not attached to
 *      the hundreds of ordinary API calls that have no business seeing it, so
 *      its exposure surface is two endpoints instead of the whole API.
 */

/**
 * 07 §5.3 says `Path=/api/v1/auth/refresh`. We scope one segment wider, to
 * `/api/v1/auth`, because `POST /auth/logout` has to *read* the refresh cookie
 * to revoke its family — with the narrower path, logout would be unable to end
 * the session it is being asked to end. The intent of the original rule ("not
 * sent with every request") is preserved.
 */
export const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`

function base(env: Env): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Set only in production: a `Secure` cookie is dropped over plain http,
    // which would make the whole app unusable on localhost.
    secure: env.NODE_ENV === 'production',
    path: '/',
  }
}

export function setAccessCookie(res: Response, token: string, env: Env = getEnv()): void {
  res.cookie(AUTH_COOKIES.access, token, {
    ...base(env),
    maxAge: env.ACCESS_TOKEN_TTL_SEC * 1000,
  })
}

export function setRefreshCookie(res: Response, token: string, env: Env = getEnv()): void {
  res.cookie(AUTH_COOKIES.refresh, token, {
    ...base(env),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_SEC * 1000,
  })
}

export function setGuestCookie(res: Response, token: string, env: Env = getEnv()): void {
  res.cookie(AUTH_COOKIES.guest, token, {
    ...base(env),
    maxAge: env.GUEST_SESSION_TTL_SEC * 1000,
  })
}

/**
 * The one cookie that is **not** `httpOnly`, by design: the double-submit
 * defence requires the client to read the value and echo it in a header, which
 * an attacker's page cannot do across origins. The token is not a credential —
 * possession of it grants nothing without the session cookie.
 */
export function setCsrfCookie(res: Response, token: string, env: Env = getEnv()): void {
  res.cookie(AUTH_COOKIES.csrf, token, {
    ...base(env),
    httpOnly: false,
    maxAge: env.REFRESH_TOKEN_TTL_SEC * 1000,
  })
}

/**
 * Clears every auth cookie. `clearCookie` only matches on name **and path**, so
 * the refresh cookie must be cleared with the path it was set with — get this
 * wrong and logout leaves a live refresh cookie in the browser while looking
 * like it worked.
 */
export function clearAuthCookies(res: Response, env: Env = getEnv()): void {
  const options = base(env)
  res.clearCookie(AUTH_COOKIES.access, options)
  res.clearCookie(AUTH_COOKIES.guest, options)
  res.clearCookie(AUTH_COOKIES.refresh, { ...options, path: REFRESH_COOKIE_PATH })
  res.clearCookie(AUTH_COOKIES.csrf, { ...options, httpOnly: false })
}

export { AUTH_COOKIES }
