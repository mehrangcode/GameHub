import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../../src/config/env.js'
import {
  argon2Params,
  hashPassword,
  needsRehash,
  OWASP_ARGON2ID,
  verifyPassword,
} from '../../../src/infrastructure/auth/password.js'

describe('argon2id password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct-horse-battery')
    await expect(verifyPassword(hash, 'correct-horse-battery')).resolves.toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery')
    await expect(verifyPassword(hash, 'correct-horse-batteri')).resolves.toBe(false)
  })

  it('★ hashes the same password to two different digests — the salt is per-hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')])
    expect(a).not.toBe(b)
    // Both still verify: the salt travels inside the encoded hash.
    await expect(verifyPassword(a, 'same-password')).resolves.toBe(true)
    await expect(verifyPassword(b, 'same-password')).resolves.toBe(true)
  })

  it('uses argon2id, not argon2i or argon2d', async () => {
    expect(await hashPassword('whatever-passphrase')).toMatch(/^\$argon2id\$/)
  })

  it('reads its cost from config, not from a literal', () => {
    const env = parseEnv({
      ...process.env,
      ARGON2_MEMORY_KIB: '32768',
      ARGON2_TIME_COST: '3',
      ARGON2_PARALLELISM: '2',
    })
    expect(argon2Params(env)).toEqual({ memoryCost: 32_768, timeCost: 3, parallelism: 2 })
  })

  it('defaults to the OWASP baseline when nothing is configured', () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      DATABASE_PROVIDER: 'sqlite',
      DATABASE_URL: 'file:./test.db',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
      GUEST_TOKEN_SECRET: 'c'.repeat(32),
    })
    expect(argon2Params(env)).toEqual(OWASP_ARGON2ID)
  })

  it('treats a malformed stored hash as a wrong password, never as a crash', async () => {
    await expect(verifyPassword('not-a-hash-at-all', 'anything')).resolves.toBe(false)
    await expect(verifyPassword('', 'anything')).resolves.toBe(false)
  })
})

describe('needsRehash — raising the cost has to reach existing accounts', () => {
  const target = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }

  it('says no for a hash at the current cost', async () => {
    expect(needsRehash(await hashPassword('a-long-enough-pass', target), target)).toBe(false)
  })

  it('★ says yes for a hash cheaper than the current cost', async () => {
    const weak = await hashPassword('a-long-enough-pass', {
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
    })
    expect(needsRehash(weak, target)).toBe(true)
  })

  it('says no for a hash stronger than the current cost — never downgrade', async () => {
    const strong = await hashPassword('a-long-enough-pass', {
      memoryCost: 32_768,
      timeCost: 3,
      parallelism: 1,
    })
    expect(needsRehash(strong, target)).toBe(false)
  })

  it('says yes for a different argon2 variant', () => {
    expect(needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', target)).toBe(true)
  })

  it('says yes for a format it does not recognise — a stray bcrypt must not survive', () => {
    expect(needsRehash('$2b$12$abcdefghijklmnopqrstuv', target)).toBe(true)
    expect(needsRehash('plain-text-oh-no', target)).toBe(true)
  })
})
