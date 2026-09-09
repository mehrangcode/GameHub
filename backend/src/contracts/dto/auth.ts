import { z } from 'zod'
import { AvatarKindSchema, LocaleSchema, UserRoleSchema } from '../enums.js'

/**
 * The auth wire shapes — 02 §7, 07 §5.
 *
 * These are the **same** schemas the login and register forms use in S39. The
 * frontend does not get to invent its own idea of a valid password: it imports
 * this file from its generated mirror, so a rule tightened here tightens in the
 * form on the next `contracts:sync`.
 *
 * Every request schema is `.strict()`. An unknown key is a rejected request,
 * not a silently dropped one (P7) — that is what turns a typo'd field name into
 * a 400 during development instead of a feature that quietly never worked.
 */

// ── Cookies and CSRF ─────────────────────────────────────────────────────────

/**
 * `access` and `refresh` are httpOnly and never visible to JS. `csrf` is not,
 * on purpose: the client has to read it to echo it back (07 §5.4).
 */
export const AUTH_COOKIES = {
  access: 'access',
  refresh: 'refresh',
  guest: 'guest',
  csrf: 'csrf',
} as const

export const CSRF_HEADER = 'x-csrf-token'

// ── Field rules ──────────────────────────────────────────────────────────────

/** Stored lower-cased and trimmed, so login is not case-sensitive on the domain. */
export const EmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((value) => value.toLowerCase())

/**
 * 07 §5.3 — **≥ 10 characters, no composition rules.** Requiring a digit and a
 * symbol reliably produces `Password1!`, which is worse than a long
 * passphrase. The upper bound is an argon2 denial-of-service guard, not a
 * policy: hashing a 10 MB "password" costs real memory.
 */
export const PasswordSchema = z.string().min(10, 'errors.passwordTooShort').max(200)

/**
 * Trimmed, no control characters, no leading/trailing whitespace games. The
 * *semantic* rules — reserved words like "Admin", profanity — live in
 * `application/policies/displayName.ts`, because a blocklist is policy that
 * changes without a contract change and has no business being shipped to the
 * browser.
 */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(2, 'errors.displayNameTooShort')
  .max(24, 'errors.displayNameTooLong')
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'errors.displayNameInvalid')

export const InviteCodeSchema = z.string().trim().min(4).max(32)

// ── Requests ─────────────────────────────────────────────────────────────────

export const RegisterRequestSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    displayName: DisplayNameSchema,
    locale: LocaleSchema.optional(),
    /** Where the player came from; becomes the post-signup redirect target. */
    inviteCode: InviteCodeSchema.optional(),
  })
  .strict()

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    /** Not `PasswordSchema`: a policy change must never lock out old passwords. */
    password: z.string().min(1).max(200),
  })
  .strict()

export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const GuestRequestSchema = z
  .object({
    inviteCode: InviteCodeSchema,
    displayName: DisplayNameSchema,
    locale: LocaleSchema.optional(),
  })
  .strict()

export type GuestRequest = z.infer<typeof GuestRequestSchema>

// ── Responses ────────────────────────────────────────────────────────────────

export const UserIdentitySchema = z.object({
  kind: z.literal('user'),
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  avatarKind: AvatarKindSchema,
  avatarRef: z.string().nullable(),
  locale: LocaleSchema,
  role: UserRoleSchema,
})

export type UserIdentity = z.infer<typeof UserIdentitySchema>

/** A guest identity always carries its one table. There is no unbound guest. */
export const GuestIdentitySchema = z.object({
  kind: z.literal('guest'),
  guestSessionId: z.string(),
  displayName: z.string(),
  tableId: z.string(),
  avatarRef: z.string().nullable(),
  locale: LocaleSchema,
  /** ISO 8601. The client shows "your guest session ends in …". */
  expiresAt: z.string(),
})

export type GuestIdentity = z.infer<typeof GuestIdentitySchema>

export const IdentitySchema = z.discriminatedUnion('kind', [
  UserIdentitySchema,
  GuestIdentitySchema,
])

export type Identity = z.infer<typeof IdentitySchema>

/** `GET /auth/me` returns the identity itself — no envelope to unwrap. */
export const MeResponseSchema = IdentitySchema
export type MeResponse = Identity

export const AuthSessionResponseSchema = z.object({
  identity: IdentitySchema,
  /**
   * Set when the caller arrived with an invite code — the table to send them
   * to once the cookies are in place. Journey J2 is exactly this field.
   */
  redirectTo: z.string().nullable(),
})

export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>

export const LogoutResponseSchema = z.object({ ok: z.literal(true) })
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>
