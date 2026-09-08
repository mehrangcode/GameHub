import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../../src/config/env.js'

const valid = {
  NODE_ENV: 'test',
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file:./test.db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  GUEST_TOKEN_SECRET: 'c'.repeat(32),
} as const

describe('env schema', () => {
  it('parses a complete environment and applies defaults', () => {
    const env = parseEnv({ ...valid })
    expect(env.PORT).toBe(3000)
    expect(env.ADMIN_PORT).toBe(3100)
    expect(env.CORS_ORIGIN).toBe('http://localhost:5173')
    expect(env.REDIS_URL).toBeUndefined()
  })

  it('throws when a required variable is missing', () => {
    const { DATABASE_URL: _omitted, ...withoutDbUrl } = valid
    expect(() => parseEnv(withoutDbUrl)).toThrowError(/DATABASE_URL/)
  })

  it('throws on a malformed PORT rather than coercing it to NaN', () => {
    expect(() => parseEnv({ ...valid, PORT: 'not-a-number' })).toThrowError(/PORT/)
  })

  it('rejects a short JWT secret', () => {
    expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'too-short' })).toThrowError(
      /at least 32 characters/,
    )
  })

  it('rejects an unknown DATABASE_PROVIDER — the schema targets sqlite ∩ postgresql', () => {
    expect(() => parseEnv({ ...valid, DATABASE_PROVIDER: 'mysql' })).toThrowError(
      /DATABASE_PROVIDER/,
    )
  })
})
