import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

// dotenv never overwrites an already-set variable, so an explicit environment
// (CI, docker, a test setup file) always wins over the .env file on disk.
loadDotenv()

/** 32 bytes — AES-256. Declared above the schema because the message interpolates it. */
const TOTP_KEY_BYTES = 32
const TOTP_KEY_MESSAGE = `must be base64 decoding to exactly ${TOTP_KEY_BYTES} bytes (openssl rand -base64 32)`

function isTotpKey(value: string): boolean {
  try {
    return Buffer.from(value, 'base64').length === TOTP_KEY_BYTES
  } catch {
    return false
  }
}

/**
 * P7 — fail fast, loudly, at the boundary. Every environment variable the
 * process depends on is declared here and parsed once at startup; a missing or
 * malformed value exits the process rather than surfacing as `undefined` three
 * layers down.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  /** 02-technical-prd.md §6.1 — the schema targets the SQLite ∩ Postgres intersection. */
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgresql']),
  DATABASE_URL: z.string().min(1),

  /** Unset in dev → in-memory socket adapter + in-process rate limiter. */
  REDIS_URL: z.string().url().optional(),

  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /**
   * Peppers the refresh-token hash. Refresh tokens are opaque random values,
   * not JWTs (07 §5.3), so this secret keys the HMAC that is stored in
   * `RefreshToken.tokenHash` — rotating it logs everyone out, deliberately.
   */
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  GUEST_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),

  /** Identifies our own tokens; a token minted for another audience is rejected. */
  JWT_ISSUER: z.string().min(1).default('boardgames'),
  JWT_AUDIENCE: z.string().min(1).default('boardgames-api'),

  /** 07 §5.3 — 10 minutes. Short enough that revocation lag is bounded. */
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(600),
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

  /**
   * argon2id cost (07 §5.3, OWASP baseline `m=19456,t=2,p=1`). In config rather
   * than hard-coded because raising it is the standard response to faster
   * hardware, and `needsRehash` upgrades stored hashes on the next login.
   */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19_456),
  // 2 is also argon2's own floor — the library rejects t=1 outright.
  ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

  /** Global per-IP sliding window (S12). Redis-backed from S27. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  /** 07 §5.3 — 5 login attempts per 15 min, per email *and* per IP. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_SEC: z.coerce.number().int().positive().default(900),

  /**
   * How long a minted invite link stays usable (S19). A day covers "we're
   * playing tonight" without leaving a live join capability in a chat log for
   * a month; the host may ask for anything up to 30 days per link.
   */
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /**
   * Per-IP budget for `GET /invites/:code`, which is public and therefore the
   * one endpoint someone can spray codes at (07 §5.2). Generous enough that a
   * pre-join screen reloading is never throttled.
   */
  INVITE_RESOLVE_MAX: z.coerce.number().int().positive().default(30),
  INVITE_RESOLVE_WINDOW_SEC: z.coerce.number().int().positive().default(60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@local.dev'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('change-me-before-prod'),

  // ── 12-admin-console.md §2.5 — the admin process ─────────────────────────
  //
  // These sit in the *shared* schema, and only `ADMIN_TOTP_ENC_KEY` is treated
  // differently: see `AdminEnvSchema` below for why it is optional here and
  // required there.
  /** The second entrypoint's port. Never published — Caddy reaches it internally. */
  ADMIN_PORT: z.coerce.number().int().positive().max(65535).default(3100),
  /** `0.0.0.0` inside Docker (the network is the boundary), `127.0.0.1` bare-metal. */
  ADMIN_BIND: z.string().min(1).default('127.0.0.1'),
  /** The *only* allowed CORS origin for the admin app. */
  ADMIN_ORIGIN: z.string().url().default('http://localhost:5273'),

  /**
   * AES-256-GCM key for TOTP secrets at rest, base64, decoding to exactly 32
   * bytes. Optional here and **required by `AdminEnvSchema`** — the public API
   * has no business holding the key that decrypts second factors, and a
   * developer running `npm run dev` should not have to invent one.
   */
  ADMIN_TOTP_ENC_KEY: z.string().refine(isTotpKey, { message: TOTP_KEY_MESSAGE }).optional(),

  /** 12 §3.2 — 15 min access, 8 h absolute, 30 min idle. */
  ADMIN_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  ADMIN_SESSION_IDLE_MIN: z.coerce.number().int().positive().default(30),
  ADMIN_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(8),
  /** 12 §3.4 — how long a fresh TOTP authorises a ⚡ action. */
  ADMIN_STEPUP_WINDOW_MIN: z.coerce.number().int().positive().default(5),
  /** The password step hands out a challenge; the code step spends it. */
  ADMIN_CHALLENGE_TTL_SEC: z.coerce.number().int().positive().default(120),
  /** 12 §3.3 — 5 failed codes → locked for 15 minutes, plus a `SecurityEvent`. */
  ADMIN_MFA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  ADMIN_LOCKOUT_MIN: z.coerce.number().int().positive().default(15),

  /**
   * Belt-and-braces on top of TOTP. A comma-separated CIDR/address list;
   * **empty disables it**, which is the correct default for an operator on a
   * domestic connection with a rotating address.
   */
  ADMIN_IP_ALLOWLIST: z.string().default(''),

  /**
   * 12 §6.3 — how the api process hears about a new `ControlCommand`. `poll`
   * is a supported configuration, not a degraded one: the row is the
   * authority either way, and Redis only makes it feel instant.
   */
  CONTROL_TRANSPORT: z.enum(['redis', 'poll']).default('poll'),
})

/**
 * ★ The admin process's environment — 12 §2.5, and the one line of S48 that is
 * a refusal rather than a default.
 *
 * `admin-main.ts` parses with this instead of {@link EnvSchema}, so a missing
 * `ADMIN_TOTP_ENC_KEY` stops the admin process at boot with a message naming
 * the variable. The alternative — generating a key when one is absent — would
 * silently invalidate every enrolled second factor on the next restart, which
 * presents as "my authenticator app stopped working" and is diagnosed by
 * nobody.
 *
 * The public API keeps using `EnvSchema` and never sees the key at all.
 */
export const AdminEnvSchema = EnvSchema.extend({
  ADMIN_TOTP_ENC_KEY: z
    .string({ required_error: 'is required — the admin process will not start without it' })
    .refine(isTotpKey, { message: TOTP_KEY_MESSAGE }),
})

export type Env = z.output<typeof EnvSchema>
export type AdminEnv = z.output<typeof AdminEnvSchema>

/** Throws a `ZodError`. Used by tests; production code wants {@link loadEnv}. */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(raw)
}

/** As {@link parseEnv}, against the stricter admin schema. */
export function parseAdminEnv(raw: NodeJS.ProcessEnv = process.env): AdminEnv {
  return AdminEnvSchema.parse(raw)
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

/**
 * The same contract as {@link loadEnv}, for `admin-main.ts`. Separate rather
 * than a flag because the difference is not a setting — it is which schema the
 * process is held to, and a boolean argument would let the admin process be
 * started against the lenient one by accident.
 */
export function loadAdminEnv(raw: NodeJS.ProcessEnv = process.env): AdminEnv {
  const result = AdminEnvSchema.safeParse(raw)
  if (!result.success) {
    console.error(
      '\nInvalid admin environment — refusing to start:\n' + formatIssues(result.error) + '\n',
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
