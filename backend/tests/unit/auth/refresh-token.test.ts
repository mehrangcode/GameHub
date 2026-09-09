import { describe, expect, it } from 'vitest'
import { getEnv, parseEnv } from '../../../src/config/env.js'
import {
  mintRefreshToken,
  refreshTokenHash,
} from '../../../src/infrastructure/auth/refreshToken.js'

const env = getEnv()

describe('refresh tokens', () => {
  it('mints an opaque high-entropy value', () => {
    const { token } = mintRefreshToken()
    // 32 random bytes, base64url — no padding, no dots, nothing to parse.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).not.toContain('.')
  })

  it('★ persists a hash — the raw token appears nowhere in the stored row', () => {
    const minted = mintRefreshToken()

    // This is the assertion that limits the damage of a database leak. Whatever
    // the repository writes is derived from `minted`, so serialising everything
    // except `token` is a faithful stand-in for the row.
    const { token, ...persisted } = minted
    const row = JSON.stringify(persisted)

    expect(row).not.toContain(token)
    expect(minted.tokenHash).not.toBe(token)
    expect(minted.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('hashes deterministically, so a presented token can be looked up', () => {
    const { token, tokenHash } = mintRefreshToken()
    expect(refreshTokenHash(token)).toBe(tokenHash)
  })

  it('is peppered — the same token hashes differently under another secret', () => {
    const { token, tokenHash } = mintRefreshToken()
    const other = parseEnv({ ...process.env, JWT_REFRESH_SECRET: 'z'.repeat(40) })

    expect(refreshTokenHash(token, other)).not.toBe(tokenHash)
  })

  it('never repeats a token or a hash', () => {
    const tokens = new Set<string>()
    const hashes = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const { token, tokenHash } = mintRefreshToken()
      tokens.add(token)
      hashes.add(tokenHash)
    }
    expect(tokens.size).toBe(200)
    expect(hashes.size).toBe(200)
  })

  it('starts a new rotation family per login', () => {
    expect(mintRefreshToken().familyId).not.toBe(mintRefreshToken().familyId)
  })

  it('★ keeps the family id when rotating inside one', () => {
    const login = mintRefreshToken()
    const rotated = mintRefreshToken({ familyId: login.familyId })

    expect(rotated.familyId).toBe(login.familyId)
    expect(rotated.token).not.toBe(login.token)
  })

  it('expires after the configured TTL', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const { expiresAt } = mintRefreshToken({ now, ttlSec: 60 * 60 * 24 * 30 }, env)
    expect(expiresAt.toISOString()).toBe('2026-01-31T00:00:00.000Z')
  })
})
