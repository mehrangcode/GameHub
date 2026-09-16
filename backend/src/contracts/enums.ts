import { z } from 'zod'

/**
 * The replacement for Prisma `enum`.
 *
 * 03-data-model.md §1 rule 1: SQLite has no enums, so every enumerated column
 * is a `String` in the schema and gets its meaning from exactly one place —
 * here. The `const` array is the runtime source of truth, the TS union is
 * derived from it, and the Zod schema validates it at every boundary. Adding a
 * value in one place and forgetting the other two is impossible by
 * construction.
 */

// ── Identity ─────────────────────────────────────────────────────────────────
export const USER_ROLES = ['USER', 'SUPPORT', 'ADMIN'] as const
export type UserRole = (typeof USER_ROLES)[number]
export const UserRoleSchema = z.enum(USER_ROLES)

export const USER_STATUSES = ['ACTIVE', 'DISABLED', 'BANNED'] as const
export type UserStatus = (typeof USER_STATUSES)[number]
export const UserStatusSchema = z.enum(USER_STATUSES)

export const AVATAR_KINDS = ['preset', 'upload', 'initials'] as const
export type AvatarKind = (typeof AVATAR_KINDS)[number]
export const AvatarKindSchema = z.enum(AVATAR_KINDS)

export const LOCALES = ['en', 'fa'] as const
export type Locale = (typeof LOCALES)[number]
export const LocaleSchema = z.enum(LOCALES)

export const IDENTITY_KINDS = ['user', 'guest'] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]
export const IdentityKindSchema = z.enum(IDENTITY_KINDS)

// ── Tables & seats ───────────────────────────────────────────────────────────
export const TABLE_STATUSES = ['WAITING', 'IN_PROGRESS', 'FINISHED', 'CLOSED'] as const
export type TableStatus = (typeof TABLE_STATUSES)[number]
export const TableStatusSchema = z.enum(TABLE_STATUSES)

export const TABLE_ORIGINS = ['PRIVATE', 'MATCHMADE'] as const
export type TableOrigin = (typeof TABLE_ORIGINS)[number]
export const TableOriginSchema = z.enum(TABLE_ORIGINS)

export const MEMBER_ROLES = ['PLAYER', 'SPECTATOR'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]
export const MemberRoleSchema = z.enum(MEMBER_ROLES)

export const BOT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number]
export const BotDifficultySchema = z.enum(BOT_DIFFICULTIES)

/** 04-realtime-protocol.md §6 — why a seat stopped being human-controlled. */
export const EJECTION_REASONS = ['TURN_TIMEOUT', 'ABANDON', 'KICKED'] as const
export type EjectionReason = (typeof EJECTION_REASONS)[number]
export const EjectionReasonSchema = z.enum(EJECTION_REASONS)

// ── Game state ───────────────────────────────────────────────────────────────
export const GAME_INSTANCE_STATUSES = ['ACTIVE', 'FINISHED', 'ABANDONED'] as const
export type GameInstanceStatus = (typeof GAME_INSTANCE_STATUSES)[number]
export const GameInstanceStatusSchema = z.enum(GAME_INSTANCE_STATUSES)

export const GAME_EVENT_KINDS = ['MOVE', 'DEAL', 'PHASE', 'TIMEOUT', 'SYSTEM', 'AUDIT'] as const
export type GameEventKind = (typeof GAME_EVENT_KINDS)[number]
export const GameEventKindSchema = z.enum(GAME_EVENT_KINDS)

// ── Chat ─────────────────────────────────────────────────────────────────────
export const CHAT_MESSAGE_KINDS = ['TEXT', 'EMOTE', 'SYSTEM'] as const
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number]
export const ChatMessageKindSchema = z.enum(CHAT_MESSAGE_KINDS)

// ── Results ──────────────────────────────────────────────────────────────────
export const MATCH_REASONS = ['NORMAL', 'RESIGNATION', 'TIMEOUT', 'ABANDONED', 'DRAW'] as const
export type MatchReason = (typeof MATCH_REASONS)[number]
export const MatchReasonSchema = z.enum(MATCH_REASONS)

/**
 * 10-economy-and-rewards.md §5.1. `EJECTED_*` is what drives `integrityFactor:
 * 0` — a per-seat multiplier, so an ejected player earns nothing even when
 * their team wins and their partner is paid in full.
 */
export const SEAT_OUTCOMES = [
  'COMPLETED',
  'EJECTED_TIMEOUT',
  'EJECTED_ABANDON',
  'RESIGNED',
  'REPLACED_RETURNED',
  'BOT',
  'KICKED',
] as const
export type SeatOutcome = (typeof SEAT_OUTCOMES)[number]
export const SeatOutcomeSchema = z.enum(SEAT_OUTCOMES)

// ── Cosmetics ────────────────────────────────────────────────────────────────
export const COSMETIC_CATEGORIES = [
  'CARD_BACK',
  'AVATAR',
  'AVATAR_FRAME',
  'FELT',
  'CARD_FACE',
  'THEME',
  'EMOTE_PACK',
  'BADGE',
] as const
export type CosmeticCategory = (typeof COSMETIC_CATEGORIES)[number]
export const CosmeticCategorySchema = z.enum(COSMETIC_CATEGORIES)

