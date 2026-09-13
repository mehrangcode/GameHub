import type { SecurityEventKind } from '../../contracts/enums.js'
import type {
  GuestSession,
  RefreshToken,
  SecurityEvent,
  User,
  UserPreferences,
} from '../entities/user.js'
import type { Draft, IRepository, PageQuery } from './IRepository.js'

export type NewUser = Draft<
  User,
  | 'avatarKind'
  | 'avatarRef'
  | 'locale'
  | 'role'
  | 'status'
  | 'statusReason'
  | 'statusChangedAt'
  | 'statusChangedBy'
  | 'emailVerified'
  | 'lastSeenAt'
>

export interface IUserRepository extends IRepository<User> {
  /**
   * @throws {EmailTakenError} when `email` is already registered.
   *
   * The **database's** unique constraint decides, not a `findByEmail` check in
   * the caller — a read-then-write test would let two simultaneous sign-ups
   * with one address both pass. Same discipline as `claimSeat` (03 §6.3).
   */
  create(data: NewUser): Promise<User>
  /** Emails are stored already-normalised; this is an exact match. */
  findByEmail(email: string): Promise<User | null>
  /**
   * Batch lookup for display names — a table's seat map, an invite's host, a
   * match's participants (S18).
   *
   * Exists so rendering a four-seat table costs one query instead of four, and
   * so the N+1 is impossible rather than merely discouraged. Missing ids are
   * simply absent from the result; the caller decides whether that is an error,
   * because for a seat map it is not (a deleted account leaves an empty seat).
   */
  findManyByIds(ids: readonly string[]): Promise<User[]>
  touchLastSeen(id: string, at: Date): Promise<void>
}

export type NewGuestSession = Draft<
  GuestSession,
  'avatarRef' | 'prefs' | 'locale' | 'lastSeenAt' | 'claimedAt' | 'claimedByUserId'
>

export interface IGuestSessionRepository extends IRepository<GuestSession> {
  create(data: NewGuestSession): Promise<GuestSession>
  findByTokenHash(tokenHash: string): Promise<GuestSession | null>
  listByTable(tableId: string): Promise<GuestSession[]>
  /** Batch lookup for seat-map display names, exactly as {@link IUserRepository.findManyByIds}. */
  findManyByIds(ids: readonly string[]): Promise<GuestSession[]>
  /**
   * ★ Step 11 of the claim transaction (03 §6.1), and its arbitration point.
   *
   * Stamps `claimedAt`/`claimedByUserId` **only if the session is still
   * unclaimed**, and returns `null` when someone else got there first. That
   * conditional is what makes the twelve-step claim race-safe: two requests
   * with the same guest cookie both read an unclaimed session, both build a
   * user, and exactly one of them can commit — the loser's whole transaction
   * rolls back, including the account it created. A `findById`-then-`update`
   * pair cannot express that; under PostgreSQL's default isolation both racers
   * read the same unclaimed row. Same discipline as
   * {@link IRefreshTokenRepository.revokeIfActive} and `claimSeat`.
   *
   * The row is kept forever, never deleted: it is the audit link between the
   * two identities, and it is what guarantees the guest token stops working.
   *
   * An unknown `id` also returns `null` rather than throwing — the caller
   * cannot act on the difference between "already claimed" and "no such
   * session", since both mean the same thing to it.
   */
  claimIfUnclaimed(id: string, userId: string, at: Date): Promise<GuestSession | null>

  /**
   * Sessions past `expiresAt` that nobody ever claimed — S38's forfeiture job.
   *
   * Claimed sessions are excluded because their coins already vested (10 §3.4)
   * and their wallet is already empty; forfeiting one would be a second debit
   * of money that has moved.
   *
   * Paged, and ordered oldest-first, so a platform that has not run the job for
   * a month works through the backlog in a bounded number of passes instead of
   * loading every dead session ever created.
   */
  listExpiredUnclaimed(now: Date, limit: number): Promise<GuestSession[]>
  deleteExpired(now: Date): Promise<number>
}

export type NewRefreshToken = Draft<
  RefreshToken,
  'issuedAt' | 'revokedAt' | 'replacedById' | 'userAgent' | 'ip'
>

export interface IRefreshTokenRepository extends IRepository<RefreshToken> {
  create(data: NewRefreshToken): Promise<RefreshToken>
  findByTokenHash(tokenHash: string): Promise<RefreshToken | null>
  listActiveByUser(userId: string, now: Date): Promise<RefreshToken[]>
  revoke(id: string, at: Date, replacedById?: string): Promise<RefreshToken>
  /**
   * ★ Claims a token for rotation, atomically.
   *
   * Revokes it **only if it is still active** and reports whether this caller
   * won. Returns `false` when someone else already rotated it — two refreshes
   * racing, which S39's single-flight interceptor exists to avoid but which the
   * server must survive regardless. Crucially this is *not* the same thing as a
   * replay: a replay presents a token that was already revoked when it was
   * first looked up, and that path revokes the whole family.
   *
   * A `findByTokenHash` followed by `revoke` cannot express this — under
   * PostgreSQL's default isolation both racers read the same active row.
   */
  revokeIfActive(id: string, at: Date): Promise<boolean>
  /**
   * 03 §6.2 — presenting an already-rotated token means the cookie leaked, so
   * the whole family dies rather than just the replayed member. Returns the
   * number of tokens revoked.
   */
  revokeFamily(familyId: string, at: Date): Promise<number>
  /**
   * Housekeeping (S14). Removes rows past `expiresAt` — including revoked
   * ones, whose only remaining job was reuse detection, which an expiry check
   * already covers. Returns how many were removed.
   */
  deleteExpired(now: Date): Promise<number>
}

export interface IPreferencesRepository {
  findByUser(userId: string): Promise<UserPreferences | null>
  /** Create-or-patch. A user without a preferences row is a valid state. */
  upsert(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences>
}

export type NewSecurityEvent = Draft<
  SecurityEvent,
  'severity' | 'userId' | 'guestSessionId' | 'tableId' | 'gameId' | 'ip' | 'userAgent' | 'details'
>

export interface SecurityEventFilter {
  readonly kind?: SecurityEventKind
  readonly userId?: string
  readonly since?: Date
}

/** Append-only (07 §6): no update path and no delete path, deliberately. */
export interface ISecurityEventRepository {
  record(event: NewSecurityEvent): Promise<SecurityEvent>
  list(filter?: SecurityEventFilter, page?: PageQuery): Promise<SecurityEvent[]>
  countSince(kind: SecurityEventKind, since: Date): Promise<number>
}
