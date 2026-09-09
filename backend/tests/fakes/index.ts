import type { IUnitOfWork, Repositories } from '../../src/domain/repositories/Repositories.js'
import {
  InMemoryCosmeticRepository,
  InMemoryRewardRuleRepository,
  InMemoryWalletRepository,
} from './economy.js'
import {
  InMemoryGameEventRepository,
  InMemoryGameInstanceRepository,
  InMemoryGameSnapshotRepository,
  InMemoryStatsRepository,
} from './games.js'
import { InMemoryMatchParticipantRepository } from './matches.js'
import {
  InMemoryGuestSessionRepository,
  InMemoryPreferencesRepository,
  InMemoryRefreshTokenRepository,
  InMemorySecurityEventRepository,
  InMemoryUserRepository,
} from './identity.js'
import {
  InMemoryChatRepository,
  InMemoryInviteRepository,
  InMemoryTableRepository,
} from './tables.js'

export * from './economy.js'
export * from './games.js'
export * from './identity.js'
export * from './matches.js'
export * from './store.js'
export * from './tables.js'

export interface InMemoryRepositories extends Repositories {
  readonly tables: InMemoryTableRepository
  readonly invites: InMemoryInviteRepository
  readonly events: InMemoryGameEventRepository
  readonly games: InMemoryGameInstanceRepository
  readonly cosmetics: InMemoryCosmeticRepository
  readonly wallets: InMemoryWalletRepository
  readonly rewardRules: InMemoryRewardRuleRepository
  /** Exposed concretely because rows can only be seeded directly (no `create`). */
  readonly participants: InMemoryMatchParticipantRepository
  readonly chat: InMemoryChatRepository
}

/**
 * The same `Repositories` bundle `container.ts` builds, backed by maps.
 *
 * A couple of the fakes need each other — `findByInviteCode` resolves through
 * the invite store, `events.append` bumps `GameInstance.seq` — exactly as the
 * Prisma versions reach across tables. Wiring them here rather than inside the
 * classes keeps each fake constructible on its own.
 */
export function buildInMemoryRepositories(): InMemoryRepositories {
  const tables = new InMemoryTableRepository()
  const invites = new InMemoryInviteRepository()
  const games = new InMemoryGameInstanceRepository()
  const events = new InMemoryGameEventRepository()

  tables.invites = invites
  events.games = games

  return {
    users: new InMemoryUserRepository(),
    guests: new InMemoryGuestSessionRepository(),
    refreshTokens: new InMemoryRefreshTokenRepository(),
    preferences: new InMemoryPreferencesRepository(),
    securityEvents: new InMemorySecurityEventRepository(),
    tables,
    invites,
    chat: new InMemoryChatRepository(),
    games,
    events,
    snapshots: new InMemoryGameSnapshotRepository(),
    stats: new InMemoryStatsRepository(),
    participants: new InMemoryMatchParticipantRepository(),
    wallets: new InMemoryWalletRepository(),
    rewardRules: new InMemoryRewardRuleRepository(),
    cosmetics: new InMemoryCosmeticRepository(),
  }
}

/**
 * `run` just calls the function.
 *
 * That is not a shortcut, it is the honest fake: an in-memory store has nothing
 * to roll back, so pretending otherwise would give tests false confidence. The
 * rollback property belongs to the Prisma unit of work and is asserted there,
 * against a real transaction (`tests/integration/unit-of-work.test.ts`).
 */
export class InMemoryUnitOfWork implements IUnitOfWork {
  constructor(private readonly repos: Repositories) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return work(this.repos)
  }
}
