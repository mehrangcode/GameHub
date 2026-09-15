/**
 * Runs before every test file. Establishes a valid, deterministic environment
 * so `src/config/env.ts` parses cleanly no matter what the developer's shell
 * happens to hold.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  ADMIN_PORT: '3100',
  CORS_ORIGIN: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdefghijklmno',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdefghijklmno',
  GUEST_TOKEN_SECRET: 'test-guest-secret-0123456789abcdefghijklmno',
  LOG_LEVEL: 'error',
}

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] = value
}

/**
 * The database pair is the one thing the shell may override, and the only
 * reason is 11 §12 S45: *"the API works against Postgres, not just SQLite —
 * the same test suite, `DATABASE_PROVIDER=postgresql`"*. The schema targets
 * the SQLite ∩ PostgreSQL intersection, and that discipline is a claim until
 * the suite has actually run on both.
 *
 * Everything above stays unconditional on purpose: a developer's stray
 * `LOG_LEVEL` or `PORT` must not change what the tests assert. These two are
 * different — they select *which database engine the assertions run against*,
 * which is exactly the axis the exercise varies.
 *
 * Default is still SQLite, so a bare `npm test` is unchanged.
 */
process.env.DATABASE_PROVIDER ??= 'sqlite'
process.env.DATABASE_URL ??= 'file:./test.db'

delete process.env.REDIS_URL
