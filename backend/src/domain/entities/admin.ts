import type {
  AdminAction,
  AdminTargetType,
  GameFlagState,
} from '../../contracts/admin/enums.js'

/**
 * The admin console's entities — 12-admin-console.md §4.
 *
 * Same conversion boundary as everywhere else: the schema stores JSON as
 * `String` and unions as `String`, and `infrastructure/prisma/mappers.ts` is
 * the one place either is widened. `recoveryCodeHashes` is a `string[]` here
 * and a JSON column there; `before`/`after` are unknown objects here and JSON
 * text there.
 */

export interface AdminCredential {
  readonly id: string
  readonly userId: string
  /**
   * AES-256-GCM `iv:tag:ciphertext`, or `''` for a seeded admin who has never
   * enrolled (12 §4.1). Nothing decrypts it without checking
   * {@link totpEnrolledAt} first, and `decryptTotpSecret` refuses `''` outright.
   */
  readonly totpSecretEnc: string
  /** `null` ⇒ unenrolled, and the *only* thing that decides that. */
  readonly totpEnrolledAt: Date | null
  /** The replay guard (§3.3): a code at or below this step is refused. */
  readonly lastTotpStep: number | null
  /** sha256 of each unused recovery code. Removed as they are spent. */
  readonly recoveryCodeHashes: readonly string[]
  readonly failedAttempts: number
  readonly lockedUntil: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * An admin session — 12 §3.2. Unrelated to a `RefreshToken`: logging into the
 * game does not log you into the console.
 *
 * Three clocks run on one row, and all three are needed:
 *
 * | Field | Bound | Answers |
 * |---|---|---|
 * | `expiresAt` | 8 h absolute | "how long can one login last, however busy" |
 * | `lastSeenAt` | 30 min idle | "is this an abandoned tab, or a laptop lid" |
 * | `mfaAt` | 5 min step-up | "was the human here *recently*" |
 */
export interface AdminSession {
  readonly id: string
  readonly userId: string
  /** HMAC of the refresh token. The raw value appears in no row. */
  readonly tokenHash: string
  /** Pinned: a session presented from a new address is revoked, not refreshed. */
  readonly ip: string
  readonly userAgent: string
  readonly mfaAt: Date
  readonly createdAt: Date
  readonly lastSeenAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | null
}

/**
 * ★ One row per admin action, appended inside the action's own transaction —
 * 12 §3.5, invariant A3.
 *
 * There is no `update` and no `delete`, here or on the repository, and the
 * Postgres migration REVOKEs both from the app role. The hash chain makes a
 * deletion *detectable* rather than impossible, which is the strongest thing a
 * log the application can write can honestly claim.
 */
export interface AdminAuditEntry {
  readonly id: string
  readonly actorUserId: string
  readonly actorIp: string
  readonly actorUserAgent: string
  /** Ties the row to the request log line, and to any `SecurityEvent` it raised. */
  readonly requestId: string
  readonly action: AdminAction
  readonly targetType: AdminTargetType
  readonly targetId: string
  /** Mandatory for 📝 actions, enforced before the transaction opens. */
  readonly reason: string | null
  readonly before: unknown
  readonly after: unknown
  /** `null` on the genesis row only. */
  readonly prevHash: string | null
  readonly hash: string
  readonly createdAt: Date
}

export interface GameFlag {
  readonly slug: string
  readonly state: GameFlagState
  readonly reason: string | null
  readonly updatedAt: Date
  readonly updatedByUserId: string | null
}

export interface PlatformFlag {
  readonly key: string
  /** Parsed from the JSON column — a scalar or an object, per key. */
  readonly value: unknown
  readonly updatedAt: Date
  readonly updatedByUserId: string | null
}
