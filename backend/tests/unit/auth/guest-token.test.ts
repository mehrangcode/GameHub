import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../../src/config/env.js'
import {
  guestTokenHash,
  mintGuestToken,
  parseGuestToken,
  verifyGuestToken,
} from '../../../src/infrastructure/auth/guestToken.js'
import { TokenError } from '../../../src/infrastructure/auth/jwt.js'

describe('table-bound guest tokens', () => {
  it('carries the table it was minted for', () => {
    const { token } = mintGuestToken({ tableId: 'table-a' })
    expect(parseGuestToken(token).tableId).toBe('table-a')
  })

  it('verifies against its own table', () => {
    const { token, tokenHash } = mintGuestToken({ tableId: 'table-a' })
    expect(verifyGuestToken(token, 'table-a').tokenHash).toBe(tokenHash)
  })

  it('★ a guest token for table A does not verify against table B', () => {
    const { token } = mintGuestToken({ tableId: 'table-a' })

    // The whole point of P2 not being a privilege-escalation hole: a leaked
    // guest cookie is worth exactly one already-public table (07 §5.1).
    expect(() => verifyGuestToken(token, 'table-b')).toThrow(TokenError)
    expect(() => verifyGuestToken(token, 'table-b')).toThrow(/different table/)
  })

  it('★ cannot be re-pointed at another table by editing the token', () => {
    const { token } = mintGuestToken({ tableId: 'table-a' })
    const parts = token.split('.')
    parts[1] = Buffer.from('table-b', 'utf8').toString('base64url')

    // Rewriting the table id breaks the HMAC, so the forgery fails before any
    // database lookup happens.
    expect(() => parseGuestToken(parts.join('.'))).toThrow(/signature/)
  })

  it('rejects a token signed with a different secret', () => {
    const other = parseEnv({ ...process.env, GUEST_TOKEN_SECRET: 'z'.repeat(40) })
    const { token } = mintGuestToken({ tableId: 'table-a' }, other)

    expect(() => parseGuestToken(token)).toThrow(/signature/)
  })

  it('rejects malformed and empty tokens', () => {
    for (const bad of ['', 'nope', 'g1.a.b', 'g1.a.b.c.d', 'g9.YQ.bbb.ccc']) {
      expect(() => parseGuestToken(bad), bad).toThrow(TokenError)
    }
  })

  it('★ stores only a hash — the raw token is not in the persisted row', () => {
    const minted = mintGuestToken({ tableId: 'table-a' })
    const { token, ...persisted } = minted

    expect(JSON.stringify(persisted)).not.toContain(token)
    expect(guestTokenHash(token)).toBe(minted.tokenHash)
  })

  it('never repeats a token for the same table', () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => mintGuestToken({ tableId: 'table-a' }).token),
    )
    expect(tokens.size).toBe(100)
  })

  it('expires after the configured 12 hours', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const { expiresAt } = mintGuestToken({ tableId: 'table-a', now, ttlSec: 12 * 60 * 60 })
    expect(expiresAt.toISOString()).toBe('2026-01-01T12:00:00.000Z')
  })
})
