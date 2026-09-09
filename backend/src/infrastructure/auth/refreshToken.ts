import type { Env } from '../../config/env.js'
import { getEnv } from '../../config/env.js'
import { hmac256, randomToken } from './tokens.js'

/**
 * Refresh tokens — 07 §5.3, 03 §6.2.
 *
 * Opaque 256-bit random values. **Nothing is derivable from one**: it is a
 * lookup key into `RefreshToken`, and every interesting property (which family
 * it belongs to, whether it was rotated, whether the family was revoked) is a
 * column, not a claim. That is what makes reuse detection possible at all.
 *
 * What is persisted is `hmac256(token, JWT_REFRESH_SECRET)` — a *peppered*
 * hash. Plain sha256 of a 256-bit random value is already preimage-safe, so the
 * pepper is not load-bearing; it costs one line and means a stolen database
 * alone cannot even be used to confirm a guessed token. The trade is explicit:
 * rotating `JWT_REFRESH_SECRET` invalidates every session.
 */

export interface MintedRefreshToken {
  /** Goes into the cookie. Never written anywhere. */
  readonly token: string
  /** Goes into `RefreshToken.tokenHash`. */
  readonly tokenHash: string
  readonly familyId: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export function refreshTokenHash(token: string, env: Env = getEnv()): string {
  return hmac256(token, env.JWT_REFRESH_SECRET)
}

export interface MintRefreshTokenInput {
  /**
   * Omit to start a **new** rotation family (a fresh login). Pass the existing
   * family to rotate inside it — 03 §6.2's containment property depends on
   * every descendant of one login sharing this id.
   */
  readonly familyId?: string
  readonly now?: Date
  readonly ttlSec?: number
}

export function mintRefreshToken(
  input: MintRefreshTokenInput = {},
  env: Env = getEnv(),
): MintedRefreshToken {
  const now = input.now ?? new Date()
  const ttlSec = input.ttlSec ?? env.REFRESH_TOKEN_TTL_SEC
  const token = randomToken(32)

  return {
    token,
    tokenHash: refreshTokenHash(token, env),
    familyId: input.familyId ?? randomToken(16),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlSec * 1000),
  }
}
