import { z } from 'zod'

/**
 * The admin auth surface — 12-admin-console.md §3.3, §5.
 *
 * Every request schema is `.strict()`, like the public ones: an unknown key is
 * a 400, not a silently-ignored field. That matters more here than anywhere
 * else in the codebase, because the seat-impersonation lesson generalises —
 * there must be no field with which a caller can name *whose* session to issue.
 * Identity comes from the password step and the challenge, never from the body.
 */

/** Separate names from the player cookies, so the two jars cannot collide. */
export const ADMIN_COOKIES = {
  access: 'admin_access',
  refresh: 'admin_refresh',
} as const

/** §3.2 — scoped so the cookies travel with admin requests and nothing else. */
export const ADMIN_COOKIE_PATH = '/admin'

// ── step 1: the password ───────────────────────────────────────────────────

export const AdminLoginRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict()

export type AdminLoginRequest = z.infer<typeof AdminLoginRequestSchema>

export const AdminLoginResponseSchema = z.object({
  /** Opaque. Spends itself on the `/auth/mfa` call. */
  challengeId: z.string(),
  ttlSec: z.number().int().positive(),
  /**
   * Present and `true` only for an admin who has never enrolled. The console
   * reads it as "send them to the enrollment screen", and the *server* enforces
   * the same thing regardless of what the client does with it.
   */
  enrollmentRequired: z.boolean().optional(),
})

export type AdminLoginResponse = z.infer<typeof AdminLoginResponseSchema>

// ── step 2: the code ───────────────────────────────────────────────────────

export const AdminMfaRequestSchema = z
  .object({
    challengeId: z.string().min(1),
    /**
     * Six digits, or a recovery code. Kept as one field because the operator
     * reaching for a recovery code has already lost their phone and should not
     * also have to find a different button.
     */
    code: z.string().min(6).max(32),
  })
  .strict()

export type AdminMfaRequest = z.infer<typeof AdminMfaRequestSchema>

// ── enrollment ─────────────────────────────────────────────────────────────

export const AdminEnrollRequestSchema = z.object({ challengeId: z.string().min(1) }).strict()

/**
 * Returned **exactly once**, and never recoverable.
 *
 * `secret` and `recoveryCodes` are in this payload and in no database column in
 * a readable form — `totpSecretEnc` is AES-256-GCM ciphertext and the recovery
 * codes are stored as sha256 hashes. An operator who closes this screen without
 * saving them re-enrolls; there is no "show me again", because a route that
 * could show it again is a route that can show it to somebody else.
 */
export const AdminEnrollResponseSchema = z.object({
  otpauthUri: z.string(),
  secret: z.string(),
  recoveryCodes: z.array(z.string()),
  /** The same challenge, still live: enroll then immediately prove the code. */
  challengeId: z.string(),
})

export type AdminEnrollResponse = z.infer<typeof AdminEnrollResponseSchema>

// ── step-up, and who am I ──────────────────────────────────────────────────

export const AdminStepUpRequestSchema = z.object({ code: z.string().min(6).max(32) }).strict()

export const AdminIdentitySchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['SUPPORT', 'ADMIN']),
  /** Last successful second factor. The console counts down from here. */
  mfaAt: z.string(),
  /** When the ⚡ window closes. Sent so the UI can pre-empt `STEP_UP_REQUIRED`. */
  stepUpValidUntil: z.string(),
  sessionExpiresAt: z.string(),
})

export type AdminIdentity = z.infer<typeof AdminIdentitySchema>
