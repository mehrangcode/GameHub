import { computeAuditHash } from '../../src/domain/admin/auditChain.js'
import type {
  AdminAuditEntry,
  AdminCredential,
  AdminSession,
} from '../../src/domain/entities/admin.js'
import { NotFoundError } from '../../src/domain/errors/errors.js'
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
} from '../../src/domain/repositories/admin.js'
import type { PageQuery } from '../../src/domain/repositories/IRepository.js'
import { Collection, cloneAll, nextId, paginate } from './store.js'

/**
 * In-memory admin repositories — held to the same contract suite as the Prisma
 * ones (`tests/unit/repositories/contract/admin.test.ts`), so every assertion
 * runs twice and a fake that quietly behaved differently would fail.
 */

export class InMemoryAdminCredentialRepository implements IAdminCredentialRepository {
  readonly rows = new Collection<AdminCredential>('AdminCredential')

  /** Test setup: the seed's unenrolled row, without running the seed. */
  seedUnenrolled(userId: string): AdminCredential {
    const now = new Date()
    return this.rows.insert({
      id: nextId('acr'),
      userId,
      totpSecretEnc: '',
      totpEnrolledAt: null,
      lastTotpStep: null,
      recoveryCodeHashes: [],
      failedAttempts: 0,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
    })
  }

  async findByUser(userId: string): Promise<AdminCredential | null> {
    return this.rows.find((row) => row.userId === userId)
  }

  async enroll(userId: string, input: EnrollTotpInput): Promise<AdminCredential> {
    const existing = this.rows.all().find((row) => row.userId === userId)
    const data = {
      totpSecretEnc: input.totpSecretEnc,
      totpEnrolledAt: input.enrolledAt,
      recoveryCodeHashes: [...input.recoveryCodeHashes],
      lastTotpStep: null,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: input.enrolledAt,
    }

    if (existing) return this.rows.patch(existing.id, data)

    return this.rows.insert({
      id: nextId('acr'),
      userId,
      createdAt: input.enrolledAt,
      ...data,
    })
  }

  async recordSuccess(userId: string, step: number, at: Date): Promise<void> {
    const row = this.require(userId)
    this.rows.patch(row.id, {
      lastTotpStep: step,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: at,
    })
  }

  async recordFailure(
    userId: string,
    at: Date,
    policy: { maxAttempts: number; lockoutMs: number },
  ): Promise<AdminCredential> {
    const row = this.require(userId)
    const failedAttempts = row.failedAttempts + 1

    return this.rows.patch(row.id, {
      failedAttempts,
      updatedAt: at,
      ...(failedAttempts >= policy.maxAttempts
        ? { lockedUntil: new Date(at.getTime() + policy.lockoutMs) }
        : {}),
    })
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    const row = this.rows.all().find((r) => r.userId === userId)
    if (!row) return false

    const remaining = row.recoveryCodeHashes.filter((stored) => stored !== hash)
    if (remaining.length === row.recoveryCodeHashes.length) return false

    this.rows.patch(row.id, { recoveryCodeHashes: remaining })
    return true
  }

  /** Prisma raises P2025 for an update that matched nothing; so does this. */
  private require(userId: string): AdminCredential {
    const row = this.rows.all().find((r) => r.userId === userId)
    if (!row) throw new NotFoundError('AdminCredential', { userId })
    return row
  }
}

export class InMemoryAdminSessionRepository implements IAdminSessionRepository {
  readonly rows = new Collection<AdminSession>('AdminSession')

  async create(data: NewAdminSession): Promise<AdminSession> {
    const now = new Date()
    return this.rows.insert({
      id: nextId('ase'),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      ...data,
    })
  }

