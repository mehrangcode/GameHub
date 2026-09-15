import type {
  AdminAction,
  AdminTargetType,
  ControlCommandKind,
} from '../../contracts/admin/enums.js'
import type { AdminAuditEntry, AdminCredential, AdminSession } from '../entities/admin.js'
import type { PageQuery } from './IRepository.js'

/**
 * The admin repositories — 12-admin-console.md §4.
 *
 * Exercised by the same contract suite as every other repository
 * (`tests/unit/repositories/contract/admin.test.ts`), run against the in-memory
 * fakes **and** against SQLite. Every assertion therefore appears twice, which
 * is the only thing that makes the fakes trustworthy.
 */

export interface EnrollTotpInput {
  readonly totpSecretEnc: string
  readonly recoveryCodeHashes: readonly string[]
  readonly enrolledAt: Date
}

export interface IAdminCredentialRepository {
  findByUser(userId: string): Promise<AdminCredential | null>

  /**
   * Writes the secret and the recovery hashes, and stamps `totpEnrolledAt`.
   *
   * Creates the row if the seed did not — an admin promoted by
   * `PATCH /users/:id/role` has no credential until they enroll.
   */
  enroll(userId: string, input: EnrollTotpInput): Promise<AdminCredential>

  /**
   * ★ The replay guard, written atomically with the attempt reset.
   *
   * `step` is the TOTP step that just verified. A later code at or below it is
   * refused, so the same six digits cannot be spent twice inside their 30-second
   * window — which is the entire value of intercepting one. Also clears
   * `failedAttempts` and `lockedUntil`: a success ends a lockout.
   */
  recordSuccess(userId: string, step: number, at: Date): Promise<void>

  /**
   * Increments `failedAttempts` and locks past the threshold, returning the row
   * as it now stands so the caller can report `lockedUntil`.
   *
   * One call rather than read-then-write, for the same reason `claimSeat` is:
   * two simultaneous wrong codes must count as two, and a read-then-write pair
   * counts them as one under any isolation level worth deploying.
   */
  recordFailure(
    userId: string,
    at: Date,
    policy: { maxAttempts: number; lockoutMs: number },
  ): Promise<AdminCredential>

  /**
   * Spends a recovery code, atomically. `false` when the hash was not in the
   * list — including because a concurrent request just spent it, which is the
   * case a read-then-write would get wrong and which matters here precisely
   * because the operator is already having a bad day.
   */
  consumeRecoveryCode(userId: string, hash: string): Promise<boolean>
}

export interface NewAdminSession {
  readonly userId: string
  readonly tokenHash: string
  readonly ip: string
  readonly userAgent: string
  readonly mfaAt: Date
  readonly expiresAt: Date
}

export interface IAdminSessionRepository {
  create(data: NewAdminSession): Promise<AdminSession>
  findById(id: string): Promise<AdminSession | null>
  findByTokenHash(tokenHash: string): Promise<AdminSession | null>
  /** The 30-minute idle clock. Called on every authenticated request. */
  touch(id: string, at: Date): Promise<void>
  /** Advances `mfaAt` after a fresh factor — the step-up window restarts here. */
  refreshMfa(id: string, at: Date): Promise<AdminSession>
  /** Rotation: the refresh token changes, the session row does not. */
  rotate(id: string, tokenHash: string, at: Date): Promise<AdminSession>
  revoke(id: string, at: Date): Promise<void>
  /** Returns how many were revoked. Used by `POST /users/:id/force-logout` (S50). */
  revokeAllForUser(userId: string, at: Date): Promise<number>
  listActiveByUser(userId: string, now: Date): Promise<AdminSession[]>
  deleteExpired(now: Date): Promise<number>
}

export interface NewAdminAuditEntry {
  readonly actorUserId: string
  readonly actorIp: string
  readonly actorUserAgent: string
  readonly requestId: string
  readonly action: AdminAction
  readonly targetType: AdminTargetType
  readonly targetId: string
  readonly reason: string | null
  readonly before?: unknown
  readonly after?: unknown
}

export interface AdminAuditFilter {
  readonly actorUserId?: string
  readonly action?: AdminAction
  readonly targetType?: AdminTargetType
  readonly targetId?: string
  readonly since?: Date
  readonly until?: Date
}

/**
 * ★ Append-only, and the *interface* is where that is guaranteed — invariant A4.
 *
 * There is deliberately no `update` and no `delete` here. Not "they throw":
 * they do not exist, so a future service cannot call one, and
 * `tests/unit/repositories/contract/admin.test.ts` asserts their absence
 * structurally. A method that threw would still be a method somebody could
 * decide to make work in an emergency at 3am.
 *
 * `IRepository<T>` is deliberately **not** extended for the same reason — it
 * declares `update` and `delete`.
 */
export interface IAdminAuditRepository {
  /**
   * Appends one row. The caller supplies the content; the repository computes
   * the chain (`prevHash` from the current tip, `hash` over the canonical row),
   * because a chain link computed by callers is a chain link that is eventually
   * computed two different ways.
   */
  append(entry: NewAdminAuditEntry, at: Date): Promise<AdminAuditEntry>
  list(filter?: AdminAuditFilter, page?: PageQuery): Promise<AdminAuditEntry[]>
  /** The chain tip — what the next `prevHash` links to. `null` on an empty log. */
  latest(): Promise<AdminAuditEntry | null>
  /** Oldest first, for `GET /audit/verify`, which must walk in chain order. */
  listForVerification(afterId?: string, limit?: number): Promise<AdminAuditEntry[]>
  count(): Promise<number>
}

export interface NewControlCommand {
  readonly kind: ControlCommandKind
  readonly payload: unknown
  /** Which admin action produced it — so the gateway's log line points at who and why. */
  readonly auditLogId: string
}

export interface ControlCommandRow {
  readonly id: string
  readonly kind: ControlCommandKind
  readonly payload: unknown
  readonly auditLogId: string
  readonly createdAt: Date
  readonly consumedAt: Date | null
}

/**
 * ★ The durable outbox — 12 §6.1, invariant A6.
 *
 * The admin process writes a command **inside the same transaction** as the
 * state change and the audit row: all three exist or none do. The Redis publish
 * that follows is a best-effort notification carrying an id — never the
 * command's authority, which is what keeps this inside 02 §3.2's Redis
 * boundary. With Redis down, or with `CONTROL_TRANSPORT=poll`, the api
 * process's sweep still finds the row; the only difference is up to two seconds
 * of latency.
 *
 * > **Scope note.** S50 writes commands and nothing consumes them yet: 12 §11.1
 * > places the consumer at **M3**, with matchmaking, which is the first point at
 * > which "turn this off" affects strangers rather than friends. `listUnconsumed`
 * > and `markConsumed` exist now so that the deferred half is purely the sweep
 * > loop and its Redis subscription — not a second design decision taken later
 * > under different assumptions.
 */
export interface IControlCommandRepository {
  append(command: NewControlCommand, at: Date): Promise<ControlCommandRow>
  /** Oldest first — commands for one table must land in the order they were issued. */
  listUnconsumed(limit?: number): Promise<ControlCommandRow[]>
  /**
   * Marks a command done, and reports whether **this** caller was the one that
   * did it. `false` means a duplicate delivery got there first, which makes the
   * effect a no-op rather than a double execution (§6.1).
   */
  markConsumed(id: string, at: Date): Promise<boolean>
}
