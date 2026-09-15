import type {
  GeneratedRecoveryCodes,
  IAdminTokenIssuer,
  ITotpProvider,
  MintedAdminRefresh,
  TotpVerdict,
} from '../../application/ports/admin.js'
import type { AdminEnv } from '../../config/env.js'
import { randomToken } from '../auth/tokens.js'
import { hashAdminRefreshToken, mintAdminRefreshToken } from './adminTokens.js'
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  totpUri,
  verifyTotp,
} from './totp.js'

/**
 * The admin ports, bound to real cryptography — the mirror of
 * `infrastructure/auth/adapters.ts`.
 *
 * ★ The encryption key is a constructor argument and nothing else. It is held
 * in one field on one object, and `AdminAuthService` — which decides whether a
 * code is valid — never sees it. That is the reason `ITotpProvider.verify`
 * takes the *ciphertext*: there is no call anywhere in the application layer
 * whose arguments include a usable second-factor secret, so there is nothing
 * for a log line, an error serialisation or a stack trace to leak.
 */
export class Aes256TotpProvider implements ITotpProvider {
  constructor(private readonly encryptionKey: string) {}

  generateSecret(): string {
    return generateTotpSecret()
  }

  encryptSecret(secret: string): string {
    return encryptTotpSecret(secret, this.encryptionKey)
  }

  provisioningUri(input: { secret: string; account: string; issuer: string }): string {
    return totpUri(input)
  }

  verify(
    encryptedSecret: string,
    code: string,
    options: { nowMs: number; minStep: number | null },
  ): TotpVerdict | null {
    let secret: string
    try {
      secret = decryptTotpSecret(encryptedSecret, this.encryptionKey)
    } catch {
      // An unenrollable or tampered secret is "the code does not verify", not a
      // 500. The caller then counts it as a failed attempt, which is the right
      // outcome: something is wrong with this credential and the operator
      // should be locked out of it rather than shown a stack trace.
      return null
    }
    return verifyTotp(secret, code, options)
  }

  generateRecoveryCodes(): GeneratedRecoveryCodes {
    return generateRecoveryCodes()
  }

  hashRecoveryCode(code: string): string {
    return hashRecoveryCode(code)
  }

  matchRecoveryCode(code: string, hashes: readonly string[]): string | null {
    return matchRecoveryCode(code, hashes)
  }
}

export class AdminTokenIssuer implements IAdminTokenIssuer {
  constructor(private readonly env: AdminEnv) {}

  mintRefreshToken(): MintedAdminRefresh {
    const token = mintAdminRefreshToken()
    return { token, hash: hashAdminRefreshToken(token, this.env) }
  }

  hashRefreshToken(token: string): string {
    return hashAdminRefreshToken(token, this.env)
  }

  /**
   * 24 bytes. A challenge is worth 120 seconds and cannot be used without the
   * second factor, so this is not a credential — but it names a half-finished
   * login, and anything guessable is a way to pair a stolen code with somebody
   * else's password step.
   */
  mintChallengeId(): string {
    return randomToken(24)
  }
}
