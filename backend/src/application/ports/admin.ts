/**
 * The admin console's outbound ports — 02 §5.1's dependency direction applied
 * to 12-admin-console.md §3.3.
 *
 * `AdminAuthService` needs a TOTP implementation, an encryption key and a
 * random-token source, and every one of those is `infrastructure/`. It gets
 * them through these interfaces for the same reason `AuthService` takes an
 * `IPasswordHasher` rather than importing argon2: ESLint guard 1 forbids the
 * import, and the reason the guard exists is that a service which can be
 * constructed without a database or a keyring is a service whose logic can be
 * tested exhaustively.
 *
 * The key never appears in any signature here. `ITotpProvider` is constructed
 * *with* it in `container.ts` and closes over it, so the service that decides
 * whether a code is valid has no way to leak the material that makes it valid.
 */

export interface TotpVerdict {
  /** The step that matched. Stored as `lastTotpStep` — the replay guard. */
  readonly step: number
}

export interface GeneratedRecoveryCodes {
  /** Shown to the operator once. Never stored in this form. */
  readonly codes: readonly string[]
  readonly hashes: readonly string[]
}

export interface ITotpProvider {
  generateSecret(): string
  /** Returns the value for `AdminCredential.totpSecretEnc`. */
  encryptSecret(secret: string): string
  provisioningUri(input: { secret: string; account: string; issuer: string }): string

  /**
   * Verifies a code against an **encrypted** secret.
   *
   * Taking the ciphertext rather than the plaintext is deliberate: it means the
   * decrypted secret exists only inside this call, and there is no point in the
   * service where a plaintext TOTP secret is in a variable that could be
   * logged, serialised into an error, or passed somewhere it does not belong.
   */
  verify(
    encryptedSecret: string,
    code: string,
    options: { nowMs: number; minStep: number | null },
  ): TotpVerdict | null

  generateRecoveryCodes(): GeneratedRecoveryCodes
  hashRecoveryCode(code: string): string
  /** The stored hash a code matches, or `null`. Constant-time. */
  matchRecoveryCode(code: string, hashes: readonly string[]): string | null
}

export interface MintedAdminRefresh {
  /** Goes in the `admin_refresh` cookie. */
  readonly token: string
  /** Goes in `AdminSession.tokenHash`. The raw value is in no row. */
  readonly hash: string
}

export interface IAdminTokenIssuer {
  mintRefreshToken(): MintedAdminRefresh
  hashRefreshToken(token: string): string
  /** Opaque, unguessable, and worth 120 seconds — see `AdminAuthService`. */
  mintChallengeId(): string
}

/** The numbers from 12 §2.5, passed as values the way every other service takes them. */
export interface AdminAuthPolicy {
  readonly challengeTtlSec: number
  readonly sessionAbsoluteHours: number
  readonly sessionIdleMin: number
  readonly stepUpWindowMin: number
  readonly mfaMaxAttempts: number
  readonly lockoutMin: number
  /** Labels the operator's authenticator entry. `JWT_ISSUER`. */
  readonly issuer: string
}