  async findById(id: string): Promise<AdminSession | null> {
    return this.rows.get(id)
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSession | null> {
    return this.rows.find((row) => row.tokenHash === tokenHash)
  }

  async touch(id: string, at: Date): Promise<void> {
    this.rows.patch(id, { lastSeenAt: at })
  }

  async refreshMfa(id: string, at: Date): Promise<AdminSession> {
    return this.rows.patch(id, { mfaAt: at, lastSeenAt: at })
  }

  async rotate(id: string, tokenHash: string, at: Date): Promise<AdminSession> {
    // `expiresAt` deliberately untouched — rotation renews the token, never the
    // absolute cap. The contract suite asserts exactly that, on both sides.
    return this.rows.patch(id, { tokenHash, lastSeenAt: at })
  }

  async revoke(id: string, at: Date): Promise<void> {
    const row = this.rows.peek(id)
    // `updateMany`-shaped: a missing or already-revoked row is a no-op, never
    // a throw, matching the Prisma implementation.
    if (row && row.revokedAt === null) this.rows.patch(id, { revokedAt: at })
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const live = this.rows.all().filter((row) => row.userId === userId && row.revokedAt === null)
    for (const row of live) this.rows.patch(row.id, { revokedAt: at })
    return live.length
  }

  async listActiveByUser(userId: string, now: Date): Promise<AdminSession[]> {
    return this.rows.filter(
      (row) => row.userId === userId && row.revokedAt === null && row.expiresAt > now,
    )
  }

  async deleteExpired(now: Date): Promise<number> {
    const dead = this.rows.all().filter((row) => row.expiresAt < now)
    for (const row of dead) this.rows.remove(row.id)
    return dead.length
  }
}

/**
 * ★ No `update`, no `delete` — exactly like the Prisma one, and for the same
 * reason (A4). A fake that offered them would let a test pass against a
 * capability production does not have.
 */
export class InMemoryAdminAuditRepository implements IAdminAuditRepository {
  readonly rows = new Collection<AdminAuditEntry>('AdminAuditLog')
  /** Insertion order — the chain's order, which `createdAt` alone may tie on. */
  private readonly order: string[] = []

  async append(entry: NewAdminAuditEntry, at: Date): Promise<AdminAuditEntry> {
    const tip = this.order.at(-1)
    const prevHash = tip === undefined ? null : (this.rows.peek(tip)?.hash ?? null)
    const id = nextId('aud')

    const beforeJson = entry.before === undefined ? null : JSON.stringify(entry.before)
    const afterJson = entry.after === undefined ? null : JSON.stringify(entry.after)

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

    this.order.push(id)
    return this.rows.insert({
      id,
      actorUserId: entry.actorUserId,
      actorIp: entry.actorIp,
      actorUserAgent: entry.actorUserAgent,
      requestId: entry.requestId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: entry.reason,
      before: entry.before ?? null,
      after: entry.after ?? null,
      prevHash,
      hash,
      createdAt: at,
    })
  }

  async list(filter: AdminAuditFilter = {}, page: PageQuery = {}): Promise<AdminAuditEntry[]> {
    return paginate(this.rows.all().filter((row) => matches(row, filter)), page)
  }

  async latest(): Promise<AdminAuditEntry | null> {
    const tip = this.order.at(-1)
    return tip === undefined ? null : this.rows.get(tip)
  }

  async listForVerification(afterId?: string, limit = 500): Promise<AdminAuditEntry[]> {
    const start = afterId === undefined ? 0 : this.order.indexOf(afterId) + 1
    const ids = this.order.slice(start, start + limit)
    return cloneAll(ids.map((id) => this.rows.peek(id)!).filter(Boolean))
  }

  async count(): Promise<number> {
    return this.order.length
  }

  /** Test-only: simulates somebody deleting a row directly in SQL. */
  tamperDelete(id: string): void {
    this.rows.remove(id)
    const index = this.order.indexOf(id)
    if (index !== -1) this.order.splice(index, 1)
  }
}

function matches(row: AdminAuditEntry, filter: AdminAuditFilter): boolean {
  if (filter.actorUserId !== undefined && row.actorUserId !== filter.actorUserId) return false
  if (filter.action !== undefined && row.action !== filter.action) return false
  if (filter.targetType !== undefined && row.targetType !== filter.targetType) return false
  if (filter.targetId !== undefined && row.targetId !== filter.targetId) return false
  if (filter.since !== undefined && row.createdAt < filter.since) return false
  if (filter.until !== undefined && row.createdAt > filter.until) return false
  return true
}

/** 12 §6.1 — the outbox, in memory. Consumed at M3; written from S50. */
export class InMemoryControlCommandRepository implements IControlCommandRepository {
  readonly rows: ControlCommandRow[] = []

  async append(command: NewControlCommand, at: Date): Promise<ControlCommandRow> {
    const row: ControlCommandRow = {
      id: nextId('ctl'),
      kind: command.kind,
      // Round-tripped through JSON like the real column, so a test cannot pass
      // by smuggling a Date or a Map through the payload.
      payload: JSON.parse(JSON.stringify(command.payload)) as unknown,
      auditLogId: command.auditLogId,
      createdAt: at,
      consumedAt: null,
    }
    this.rows.push(row)
    return { ...row }
  }

  async listUnconsumed(limit = 100): Promise<ControlCommandRow[]> {
    return this.rows
      .filter((row) => row.consumedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row) => ({ ...row }))
  }

  async markConsumed(id: string, at: Date): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === id && row.consumedAt === null)
    if (index === -1) return false
    this.rows[index] = { ...this.rows[index]!, consumedAt: at }
    return true
  }
}
