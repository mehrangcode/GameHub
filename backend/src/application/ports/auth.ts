import type { UserRole } from '../../contracts/enums.js'

/**
 * The auth primitives, as ports.
 *
 * `application/` may not import `infrastructure/` (02 §5.1, enforced by
 * ESLint), and argon2, jose and `node:crypto` are all infrastructure. So
 * `AuthService` depends on these three interfaces and `container.ts` passes the
 * adapters in `infrastructure/auth/adapters.ts`.
 *
 * That is not ceremony for its own sake: it is what lets the auth *flow* —
 * rotation, family revocation, reuse detection, the twelve-step claim
 * transaction in S22 — be tested without spending 50 ms of argon2 per case and
 * without a real clock. The rules are the interesting part; the crypto is
 * already tested in `tests/unit/auth/`.
 */

export interface IPasswordHasher {
  hash(plain: string): Promise<string>
  /** False for a wrong password *and* for a malformed stored hash. Never throws. */
  verify(hash: string, plain: string): Promise<boolean>
  /** True when the stored hash is weaker than the current cost. */
  needsRehash(hash: string): boolean
}

export interface IssuedAccessToken {
  readonly token: string
  readonly jti: string
  readonly expiresAt: Date
}

export interface IssuedRefreshToken {
  /** Goes in the cookie and is never persisted. */
  readonly token: string
  /** Goes in `RefreshToken.tokenHash`. */
  readonly tokenHash: string
  readonly familyId: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export interface ITokenIssuer {
  issueAccess(input: { userId: string; role: UserRole }): Promise<IssuedAccessToken>
  /** Omit `familyId` for a fresh login; pass it to rotate inside a family. */
  issueRefresh(input?: { familyId?: string }): IssuedRefreshToken
  /** Turns a presented cookie value into the stored hash, for lookup. */
  hashRefresh(token: string): string
}

export interface IssuedGuestToken {
  readonly token: string
  readonly tokenHash: string
  readonly tableId: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export interface ParsedGuestToken {
  readonly tableId: string
  readonly tokenHash: string
}

export interface IGuestTokenIssuer {
  issue(input: { tableId: string }): IssuedGuestToken
  /**
   * Verifies the signature and reports which table the token names.
   *
   * @throws when the token is malformed or forged. The caller decides whether
   * that is a silent cookie clear or a `SEAT_IMPERSONATION` audit row.
   */
  parse(token: string): ParsedGuestToken
}

/** What the HTTP layer knows about the caller, for audit rows and token rows. */
export interface RequestContext {
  readonly ip?: string | null
  readonly userAgent?: string | null
}
