import argon2 from 'argon2'

/**
 * argon2**id**, not bcrypt — 02-technical-prd.md §2.1.
 *
 * Parameters live here rather than at call sites so raising them later is one
 * edit. S11 moves them into config and adds the verify-and-rehash path; this is
 * the minimum the seed needs to create the admin account.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP's current argon2id baseline
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    // A malformed stored hash must read as "wrong password", never as a 500.
    return false
  }
}
