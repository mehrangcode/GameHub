import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The shared crypto primitives behind every opaque token in the system.
 *
 * `base64url` throughout: the values travel in cookies, URLs and invite links,
 * and `+`/`/`/`=` are exactly the characters that get mangled on the way.
 */

/** 32 bytes = 256 bits. Guessing one is not a threat model, it is a fantasy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

/**
 * A *peppered* hash: the digest cannot be recomputed from a stolen database
 * alone, because the key lives in the environment. Used for refresh tokens —
 * see the note on `JWT_REFRESH_SECRET` in `config/env.ts`.
 */
export function hmac256(value: string, key: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url')
}

/**
 * Constant-time string compare.
 *
 * `a === b` on a secret leaks its prefix through timing. The length check
 * before `timingSafeEqual` leaks only the length, which for fixed-width tokens
 * is public anyway — and `timingSafeEqual` throws on a length mismatch, so it
 * cannot be skipped.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
