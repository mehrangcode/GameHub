import argon2 from 'argon2'
import type { Env } from '../../config/env.js'
import { getEnv } from '../../config/env.js'

/**
 * argon2**id**, not bcrypt — 02 §2.1, 07 §5.3.
 *
 * Two things this module exists to keep honest:
 *
 *   1. **The cost is configuration, not a literal.** Raising `m`/`t` is the
 *      standard answer to faster attacker hardware, and it should be an
 *      environment change, not a code change.
 *   2. **Stored hashes can be upgraded.** {@link needsRehash} reads the
 *      parameters back out of the encoded hash, so a login against a hash
 *      created under the old cost re-hashes at the new one (`AuthService.login`
 *      does this). Without it, raising the cost only protects new accounts.
 */

export interface Argon2Params {
  /** Memory in KiB — argon2's `m`. */
  readonly memoryCost: number
  /** Iterations — argon2's `t`. */
  readonly timeCost: number
  /** Lanes — argon2's `p`. */
  readonly parallelism: number
}

/** OWASP's current argon2id baseline, and the default in `env.ts`. */
export const OWASP_ARGON2ID: Argon2Params = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

export function argon2Params(env: Env = getEnv()): Argon2Params {
  return {
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  }
}

export async function hashPassword(
  plain: string,
  params: Argon2Params = argon2Params(),
): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, ...params })
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    // A malformed stored hash must read as "wrong password", never as a 500.
    return false
  }
}

/** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` */
const ENCODED = /^\$argon2(?<variant>id|i|d)\$v=\d+\$m=(?<m>\d+),t=(?<t>\d+),p=(?<p>\d+)\$/

/**
 * True when the stored hash is weaker than what we mint today — a different
 * argon2 variant, a lower cost, or a format we do not recognise at all.
 *
 * An unparseable hash counts as needing a rehash: that is what a leftover
 * bcrypt digest from some future import path looks like, and treating it as
 * "fine" is how a weak hash survives forever.
 */
export function needsRehash(hash: string, target: Argon2Params = argon2Params()): boolean {
  const groups = ENCODED.exec(hash)?.groups
  if (!groups) return true
  if (groups.variant !== 'id') return true

  return (
    Number(groups.m) < target.memoryCost ||
    Number(groups.t) < target.timeCost ||
    Number(groups.p) < target.parallelism
  )
}