export const UNLOCK_KINDS = [
  'DEFAULT',
  'PLAY_COUNT',
  'WIN_COUNT',
  'ACHIEVEMENT',
  'PURCHASE',
  'PREMIUM_GRANT',
] as const
export type UnlockKind = (typeof UNLOCK_KINDS)[number]
export const UnlockKindSchema = z.enum(UNLOCK_KINDS)

export const THEMES = ['light', 'dark', 'system'] as const
export type Theme = (typeof THEMES)[number]
export const ThemeSchema = z.enum(THEMES)

export const NUMERAL_SYSTEMS = ['auto', 'latin', 'persian'] as const
export type NumeralSystem = (typeof NUMERAL_SYSTEMS)[number]
export const NumeralSystemSchema = z.enum(NUMERAL_SYSTEMS)

export const ANIMATION_SPEEDS = ['off', 'fast', 'normal'] as const
export type AnimationSpeed = (typeof ANIMATION_SPEEDS)[number]
export const AnimationSpeedSchema = z.enum(ANIMATION_SPEEDS)

// ── Economy ──────────────────────────────────────────────────────────────────
/**
 * `HINT` is a Sudoku hint point (`games/sudoku.md` §13) and rides the wallet for
 * one reason: the ledger already guarantees everything a spendable balance needs
 * — append-only rows, a balance that is Σ transactions, derived idempotency keys
 * under a unique constraint, the row-locked debit, reconciliation. A bespoke
 * counter would have to earn all of that back, and would get it wrong.
 *
 * It is **never** purchasable: a hint point is a gameplay advantage, so the
 * no-pay-to-win rule bars a store item, a premium grant and a COIN exchange
 * alike. Earned at 1 per 3 solved puzzles, spent one per hint.
 */
export const ASSET_CODES = ['COIN', 'GEM', 'TICKET', 'HINT'] as const
export type AssetCode = (typeof ASSET_CODES)[number]
export const AssetCodeSchema = z.enum(ASSET_CODES)

/** A guest's balance accrues but cannot be spent until it vests on signup. */
export const WALLET_STATUSES = ['VESTED', 'PROVISIONAL'] as const
export type WalletStatus = (typeof WALLET_STATUSES)[number]
export const WalletStatusSchema = z.enum(WALLET_STATUSES)

export const TRANSACTION_KINDS = [
  'MATCH_REWARD',
  'DAILY_BONUS',
  'ACHIEVEMENT',
  'PREMIUM_GRANT',
  'PURCHASE',
  'REFUND',
  'GUEST_VEST',
  'GUEST_FORFEIT',
  'ADMIN_ADJUST',
  /** Earned a Sudoku hint point — one per 3 solves (`games/sudoku.md` §13.1). */
  'HINT_GRANT',
  /** Spent one on a hint, inside the move's own transaction (§13.3). */
  'HINT_SPEND',
  /** Zero-amount audit row: the credit was capped. Never silence. */
  'CAP_REJECTED',
] as const
export type TransactionKind = (typeof TRANSACTION_KINDS)[number]
export const TransactionKindSchema = z.enum(TRANSACTION_KINDS)

export const SUBSCRIPTION_STATUSES = [
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'EXPIRED',
  'TRIALING',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]
export const SubscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES)

export const SUBSCRIPTION_EVENT_KINDS = [
  'created',
  'renewed',
  'payment_failed',
  'canceled',
] as const
export type SubscriptionEventKind = (typeof SUBSCRIPTION_EVENT_KINDS)[number]
export const SubscriptionEventKindSchema = z.enum(SUBSCRIPTION_EVENT_KINDS)

// ── Matchmaking ──────────────────────────────────────────────────────────────
export const MATCHMAKING_OUTCOMES = [
  'MATCHED',
  'TIMEOUT',
  'CANCELLED',
  'DISCONNECTED',
  'SERVER_RESTART',
  'BLOCKED',
] as const
export type MatchmakingOutcome = (typeof MATCHMAKING_OUTCOMES)[number]
export const MatchmakingOutcomeSchema = z.enum(MATCHMAKING_OUTCOMES)

// ── Security audit ───────────────────────────────────────────────────────────
export const SECURITY_EVENT_KINDS = [
  'ILLEGAL_MOVE',
  'NOT_YOUR_TURN',
  'BAD_TOKEN',
  'SEAT_IMPERSONATION',
  'RATE_LIMIT',
  'INVITE_ABUSE',
  /**
   * ★ E1, violated — S38. `Wallet.balance` disagrees with `Σ transactions`.
   *
   * Always an `ALERT`, and never self-healed: the interesting question is not
   * "what is the balance" (the ledger already answers that) but *"which write
   * path lied"*, and a job that quietly corrected the column would erase the
   * only evidence of it. 10 §2.3.
   */
  'LEDGER_DRIFT',
] as const
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number]
export const SecurityEventKindSchema = z.enum(SECURITY_EVENT_KINDS)

export const SECURITY_SEVERITIES = ['INFO', 'WARN', 'ALERT'] as const
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number]
export const SecuritySeveritySchema = z.enum(SECURITY_SEVERITIES)
