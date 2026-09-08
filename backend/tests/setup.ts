/**
 * Runs before every test file. Establishes a valid, deterministic environment
 * so `src/config/env.ts` parses cleanly no matter what the developer's shell
 * happens to hold.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  ADMIN_PORT: '3100',
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file:./test.db',
  CORS_ORIGIN: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdefghijklmno',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdefghijklmno',
  GUEST_TOKEN_SECRET: 'test-guest-secret-0123456789abcdefghijklmno',
  LOG_LEVEL: 'error',
}

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] = value
}

delete process.env.REDIS_URL
