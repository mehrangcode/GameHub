import { randomBytes } from 'node:crypto'
import type {
  AdminAuditEntry,
  AdminCredential,
  AdminSession,
} from '../../../domain/entities/admin.js'
import { computeAuditHash } from '../../../domain/admin/auditChain.js'
import type {
  AdminAuditFilter,
  ControlCommandRow,
  EnrollTotpInput,
  IControlCommandRepository,
  NewControlCommand,
  IAdminAuditRepository,
  IAdminCredentialRepository,
  IAdminSessionRepository,
  NewAdminAuditEntry,
  NewAdminSession,
} from '../../../domain/repositories/admin.js'
import type { ControlCommandKind } from '../../../contracts/admin/enums.js'
import type { PageQuery } from '../../../domain/repositories/IRepository.js'
import { toAdminAuditEntry, toAdminCredential, toAdminSession, toJsonOrNull } from '../mappers.js'
import { cursorArgs, NEWEST_FIRST, PrismaRepositoryBase } from './base.js'

export class PrismaAdminCredentialRepository
  extends PrismaRepositoryBase
  implements IAdminCredentialRepository
{
  async findByUser(userId: string): Promise<AdminCredential | null> {
    const row = await this.db.adminCredential.findUnique({ where: { userId } })
    return row === null ? null : toAdminCredential(row)
  }

  async enroll(userId: string, input: EnrollTotpInput): Promise<AdminCredential> {
    const data = {
      totpSecretEnc: input.totpSecretEnc,
      totpEnrolledAt: input.enrolledAt,
      recoveryCodeHashes: JSON.stringify(input.recoveryCodeHashes),
      // A fresh enrollment starts a clean slate: no spent steps, no lockout
      // carried over from whatever went wrong before the operator re-enrolled.
      lastTotpStep: null,
      failedAttempts: 0,
      lockedUntil: null,
    }

    return toAdminCredential(
      await this.db.adminCredential.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      }),
    )
  }

  async recordSuccess(userId: string, step: number, at: Date): Promise<void> {
    await this.db.adminCredential.update({
      where: { userId },
      data: { lastTotpStep: step, failedAttempts: 0, lockedUntil: null, updatedAt: at },
    })
  }

  async recordFailure(
    userId: string,
    at: Date,
    policy: { maxAttempts: number; lockoutMs: number },
  ): Promise<AdminCredential> {
    return this.atomically(async (db) => {
      // `increment` rather than read-then-write: two simultaneous wrong codes
      // must count as two. The read that follows is inside the same
      // transaction, so the threshold is evaluated against the true count.
      const bumped = await db.adminCredential.update({
        where: { userId },
        data: { failedAttempts: { increment: 1 }, updatedAt: at },
      })

      if (bumped.failedAttempts < policy.maxAttempts) return toAdminCredential(bumped)

      return toAdminCredential(
        await db.adminCredential.update({
          where: { userId },
          data: { lockedUntil: new Date(at.getTime() + policy.lockoutMs) },
        }),
      )
    })
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    return this.atomically(async (db) => {
      const row = await db.adminCredential.findUnique({ where: { userId } })
      if (row === null) return false

      const hashes = JSON.parse(row.recoveryCodeHashes) as string[]
      const remaining = hashes.filter((stored) => stored !== hash)
      // Nothing removed ⇒ it was not there, or a concurrent request spent it
      // first. Both are "no" to the caller, and neither writes.
      if (remaining.length === hashes.length) return false

      await db.adminCredential.update({
        where: { userId },
        data: { recoveryCodeHashes: JSON.stringify(remaining) },
      })
      return true
    })
  }
}

