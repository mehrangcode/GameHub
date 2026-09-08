import { Prisma } from '@prisma/client'

/**
 * P2002 — unique constraint violation.
 *
 * This is not a defensive nicety: seat claiming is an insert-and-catch, never a
 * read-then-write (03 §6.3), so recognising this error *is* the concurrency
 * control. Same for move idempotency and the wallet ledger key.
 */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  if (!target) return true

  const meta = error.meta as { target?: string | string[] } | undefined
  const fields = Array.isArray(meta?.target) ? meta.target : meta?.target ? [meta.target] : []
  return fields.some((field) => field.includes(target))
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
}
