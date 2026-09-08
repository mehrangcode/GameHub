import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

// dotenv never overwrites an already-set variable, so an explicit environment
// (CI, docker, a test setup file) always wins over the .env file on disk.
loadDotenv()

/**
 * P7 — fail fast, loudly, at the boundary. Every environment variable the
 * process depends on is declared here and parsed once at startup; a missing or
 * malformed value exits the process rather than surfacing as `undefined` three
 * layers down.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  /** 12-admin-console.md §2.1 — the admin process. Never published. */
  ADMIN_PORT: z.coerce.number().int().positive().max(65535).default(3100),

  /** 02-technical-prd.md §6.1 — the schema targets the SQLite ∩ Postgres intersection. */
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgresql']),
  DATABASE_URL: z.string().min(1),

  /** Unset in dev → in-memory socket adapter + in-process rate limiter. */
  REDIS_URL: z.string().url().optional(),

  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  GUEST_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),

  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),
  GUEST_SESSION_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 12),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@local.dev'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('change-me-before-prod'),
})

export type Env = z.output<typeof EnvSchema>

/** Throws a `ZodError`. Used by tests; production code wants {@link loadEnv}. */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(raw)
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
}

/**
 * Parses the environment or exits the process with a readable message.
 * Called once from an entrypoint; everything else uses {@link getEnv}.
 */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(raw)
  if (!result.success) {
    console.error(
      '\nInvalid environment — refusing to start:\n' + formatIssues(result.error) + '\n',
    )
    process.exit(1)
  }
  return result.data
}

let cached: Env | undefined

export function getEnv(): Env {
  cached ??= loadEnv()
  return cached
}

/** Test hook: forget the memoised environment so a new one can be parsed. */
export function resetEnvCache(): void {
  cached = undefined
}
