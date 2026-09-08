import { PrismaClient } from '@prisma/client'
import { getEnv } from '../../config/env.js'

/**
 * One `PrismaClient` per process. `tsx watch` re-evaluates modules on every
 * save, so the instance is parked on `globalThis` — otherwise a morning of
 * editing leaks a connection pool per keystroke.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function create(): PrismaClient {
  const env = getEnv()
  return new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? create()

if (getEnv().NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
