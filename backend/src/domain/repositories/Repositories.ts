import type {
  ICosmeticRepository,
  IRewardRuleRepository,
  ISubscriptionRepository,
  IWalletRepository,
} from './economy.js'
import type {
  IGameEventRepository,
  IGameInstanceRepository,
  IGameSnapshotRepository,
  IStatsRepository,
} from './games.js'
import type { IMatchParticipantRepository, IMatchResultRepository } from './matches.js'
import type {
  IGuestSessionRepository,
  IPreferencesRepository,
  IRefreshTokenRepository,
  ISecurityEventRepository,
  IUserRepository,
} from './identity.js'
import type { IChatRepository, IInviteRepository, ITableRepository } from './tables.js'

/**
 * The full repository set, as one bundle.
 *
 * This is the type `UnitOfWork.run(repos => …)` hands a service, and the type
 * `container.ts` builds. Because the bundle is an interface in the *domain*,
 * a service signature never mentions Prisma — the transactional set and the
 * in-memory set are the same type, so a test swaps one for the other with no
 * cast and no adapter.
 */
export interface Repositories {
  readonly users: IUserRepository
  readonly guests: IGuestSessionRepository
  readonly refreshTokens: IRefreshTokenRepository
  readonly preferences: IPreferencesRepository
  readonly securityEvents: ISecurityEventRepository

  readonly tables: ITableRepository
  readonly invites: IInviteRepository
  readonly chat: IChatRepository

  readonly games: IGameInstanceRepository
  readonly events: IGameEventRepository
  readonly snapshots: IGameSnapshotRepository
  readonly stats: IStatsRepository
  /** Settled matches (S36). `gameId` is unique — settlement's outermost guard. */
  readonly matchResults: IMatchResultRepository
  readonly participants: IMatchParticipantRepository

  readonly wallets: IWalletRepository
  /** The caps and rates, as data (10 §3). Read inside the credit transaction. */
  readonly rewardRules: IRewardRuleRepository
  /** Read-only until M7: premium's 1.5× earn multiplier, and nothing else. */
  readonly subscriptions: ISubscriptionRepository
  readonly cosmetics: ICosmeticRepository
}

/**
 * A transactional scope. `infrastructure/prisma/UnitOfWork.ts` implements it
 * over `$transaction`; tests implement it as "just call the function", which is
 * honest — an in-memory fake has nothing to roll back.
 *
 * Everything the guest→user claim (S22) and reward settlement (S36) touch runs
 * inside one of these. A throw anywhere inside must leave nothing behind.
 */
export interface IUnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>
}
