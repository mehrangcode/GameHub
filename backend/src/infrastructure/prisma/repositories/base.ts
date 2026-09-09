import type { PrismaClient } from '@prisma/client'
import { NotFoundError } from '../../../domain/errors/errors.js'
import { isNotFound, isUniqueViolation } from '../errors.js'
import type { Db } from '../mappers.js'

/**
 * Shared behaviour for the Prisma repositories (02 §5.3).
 *
 * Every repository takes `PrismaClient | Prisma.TransactionClient`. That single
 * decision is what lets one class serve both the standalone call and the call
 * inside `uow.run(...)` — no second code path, no "transactional" twin that
 * drifts from its sibling.
 */
export abstract class PrismaRepositoryBase {
  constructor(protected readonly db: Db) {}

  /**
   * Prisma raises P2025 for an update or delete that matched nothing. The
   * contract suite expects a `NotFoundError`, and the in-memory fakes throw the
   * same thing — so this translation happens once, here.
   */
  protected async mapMissing<T>(work: () => Promise<T>, resource: string, id: string): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError(resource, { id })
      throw error
    }
  }

  /** `null` on a unique violation — the seat-race and idempotency-key idiom. */
  protected async nullOnConflict<T>(work: () => Promise<T>, target?: string): Promise<T | null> {
    try {
      return await work()
    } catch (error) {
      if (isUniqueViolation(error, target)) return null
      throw error
    }
  }

  /**
   * Runs `work` in a transaction — unless we are already inside one.
   *
   * Prisma cannot nest `$transaction`, and a repository has no way to know
   * whether its caller wrapped it. Checking for the method is the honest test:
   * a `TransactionClient` does not have it, so "already transactional" and
   * "needs its own transaction" are distinguishable at runtime.
   */
  protected async atomically<T>(work: (db: Db) => Promise<T>): Promise<T> {
    const client = this.db as PrismaClient
    if (typeof client.$transaction !== 'function') return work(this.db)
    return client.$transaction(async (tx) => work(tx))
  }
}

/**
 * Cursor paging shared by the statement and chat views: newest first, with the
 * id as a total tie-break so two rows written in the same millisecond still
 * page deterministically.
 */
export const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]

export function cursorArgs(before?: string): { cursor?: { id: string }; skip?: number } {
  return before === undefined ? {} : { cursor: { id: before }, skip: 1 }
}