export class PrismaAdminSessionRepository
  extends PrismaRepositoryBase
  implements IAdminSessionRepository
{
  async create(data: NewAdminSession): Promise<AdminSession> {
    return toAdminSession(await this.db.adminSession.create({ data }))
  }

  async findById(id: string): Promise<AdminSession | null> {
    const row = await this.db.adminSession.findUnique({ where: { id } })
    return row === null ? null : toAdminSession(row)
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSession | null> {
    const row = await this.db.adminSession.findUnique({ where: { tokenHash } })
    return row === null ? null : toAdminSession(row)
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.adminSession.update({ where: { id }, data: { lastSeenAt: at } })
  }

  async refreshMfa(id: string, at: Date): Promise<AdminSession> {
    return this.mapMissing(
      async () =>
        toAdminSession(
          await this.db.adminSession.update({
            where: { id },
            data: { mfaAt: at, lastSeenAt: at },
          }),
        ),
      'AdminSession',
      id,
    )
  }

  async rotate(id: string, tokenHash: string, at: Date): Promise<AdminSession> {
    return this.mapMissing(
      async () =>
        toAdminSession(
          await this.db.adminSession.update({
            where: { id },
            // ★ `expiresAt` is untouched. Rotation renews the *token*, never
            // the 8-hour absolute cap — otherwise an operator who kept a tab
            // open would hold a session that never ended, which is the failure
            // an absolute cap exists to prevent.
            data: { tokenHash, lastSeenAt: at },
          }),
        ),
      'AdminSession',
      id,
    )
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.db.adminSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    })
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const result = await this.db.adminSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    })
    return result.count
  }

  async listActiveByUser(userId: string, now: Date): Promise<AdminSession[]> {
    const rows = await this.db.adminSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: NEWEST_FIRST,
    })
    return rows.map(toAdminSession)
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.adminSession.deleteMany({ where: { expiresAt: { lt: now } } })
    return result.count
  }
}

/**
 * ★ Append-only — 12 §3.5, invariant A4.
 *
 * Note what this class does **not** have: no `update`, no `delete`, no
 * `deleteExpired`. The interface does not declare them and the implementation
 * does not define them, so there is no method for a future service to call and
 * no method for someone to "just make work" during an incident.
 * `tests/unit/repositories/contract/admin.test.ts` asserts that structurally,
 * by reflecting over the prototype.
 */
export class PrismaAdminAuditRepository
  extends PrismaRepositoryBase
  implements IAdminAuditRepository
{
  async append(entry: NewAdminAuditEntry, at: Date): Promise<AdminAuditEntry> {
    return this.atomically(async (db) => {
      const tip = await db.adminAuditLog.findFirst({ orderBy: NEWEST_FIRST })
      const prevHash = tip?.hash ?? null

      const beforeJson = toJsonOrNull(entry.before)
      const afterJson = toJsonOrNull(entry.after)
      // The id has to exist before the hash, because the hash covers it: a row
      // that could be moved to another id and still verify would let a deleted
      // row be replaced by a forged one carrying the same content.
      const id = createId()

      const hash = computeAuditHash(
        {
          id,
          actorUserId: entry.actorUserId,
          actorIp: entry.actorIp,
          actorUserAgent: entry.actorUserAgent,
          requestId: entry.requestId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          reason: entry.reason,
          beforeJson,
          afterJson,
          createdAt: at,
        },
        prevHash,
      )

      return toAdminAuditEntry(
        await db.adminAuditLog.create({
          data: {
            id,
            actorUserId: entry.actorUserId,
            actorIp: entry.actorIp,
            actorUserAgent: entry.actorUserAgent,
            requestId: entry.requestId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId,
            reason: entry.reason,
            beforeJson,
            afterJson,
            prevHash,
            hash,
            createdAt: at,
          },
        }),
      )
    })
  }

  async list(filter: AdminAuditFilter = {}, page: PageQuery = {}): Promise<AdminAuditEntry[]> {
    if (page.before !== undefined && !(await this.exists(page.before))) return []

    const rows = await this.db.adminAuditLog.findMany({
      where: this.where(filter),
      orderBy: NEWEST_FIRST,
      take: page.limit ?? 25,
      ...cursorArgs(page.before),
    })
    return rows.map(toAdminAuditEntry)
  }

  async latest(): Promise<AdminAuditEntry | null> {
    const row = await this.db.adminAuditLog.findFirst({ orderBy: NEWEST_FIRST })
    return row === null ? null : toAdminAuditEntry(row)
  }

  async listForVerification(afterId?: string, limit = 500): Promise<AdminAuditEntry[]> {
    const rows = await this.db.adminAuditLog.findMany({
      // ★ Oldest first, and the id as a total tie-break. The chain is an
      // ordering; verifying it in any other order reports a break in a log that
      // is perfectly sound.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      ...(afterId === undefined ? {} : { cursor: { id: afterId }, skip: 1 }),
    })
    return rows.map(toAdminAuditEntry)
  }

  async count(): Promise<number> {
    return this.db.adminAuditLog.count()
  }

  private where(filter: AdminAuditFilter) {
    return {
      ...(filter.actorUserId === undefined ? {} : { actorUserId: filter.actorUserId }),
      ...(filter.action === undefined ? {} : { action: filter.action }),
      ...(filter.targetType === undefined ? {} : { targetType: filter.targetType }),
      ...(filter.targetId === undefined ? {} : { targetId: filter.targetId }),
      ...(filter.since === undefined && filter.until === undefined
        ? {}
        : {
            createdAt: {
              ...(filter.since === undefined ? {} : { gte: filter.since }),
              ...(filter.until === undefined ? {} : { lte: filter.until }),
            },
          }),
    }
  }

  private async exists(id: string): Promise<boolean> {
    return (await this.db.adminAuditLog.count({ where: { id } })) > 0
  }
}

