import { PrismaClient } from '@prisma/client'

/**
 * A client bound to the throwaway `prisma/test.db` that `tests/global-setup.ts`
 * rebuilds on every run. Integration tests assert the *database's* constraints,
 * so they need a real database.
 */
export const db = new PrismaClient({ log: ['warn', 'error'] })

/** Deleted in FK order — children first. */
const tablesInDeletionOrder = [
  'userAchievement',
  'achievement',
  'purchase',
  'storeItem',
  'subscriptionEvent',
  'subscription',
  'matchParticipant',
  'ratingChange',
  'matchResult',
  'walletTransaction',
  'wallet',
  'gameSnapshot',
  'gameEvent',
  'gameInstance',
  'chatMessage',
  'tableMember',
  'invite',
  'matchmakingTicket',
  'matchmakingCooldown',
  'block',
  'securityEvent',
  'guestSession',
  'table',
  'userCosmetic',
  'cosmeticItem',
  'userPreferences',
  'playerStats',
  'rating',
  'refreshToken',
  'rewardRule',
  'user',
] as const

export async function resetDb(): Promise<void> {
  for (const model of tablesInDeletionOrder) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)[model].deleteMany()
  }
}

let seq = 0
const uid = () => `${Date.now()}-${seq++}`

export async function makeUser(overrides: Partial<{ email: string; displayName: string }> = {}) {
  return db.user.create({
    data: {
      email: overrides.email ?? `u${uid()}@test.dev`,
      passwordHash: 'argon2id$placeholder',
      displayName: overrides.displayName ?? 'Tester',
    },
  })
}

export async function makeTable(hostUserId?: string, seatCount = 4) {
  return db.table.create({
    data: {
      hostUserId: hostUserId ?? null,
      gameSlug: 'fixture',
      optionsJson: '{}',
      seatCount,
    },
  })
}

export async function makeGuest(tableId: string) {
  return db.guestSession.create({
    data: {
      tokenHash: `hash-${uid()}`,
      displayName: 'Guest',
      tableId,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    },
  })
}

export async function makeGame(tableId: string) {
  return db.gameInstance.create({
    data: {
      tableId,
      gameSlug: 'fixture',
      rngSeed: 'seed',
      seedCommit: 'commit',
      seatingJson: '[]',
      optionsJson: '{}',
    },
  })
}

export async function makeWallet(userId: string, assetCode = 'COIN') {
  return db.wallet.create({ data: { userId, assetCode } })
}
