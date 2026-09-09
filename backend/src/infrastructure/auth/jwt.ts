import { SignJWT, errors as joseErrors, jwtVerify } from 'jose'
import type { UserRole } from '../../contracts/enums.js'
import { USER_ROLES } from '../../contracts/enums.js'
import type { Env } from '../../config/env.js'
import { getEnv } from '../../config/env.js'
import { randomToken } from './tokens.js'

/**
 * Access tokens — 07 §5.3.
 *
 * A short-lived **JWT**, so the common case (every authenticated request) costs
 * one HMAC verification and no database round-trip. That is the whole reason the
 * TTL is 10 minutes: a stateless token cannot be revoked, so the window in
 * which a revoked session still works must be short enough not to matter. Long
 * -lived authority lives in the refresh token, which *is* a database row and
 * *can* be killed (see `refreshToken.ts` and 03 §6.2).
 *
 * Refresh tokens are deliberately **not** JWTs. 07 §5.3 specifies an opaque
 * random value, because rotation, family revocation and reuse detection all
 * need server state anyway — a self-describing refresh token buys nothing and
 * costs revocability.
 */

export interface AccessTokenClaims {
  /** The user's id. Guests never get an access token; they get a guest token. */
  readonly sub: string
  readonly kind: 'user'
  readonly role: UserRole
  /** Token id — lands in `SecurityEvent.details` so an abusive token is nameable. */
  readonly jti: string
}

export type TokenFailure = 'expired' | 'invalid'

/**
 * Not an `AppError`: whether a bad token is a 401, a family revocation or a
 * silent cookie clear is the *caller's* decision, and the caller is middleware
 * that has the request in hand. This layer only reports what happened.
 */
export class TokenError extends Error {
  constructor(
    readonly failure: TokenFailure,
    message: string,
  ) {
    super(message)
    this.name = 'TokenError'
  }
}

export const isTokenExpired = (error: unknown): boolean =>
  error instanceof TokenError && error.failure === 'expired'

const encoder = new TextEncoder()
const ALGORITHM = 'HS256'

export interface SignAccessTokenInput {
  readonly userId: string
  readonly role: UserRole
  readonly now?: Date
  readonly ttlSec?: number
}

export interface SignedAccessToken {
  readonly token: string
  readonly jti: string
  readonly expiresAt: Date
}

export async function signAccessToken(
  input: SignAccessTokenInput,
  env: Env = getEnv(),
): Promise<SignedAccessToken> {
  const now = input.now ?? new Date()
  const ttlSec = input.ttlSec ?? env.ACCESS_TOKEN_TTL_SEC
  const issuedAtSec = Math.floor(now.getTime() / 1000)
  const expiresAtSec = issuedAtSec + ttlSec
  const jti = randomToken(12)

  const token = await new SignJWT({ kind: 'user', role: input.role })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(input.userId)
    .setJti(jti)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt(issuedAtSec)
    .setExpirationTime(expiresAtSec)
    .sign(encoder.encode(env.JWT_ACCESS_SECRET))

  return { token, jti, expiresAt: new Date(expiresAtSec * 1000) }
}

/**
 * Verifies signature, issuer, audience and expiry, then re-checks the shape of
 * the claims. The second check is not redundant: a valid signature only proves
 * *we* minted the token, not that its payload is what this version of the code
 * expects.
 *
 * @throws {TokenError} `'expired'` for a token that was fine and timed out —
 * the client's cue to hit `/auth/refresh` — and `'invalid'` for everything
 * else, which is a cue to clear the cookies and stop.
 */
export async function verifyAccessToken(
  token: string,
  env: Env = getEnv(),
): Promise<AccessTokenClaims> {
  let payload
  try {
    ;({ payload } = await jwtVerify(token, encoder.encode(env.JWT_ACCESS_SECRET), {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }))
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new TokenError('expired', 'access token expired')
    }
    throw new TokenError('invalid', 'access token failed verification')
  }

  const { sub, jti, kind, role } = payload as Record<string, unknown>
  if (typeof sub !== 'string' || typeof jti !== 'string' || kind !== 'user') {
    throw new TokenError('invalid', 'access token claims are not a user identity')
  }
  if (!USER_ROLES.includes(role as UserRole)) {
    throw new TokenError('invalid', 'access token carries an unknown role')
  }

  return { sub, jti, kind: 'user', role: role as UserRole }
}
