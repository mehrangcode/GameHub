import type {
  AvatarKind,
  Locale,
  NumeralSystem,
  AnimationSpeed,
  SecurityEventKind,
  SecuritySeverity,
  Theme,
  UserRole,
  UserStatus,
} from '../../contracts/enums.js'

export interface User {
  readonly id: string
  readonly email: string
  /** argon2id. Never leaves the backend; DTO mappers must not carry it. */
  readonly passwordHash: string
  readonly displayName: string
  readonly avatarKind: AvatarKind
  readonly avatarRef: string | null
  readonly locale: Locale
  readonly role: UserRole
  readonly status: UserStatus
  readonly statusReason: string | null
  readonly statusChangedAt: Date | null
  /** The acting admin's `User.id`, per 12 §3. */
  readonly statusChangedBy: string | null
  readonly emailVerified: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly lastSeenAt: Date | null
}

/**
 * Persona P2. A guest identity is bound to exactly one table (07 §3) — a token
 * that worked on any table would be a privilege-escalation primitive, so
 * `tableId` is non-nullable here by design, not by accident.
 */
export interface GuestSession {
  readonly id: string
  readonly tokenHash: string
  readonly displayName: string
  readonly tableId: string
  readonly avatarRef: string | null
  /** Preferences chosen before signup; carried over by the claim transaction. */
  readonly prefs: Record<string, unknown> | null
  readonly locale: Locale
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly lastSeenAt: Date | null
  readonly claimedAt: Date | null
  readonly claimedByUserId: string | null
}

export interface RefreshToken {
  readonly id: string
  readonly userId: string
  /** sha256 of the token. The raw value exists only in the cookie. */
  readonly tokenHash: string
  /** Rotation family (03 §6.2): reuse of any member revokes the whole family. */
  readonly familyId: string
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | null
  readonly replacedById: string | null
  readonly userAgent: string | null
  readonly ip: string | null
}

export interface UserPreferences {
  readonly userId: string
  readonly theme: Theme
  readonly locale: Locale
  readonly numeralSystem: NumeralSystem
  readonly cardBackId: string | null
  readonly cardFaceId: string | null
  readonly feltId: string | null
  readonly animationSpeed: AnimationSpeed
  readonly soundEnabled: boolean
  readonly soundVolume: number
  /** Display only. The server always sends `legalMoves`; this changes nothing. */
  readonly showLegalMoveHints: boolean
  readonly reducedMotion: boolean
  readonly extra: Record<string, unknown> | null
  readonly updatedAt: Date
}

export interface PlayerStats {
  readonly id: string
  readonly userId: string
  readonly gameSlug: string
  readonly played: number
  readonly won: number
  readonly lost: number
  readonly drawn: number
  readonly forfeited: number
  readonly currentStreak: number
  readonly bestStreak: number
  readonly totalMs: number
  readonly extra: Record<string, unknown> | null
  readonly updatedAt: Date
}

export interface CosmeticItem {
  readonly id: string
  readonly category: string
  /** An i18n key, never literal text — the catalog is bilingual. */
  readonly nameKey: string
  readonly assetRef: string
  readonly unlockKind: string
  readonly unlockParams: Record<string, unknown> | null
  readonly gameSlug: string | null
  readonly sortOrder: number
  readonly active: boolean
  readonly externalRef: string | null
  readonly transferable: boolean
}

export interface UserCosmetic {
  readonly id: string
  readonly userId: string
  readonly cosmeticId: string
  readonly unlockedAt: Date
}

/** 07 §6 — the trail that catches a friend poking at the API. */
export interface SecurityEvent {
  readonly id: string
  readonly kind: SecurityEventKind
  readonly severity: SecuritySeverity
  readonly userId: string | null
  readonly guestSessionId: string | null
  readonly tableId: string | null
  readonly gameId: string | null
  readonly ip: string | null
  readonly userAgent: string | null
  readonly details: Record<string, unknown> | null
  readonly createdAt: Date
}
