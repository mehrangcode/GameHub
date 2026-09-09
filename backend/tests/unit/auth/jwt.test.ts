import { describe, expect, it } from 'vitest'
import { getEnv, parseEnv } from '../../../src/config/env.js'
import {
  signAccessToken,
  TokenError,
  verifyAccessToken,
} from '../../../src/infrastructure/auth/jwt.js'

const env = getEnv()

async function expectTokenError(work: Promise<unknown>, failure: 'expired' | 'invalid') {
  await expect(work).rejects.toBeInstanceOf(TokenError)
  await expect(work).rejects.toMatchObject({ failure })
}

describe('access tokens', () => {
  it('round-trips the identity claims', async () => {
    const { token, jti } = await signAccessToken({ userId: 'u1', role: 'USER' })
    const claims = await verifyAccessToken(token)

    expect(claims).toEqual({ sub: 'u1', kind: 'user', role: 'USER', jti })
  })

  it('expires after the configured TTL', async () => {
    const { expiresAt } = await signAccessToken({
      userId: 'u1',
      role: 'USER',
      now: new Date('2026-01-01T00:00:00Z'),
      ttlSec: 600,
    })
    expect(expiresAt.toISOString()).toBe('2026-01-01T00:10:00.000Z')
  })

  it('★ reports an expired token distinguishably from a broken one', async () => {
    const { token } = await signAccessToken({
      userId: 'u1',
      role: 'USER',
      now: new Date(Date.now() - 3600_000),
      ttlSec: 60,
    })
    // The distinction is what the client acts on: 'expired' means "go refresh",
    // 'invalid' means "clear the cookies and stop trying".
    await expectTokenError(verifyAccessToken(token), 'expired')
  })

  it('★ rejects a tampered payload', async () => {
    const { token } = await signAccessToken({ userId: 'u1', role: 'USER' })
    const [header, payload, signature] = token.split('.') as [string, string, string]

    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    forged.role = 'ADMIN'
    const tampered = [
      header,
      Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url'),
      signature,
    ].join('.')

    await expectTokenError(verifyAccessToken(tampered), 'invalid')
  })

  it('rejects a token signed with a different secret', async () => {
    const other = parseEnv({ ...process.env, JWT_ACCESS_SECRET: 'z'.repeat(40) })
    const { token } = await signAccessToken({ userId: 'u1', role: 'USER' }, other)

    await expectTokenError(verifyAccessToken(token, env), 'invalid')
  })

  it('rejects a token minted for another audience', async () => {
    const other = parseEnv({ ...process.env, JWT_AUDIENCE: 'some-other-service' })
    const { token } = await signAccessToken({ userId: 'u1', role: 'USER' }, other)

    await expectTokenError(verifyAccessToken(token, env), 'invalid')
  })

  it('rejects an unsigned "alg: none" token outright', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'u1',
        kind: 'user',
        role: 'ADMIN',
        jti: 'x',
        iss: env.JWT_ISSUER,
        aud: env.JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url')

    await expectTokenError(verifyAccessToken(`${header}.${payload}.`), 'invalid')
  })

  it('rejects garbage', async () => {
    await expectTokenError(verifyAccessToken('not-a-token'), 'invalid')
    await expectTokenError(verifyAccessToken(''), 'invalid')
  })

  it('gives every token a distinct id', async () => {
    const a = await signAccessToken({ userId: 'u1', role: 'USER' })
    const b = await signAccessToken({ userId: 'u1', role: 'USER' })
    expect(a.jti).not.toBe(b.jti)
  })
})
