import type * as Rows from '@prisma/client'
import type { Prisma, PrismaClient } from '@prisma/client'
import type {
  AnimationSpeed,
  AssetCode,
  AvatarKind,
  BotDifficulty,
  ChatMessageKind,
  EjectionReason,
  GameEventKind,
  GameInstanceStatus,
  Locale,
  MemberRole,
  NumeralSystem,
  SecurityEventKind,
  SecuritySeverity,
  TableOrigin,
  TableStatus,
  Theme,
  TransactionKind,
  UserRole,
  UserStatus,
  WalletStatus,
} from '../../contracts/enums.js'
import type { Wallet, WalletTransaction } from '../../domain/entities/economy.js'
import type {
  GameEvent,
  GameInstance,
  GameSnapshot,
  SeatAssignment,
} from '../../domain/entities/game.js'
import type { ChatMessage, Invite, Table, TableMember } from '../../domain/entities/table.js'
import type {
  CosmeticItem,
  GuestSession,
  PlayerStats,
  RefreshToken,
  SecurityEvent,
  User,
  UserCosmetic,
  UserPreferences,
} from '../../domain/entities/user.js'
import type { SeatId } from '../../domain/value-objects/seat.js'

/**
 * The one place a Prisma row becomes a domain entity.
 *
 * Two conversions happen here and **nowhere else**:
 *
 *   1. `*Json: String` → a parsed object. SQLite cannot query into JSON, so the
 *      schema stores text (03 §1 rule 3). A `JSON.parse` anywhere in a service
 *      would mean the boundary leaked.
 *   2. `String` → a TS union. The schema has no enums for portability, so the
 *      widening back to `UserRole`, `TableStatus`, … lands right here, against
 *      the vocabulary in `contracts/enums.ts`.
 *
 * The casts are deliberate and confined: the database is the only thing that
 * could hold a value outside the union, and it got that value from this
 * codebase.
 */
export type Db = PrismaClient | Prisma.TransactionClient

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

function parseJsonOrNull<T>(text: string | null): T | null {
  return text === null ? null : parseJson<T>(text)
}

export const toJson = (value: unknown): string => JSON.stringify(value)
export const toJsonOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value)

export function toUser(row: Rows.User): User {
  return {
    ...row,
    avatarKind: row.avatarKind as AvatarKind,
    locale: row.locale as Locale,
    role: row.role as UserRole,
    status: row.status as UserStatus,
  }
}

export function toGuestSession(row: Rows.GuestSession): GuestSession {
  const { prefsJson, ...rest } = row
  return {
    ...rest,
    locale: row.locale as Locale,
    prefs: parseJsonOrNull<Record<string, unknown>>(prefsJson),
  }
}

export function toRefreshToken(row: Rows.RefreshToken): RefreshToken {
  return row
}

export function toUserPreferences(row: Rows.UserPreferences): UserPreferences {
  const { extraJson, ...rest } = row
  return {
    ...rest,
    theme: row.theme as Theme,
    locale: row.locale as Locale,
    numeralSystem: row.numeralSystem as NumeralSystem,
    animationSpeed: row.animationSpeed as AnimationSpeed,
    extra: parseJsonOrNull<Record<string, unknown>>(extraJson),
  }
}

export function toPlayerStats(row: Rows.PlayerStats): PlayerStats {
  const { extraJson, ...rest } = row
  return { ...rest, extra: parseJsonOrNull<Record<string, unknown>>(extraJson) }
}

export function toSecurityEvent(row: Rows.SecurityEvent): SecurityEvent {
  const { detailsJson, ...rest } = row
  return {
    ...rest,
    kind: row.kind as SecurityEventKind,
    severity: row.severity as SecuritySeverity,
    details: parseJsonOrNull<Record<string, unknown>>(detailsJson),
  }
}

export function toCosmeticItem(row: Rows.CosmeticItem): CosmeticItem {
  const { unlockParamsJson, ...rest } = row
  return { ...rest, unlockParams: parseJsonOrNull<Record<string, unknown>>(unlockParamsJson) }
}

export function toUserCosmetic(row: Rows.UserCosmetic): UserCosmetic {
  return row
}

export function toTable(row: Rows.Table): Table {
  const { optionsJson, ...rest } = row
  return {
    ...rest,
    status: row.status as TableStatus,
    origin: row.origin as TableOrigin,
    options: parseJson<Record<string, unknown>>(optionsJson),
  }
}

export function toTableMember(row: Rows.TableMember): TableMember {
  return {
    ...row,
    seat: row.seat as SeatId | null,
    role: row.role as MemberRole,
    botDifficulty: row.botDifficulty as BotDifficulty | null,
    ejectionReason: row.ejectionReason as EjectionReason | null,
  }
}

export function toInvite(row: Rows.Invite): Invite {
  return row
}

export function toChatMessage(row: Rows.ChatMessage): ChatMessage {
  const { paramsJson, ...rest } = row
  return {
    ...rest,
    kind: row.kind as ChatMessageKind,
    params: parseJsonOrNull<Record<string, unknown>>(paramsJson),
  }
}

export function toGameInstance(row: Rows.GameInstance): GameInstance {
  const { seatingJson, optionsJson, ...rest } = row
  return {
    ...rest,
    status: row.status as GameInstanceStatus,
    seating: parseJson<SeatAssignment[]>(seatingJson),
    options: parseJson<Record<string, unknown>>(optionsJson),
  }
}

export function toGameEvent(row: Rows.GameEvent): GameEvent {
  const { payloadJson, ...rest } = row
  return {
    ...rest,
    kind: row.kind as GameEventKind,
    seat: row.seat as SeatId | null,
    payload: parseJson<Record<string, unknown>>(payloadJson),
  }
}

export function toGameSnapshot(row: Rows.GameSnapshot): GameSnapshot {
  const { stateJson, ...rest } = row
  return { ...rest, state: parseJson<Record<string, unknown>>(stateJson) }
}

export function toWallet(row: Rows.Wallet): Wallet {
  return {
    ...row,
    assetCode: row.assetCode as AssetCode,
    status: row.status as WalletStatus,
  }
}

export function toWalletTransaction(row: Rows.WalletTransaction): WalletTransaction {
  return {
    ...row,
    assetCode: row.assetCode as AssetCode,
    kind: row.kind as TransactionKind,
  }
}
