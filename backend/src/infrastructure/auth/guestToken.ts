import type { Env } from '../../config/env.js'
import { getEnv } from '../../config/env.js'
import { TokenError } from './jwt.js'
import { hmac256, randomToken, safeEqual, sha256 } from './tokens.js'

/**
 * Table-bound guest tokens — 07 §3, 07 §5.1.
 *
 * The one property that matters: **a guest token names the table it is good
 * for, and the name is signed.** The format is
 *
 *     g1.<base64url(tableId)>.<nonce>.<hmac over the first three fields>
 *
 * so `verifyGuestToken(token, tableId)` can reject a cross-table use *before*
 * touching the database, and `parseGuestToken` can route the lookup without
 * trusting the caller for the table id. The `GuestSession` row carries the same
 * non-nullable `tableId`, so the binding is asserted twice, in two independent
 * places — which is deliberate. This is the privilege-escalation primitive the
 * whole guest feature would otherwise hand out for free.
 *
 * At rest we store `sha256(token)`. The pepper is already inside the token (the
 * HMAC), so a second keyed hash would add nothing.
 */

const VERSION = 'g1'

export interface MintedGuestToken {
  /** Goes into the cookie. */
  readonly token: string
  /** Goes into `GuestSession.tokenHash`. */
  readonly tokenHash: string
  readonly tableId: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export function guestTokenHash(token: string): string {
  return sha256(token)
}

export interface MintGuestTokenInput {
  readonly tableId: string
  readonly now?: Date
  readonly ttlSec?: number
}

export function mintGuestToken(input: MintGuestTokenInput, env: Env = getEnv()): MintedGuestToken {
  const now = input.now ?? new Date()
  const ttlSec = input.ttlSec ?? env.GUEST_SESSION_TTL_SEC
  const body = `${VERSION}.${encodeTableId(input.tableId)}.${randomToken(18)}`
  const token = `${body}.${hmac256(body, env.GUEST_TOKEN_SECRET)}`

  return {
    token,
    tokenHash: guestTokenHash(token),
    tableId: input.tableId,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlSec * 1000),
  }
}

export interface ParsedGuestToken {
  readonly tableId: string
  readonly tokenHash: string
}

/**
 * Checks the signature and returns the table the token is bound to.
 *
 * @throws {TokenError} `'invalid'` — a guest token never "expires" here;
 * expiry lives on the `GuestSession` row so it can slide with activity
 * (07 §5.1) rather than being frozen into the token at mint time.
 */
export function parseGuestToken(token: string, env: Env = getEnv()): ParsedGuestToken {
  const parts = token.split('.')
  if (parts.length !== 4) throw new TokenError('invalid', 'guest token is malformed')

  const [version, encodedTableId, , signature] = parts as [string, string, string, string]
  if (version !== VERSION) throw new TokenError('invalid', 'guest token version is not supported')

  const body = `${version}.${encodedTableId}.${parts[2]}`
  if (!safeEqual(signature, hmac256(body, env.GUEST_TOKEN_SECRET))) {
    throw new TokenError('invalid', 'guest token signature does not verify')
  }

  const tableId = decodeTableId(encodedTableId)
  if (tableId.length === 0) throw new TokenError('invalid', 'guest token names no table')

  return { tableId, tokenHash: guestTokenHash(token) }
}

/**
 * `parseGuestToken` plus the binding check. Use this wherever the expected
 * table is already known; a mismatch is a `SEAT_IMPERSONATION`-worthy event,
 * not a formatting problem, so the caller gets a distinct message.
 */
export function verifyGuestToken(
  token: string,
  tableId: string,
  env: Env = getEnv(),
): ParsedGuestToken {
  const parsed = parseGuestToken(token, env)
  if (parsed.tableId !== tableId) {
    throw new TokenError('invalid', 'guest token is bound to a different table')
  }
  return parsed
}

// base64url keeps the cuid out of the delimiter set; ids are opaque either way.
const encodeTableId = (tableId: string): string =>
  Buffer.from(tableId, 'utf8').toString('base64url')
const decodeTableId = (encoded: string): string =>
  Buffer.from(encoded, 'base64url').toString('utf8')
