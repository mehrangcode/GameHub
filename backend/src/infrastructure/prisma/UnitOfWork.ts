import type { PrismaClient } from '@prisma/client'
import type { IUnitOfWork, Repositories } from '../../domain/repositories/Repositories.js'
import type { Db } from './mappers.js'
import {
  PrismaCosmeticRepository,
  PrismaRewardRuleRepository,
  PrismaSubscriptionRepository,
  PrismaWalletRepository,
} from './repositories/economy.js'
import {
  PrismaMatchParticipantRepository,
  PrismaMatchResultRepository,
} from './repositories/matches.js'
import {
  PrismaGameEventRepository,
  PrismaGameInstanceRepository,
  PrismaGameSnapshotRepository,
  PrismaStatsRepository,
} from './repositories/games.js'
import {
  PrismaGuestSessionRepository,
  PrismaPreferencesRepository,
  PrismaRefreshTokenRepository,
  PrismaSecurityEventRepository,
  PrismaUserRepository,
} from './repositories/identity.js'
import {
  PrismaChatRepository,
  PrismaInviteRepository,
  PrismaTableRepository,
} from './repositories/tables.js'

/**
 * Builds the full repository set over any client — the root `PrismaClient` or a
 * `Prisma.TransactionClient`. Because every repository accepts both (02 §5.3),
 * this one function serves the container and the unit of work alike.
 */
export function buildRepositories(db: Db): Repositories {
  return {
    users: new PrismaUserRepository(db),
    guests: new PrismaGuestSessionRepository(db),
    refreshTokens: new PrismaRefreshTokenRepository(db),
    preferences: new PrismaPreferencesRepository(db),
    securityEvents: new PrismaSecurityEventRepository(db),

    tables: new PrismaTableRepository(db),
    invites: new PrismaInviteRepository(db),
    chat: new PrismaChatRepository(db),

    games: new PrismaGameInstanceRepository(db),
    events: new PrismaGameEventRepository(db),
    snapshots: new PrismaGameSnapshotRepository(db),
    stats: new PrismaStatsRepository(db),
    matchResults: new PrismaMatchResultRepository(db),
    participants: new PrismaMatchParticipantRepository(db),

    wallets: new PrismaWalletRepository(db),
    rewardRules: new PrismaRewardRuleRepository(db),
    subscriptions: new PrismaSubscriptionRepository(db),
    cosmetics: new PrismaCosmeticRepository(db),
  }
}

/**
 * One transaction, one set of repositories bound to it (02 §5.4).
 *
 * Everything with more than one write that must not half-happen runs through
 * here: the guest→user claim's twelve steps (S22), reward settlement (S36), the
 * store debit (M7). A throw anywhere inside `work` rolls back **every** write —
 * asserted in `tests/integration/unit-of-work.test.ts`, because that property
 * is the reason the claim transaction can be trusted at all.
 *
 * The timeout is generous on purpose: SQLite serialises writers, and a claim
 * that touches a dozen tables should wait rather than fail on a busy evening.
 */
export class UnitOfWork implements IUnitOfWork {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { timeoutMs?: number; maxWaitMs?: number } = {},
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => work(buildRepositories(tx)), {
      maxWait: this.options.maxWaitMs ?? 5_000,
      timeout: this.options.timeoutMs ?? 15_000,
    })
  }
}