/**
 * The audit row's id, generated here rather than by Prisma's `@default(cuid())`.
 *
 * The hash covers the id (see `append`), so the id has to exist *before* the
 * row is written — and Prisma's generator runs at insert time, inside the
 * database call. Sortable-prefix plus 16 bytes from `crypto`: the timestamp
 * keeps insertion order roughly aligned with the index, and the random half is
 * what makes a collision (and therefore a forged replacement row) infeasible.
 */
function createId(): string {
  return `c${Date.now().toString(36)}${randomBytes(16).toString('hex')}`
}

/** 12 §6.1 — the outbox. Written inside the action's transaction; see the interface. */
export class PrismaControlCommandRepository
  extends PrismaRepositoryBase
  implements IControlCommandRepository
{
  async append(command: NewControlCommand, at: Date): Promise<ControlCommandRow> {
    return toRow(
      await this.db.controlCommand.create({
        data: {
          kind: command.kind,
          payloadJson: JSON.stringify(command.payload),
          auditLogId: command.auditLogId,
          createdAt: at,
        },
      }),
    )
  }

  async listUnconsumed(limit = 100): Promise<ControlCommandRow[]> {
    const rows = await this.db.controlCommand.findMany({
      where: { consumedAt: null },
      // Oldest first, and the id as a total tie-break: two commands for one
      // table issued in the same millisecond must still execute in order.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    })
    return rows.map(toRow)
  }

  async markConsumed(id: string, at: Date): Promise<boolean> {
    // Conditional on `consumedAt: null`, so the database arbitrates. A second
    // delivery — Redis plus the sweep, say — reports false and does nothing,
    // which is what makes duplicate delivery a no-op rather than a second kick.
    const { count } = await this.db.controlCommand.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: at },
    })
    return count === 1
  }
}

function toRow(row: {
  id: string
  kind: string
  payloadJson: string
  auditLogId: string
  createdAt: Date
  consumedAt: Date | null
}): ControlCommandRow {
  return {
    id: row.id,
    kind: row.kind as ControlCommandKind,
    payload: JSON.parse(row.payloadJson) as unknown,
    auditLogId: row.auditLogId,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
  }
}
