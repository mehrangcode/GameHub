import { SignJWT, errors as joseErrors, jwtVerify } from 'jose'
import type { CookieOptions, Response } from 'express'
import type { AdminEnv } from '../../config/env.js'
import { ADMIN_COOKIES, ADMIN_COOKIE_PATH } from '../../contracts/admin/auth.js'
import { hmac256, randomToken } from '../auth/tokens.js'

/**
 * Admin credentials — 12-admin-console.md §3.2.
 *
 * The shape mirrors the player side (`infrastructure/auth/jwt.ts`): a short
 * JWT for the common case, an opaque random value for the long-lived half. It
 * is a *separate* mirror rather than a shared function, and the difference is
 * the point of this file:
 *
 *   - **The audience differs**, so a player access token presented to `:3100`
 *     fails verification, and an admin token presented to `:3000` fails there.
 *     Logging into the game does not log you into the console; the two are
 *     unrelated objects and the cryptography says so rather than a comment.
 *   - **`sid` travels in the claims.** A player access token is deliberately
 *     stateless for ten minutes; an admin one names its `AdminSession`, which
 *     is loaded on every request. That costs one indexed read and buys IP
 *     pinning, idle expiry and instant revocation — trades worth making for a
 *     surface that can mint coins and ban people.
 */

const encoder = new TextEncoder()
const ALGORITHM = 'HS256'

/** A player token's audience is `JWT_AUDIENCE`; this is deliberately not that. */
export const adminAudience = (env: AdminEnv): string => `${env.JWT_AUDIENCE}-admin`

export interface AdminAccessClaims {
  /** The admin's `User.id`. */
  readonly sub: string
  readonly kind: 'admin'
  /** The `AdminSession.id` this token belongs to. */
  readonly sid: string
}

export type AdminTokenFailure = 'expired' | 'invalid'

export class AdminTokenError extends Error {
  constructor(
    readonly failure: AdminTokenFailure,
    message: string,
  ) {
    super(message)
    this.name = 'AdminTokenError'
  }
}

export async function signAdminAccessToken(
  input: { userId: string; sessionId: string; now?: Date; ttlSec?: number },
  env: AdminEnv,
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date()
  const ttlSec = input.ttlSec ?? env.ADMIN_ACCESS_TTL_SEC
  const issuedAtSec = Math.floor(now.getTime() / 1000)
  const expiresAtSec = issuedAtSec + ttlSec

  const token = await new SignJWT({ kind: 'admin', sid: input.sessionId })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(input.userId)
    .setJti(randomToken(12))
    .setIssuer(env.JWT_ISSUER)
    .setAudience(adminAudience(env))
    .setIssuedAt(issuedAtSec)
    .setExpirationTime(expiresAtSec)
    .sign(encoder.encode(env.JWT_ACCESS_SECRET))

  return { token, expiresAt: new Date(expiresAtSec * 1000) }
}

/** @throws {AdminTokenError} */
export async function verifyAdminAccessToken(
  token: string,
  env: AdminEnv,
): Promise<AdminAccessClaims> {
  let payload
  try {
    ;({ payload } = await jwtVerify(token, encoder.encode(env.JWT_ACCESS_SECRET), {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: adminAudience(env),
    }))
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new AdminTokenError('expired', 'admin access token expired')
    }
    throw new AdminTokenError('invalid', 'admin access token failed verification')
  }

  const { sub, kind, sid } = payload as Record<string, unknown>
  if (typeof sub !== 'string' || typeof sid !== 'string' || kind !== 'admin') {
    // A *player* access token lands here if the audiences are ever aligned by
    // accident. It is refused on the claim shape as well, deliberately: two
    // independent reasons to say no, because one of them is a config value.
    throw new AdminTokenError('invalid', 'token is not an admin session token')
  }

  return { sub, kind: 'admin', sid }
}

/**
 * The refresh half: opaque, random, never self-describing. Only its HMAC is
 * stored, keyed by `JWT_REFRESH_SECRET`, exactly as player refresh tokens are —
 * so a database dump yields no usable session, and rotating the secret logs
 * every admin out, deliberately.
 */
export function mintAdminRefreshToken(): string {
  return randomToken(32)
}

export function hashAdminRefreshToken(token: string, env: AdminEnv): string {
  return hmac256(token, env.JWT_REFRESH_SECRET)
}

/**
 * Admin cookies, and every difference from the player's is a decision — §3.2:
 *
 *   - **`SameSite=Strict`**, where the player cookies are `Lax`. `Lax` exists
 *     for the invite-link journey, which is the product; nobody arrives at the
 *     admin console from a link in a chat, and `Strict` closes the
 *     cross-site-navigation class outright. It is also why this app needs no
 *     CSRF double-submit at all.
 *   - **`Path=/admin`**, so the cookies are not attached to anything else the
 *     operator's browser happens to fetch from that host.
 *   - **`Secure` in production**, as with the player cookies.
 */
function base(env: AdminEnv): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    path: ADMIN_COOKIE_PATH,
  }
}

export function setAdminCookies(
  res: Response,
  tokens: { access: string; refresh: string },
  env: AdminEnv,
): void {
  res.cookie(ADMIN_COOKIES.access, tokens.access, {
    ...base(env),
    maxAge: env.ADMIN_ACCESS_TTL_SEC * 1000,
  })
  res.cookie(ADMIN_COOKIES.refresh, tokens.refresh, {
    ...base(env),
    maxAge: env.ADMIN_SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000,
  })
}

export function clearAdminCookies(res: Response, env: AdminEnv): void {
  const options = base(env)
  res.clearCookie(ADMIN_COOKIES.access, options)
  res.clearCookie(ADMIN_COOKIES.refresh, options)
}
