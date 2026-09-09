import type { PrismaClient } from '@prisma/client'

export interface DependencyStatus {
  readonly ok: boolean
  readonly latencyMs: number
  readonly error?: string
}

/**
 * The readiness probe for the database.
 *
 * It counts a real table rather than issuing `SELECT 1`. On SQLite the two say
 * very different things: `SELECT 1` succeeds against a file the driver just
 * created, so a `DATABASE_URL` typo would report *ready* while every query in
 * the app failed. Touching a table proves the schema is actually there.
 */
export async function checkDatabase(prisma: PrismaClient): Promise<DependencyStatus> {
  const started = Date.now()
  try {
    await prisma.rewardRule.count()
    return { ok: true, latencyMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.name : 'unknown',
    }
  }
}
