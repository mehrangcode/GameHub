import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import type { IRateLimiter } from './application/ports/rateLimiter.js'
import { AuthService } from './application/services/AuthService.js'
import { GuestSessionService } from './application/services/GuestSessionService.js'
import { LoginThrottle } from './application/services/LoginThrottle.js'
import { MetricsRegistry } from './application/services/MetricsRegistry.js'
import { SecurityEventService } from './application/services/SecurityEventService.js'
import type { Env } from './config/env.js'
import { getEnv } from './config/env.js'
import type { IUnitOfWork, Repositories } from './domain/repositories/Repositories.js'
import {
  Argon2PasswordHasher,
  HmacGuestTokenIssuer,
  JwtTokenIssuer,
} from './infrastructure/auth/adapters.js'
import { getLogger } from './infrastructure/logger.js'
import { prisma as defaultPrisma } from './infrastructure/prisma/client.js'
import { checkDatabase, type DependencyStatus } from './infrastructure/prisma/health.js'
import { buildRepositories, UnitOfWork } from './infrastructure/prisma/UnitOfWork.js'
import { SlidingWindowRateLimiter } from './infrastructure/rateLimit/slidingWindow.js'

/**
 * 02-technical-prd.md §5.5 — the composition root. One file, explicit, no DI
 * framework.
 *
 * The value of writing the graph out by hand is that it is greppable: "who
 * constructs `RewardService`?" has exactly one answer, findable without
 * understanding a decorator.
 *
 * A test builds the same shape with `InMemory*Repository` fakes and gets the
 * same `Container` type — that is the point of `Repositories` being a domain
 * interface rather than a Prisma detail.
 */
export interface Container {
  readonly env: Env
  readonly logger: Logger
  readonly prisma: PrismaClient
  readonly repos: Repositories
  readonly uow: IUnitOfWork

  /** In-process today; Redis-backed behind the same port from S27. */
  readonly rateLimiter: IRateLimiter
  /** S15 — counters only. `/metrics` is an admin route, added in S49. */
  readonly metrics: MetricsRegistry
  readonly security: SecurityEventService
  readonly auth: AuthService
  readonly guests: GuestSessionService

  /** Powers `/ready`. Redis joins the report in S27. */
  readonly checkReadiness: () => Promise<{ database: DependencyStatus }>
  readonly shutdown: () => Promise<void>
}

export interface ContainerOverrides {
  readonly prisma?: PrismaClient
  readonly logger?: Logger
  readonly env?: Env
  /** Tests hand in a limiter with a tiny window instead of sleeping. */
  readonly rateLimiter?: IRateLimiter
}

export function buildContainer(overrides: ContainerOverrides = {}): Container {
  const env = overrides.env ?? getEnv()
  const logger = overrides.logger ?? getLogger()
  const prisma = overrides.prisma ?? defaultPrisma

  const repos = buildRepositories(prisma)
  const uow: IUnitOfWork = new UnitOfWork(prisma)
  const rateLimiter = overrides.rateLimiter ?? new SlidingWindowRateLimiter()

  const metrics = new MetricsRegistry()
  const security = new SecurityEventService(repos.securityEvents, logger, metrics)

  const hasher = new Argon2PasswordHasher(env)
  const tokens = new JwtTokenIssuer(env)
  const guestTokens = new HmacGuestTokenIssuer(env)

  const auth = new AuthService({
    uow,
    repos,
    hasher,
    tokens,
    throttle: new LoginThrottle(rateLimiter, env.LOGIN_MAX_ATTEMPTS, env.LOGIN_WINDOW_SEC),
    security,
    metrics,
    logger,
  })

  const guests = new GuestSessionService({
    uow,
    repos,
    guestTokens,
    security,
    metrics,
    logger,
  })

  return {
    env,
    logger,
    prisma,
    repos,
    uow,
    rateLimiter,
    metrics,
    security,
    auth,
    guests,
    checkReadiness: async () => ({ database: await checkDatabase(prisma) }),
    shutdown: async () => {
      rateLimiter.dispose()
      await prisma.$disconnect()
    },
  }
}
