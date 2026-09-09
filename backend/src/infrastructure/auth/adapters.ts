import type {
  IGuestTokenIssuer,
  IPasswordHasher,
  ITokenIssuer,
  IssuedAccessToken,
  IssuedGuestToken,
  IssuedRefreshToken,
  ParsedGuestToken,
} from '../../application/ports/auth.js'
import type { UserRole } from '../../contracts/enums.js'
import type { Env } from '../../config/env.js'
import { getEnv } from '../../config/env.js'
import { mintGuestToken, parseGuestToken } from './guestToken.js'
import { signAccessToken } from './jwt.js'
import { argon2Params, hashPassword, needsRehash, verifyPassword } from './password.js'
import { mintRefreshToken, refreshTokenHash } from './refreshToken.js'

/**
 * Thin adapters binding the auth ports to the real primitives.
 *
 * Deliberately dumb: every method is one call. All the reasoning lives in the
 * modules they delegate to, and all the *policy* lives in `AuthService`. If a
 * decision ever creeps in here it is in the wrong place — this file exists only
 * so the dependency arrow points the right way.
 */

export class Argon2PasswordHasher implements IPasswordHasher {
  constructor(private readonly env: Env = getEnv()) {}

  hash(plain: string): Promise<string> {
    return hashPassword(plain, argon2Params(this.env))
  }

  verify(hash: string, plain: string): Promise<boolean> {
    return verifyPassword(hash, plain)
  }

  needsRehash(hash: string): boolean {
    return needsRehash(hash, argon2Params(this.env))
  }
}

export class JwtTokenIssuer implements ITokenIssuer {
  constructor(private readonly env: Env = getEnv()) {}

  issueAccess(input: { userId: string; role: UserRole }): Promise<IssuedAccessToken> {
    return signAccessToken(input, this.env)
  }

  issueRefresh(input: { familyId?: string } = {}): IssuedRefreshToken {
    return mintRefreshToken(input, this.env)
  }

  hashRefresh(token: string): string {
    return refreshTokenHash(token, this.env)
  }
}

export class HmacGuestTokenIssuer implements IGuestTokenIssuer {
  constructor(private readonly env: Env = getEnv()) {}

  issue(input: { tableId: string }): IssuedGuestToken {
    return mintGuestToken(input, this.env)
  }

  parse(token: string): ParsedGuestToken {
    return parseGuestToken(token, this.env)
  }
}
