import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import type { IAdminTokenIssuer, ITotpProvider } from './application/ports/admin.js'
import { systemClock, type Clock } from './application/ports/clock.js'
import { AdminAuthService } from './application/services/admin/AdminAuthService.js'
import { AuditService } from './application/services/admin/AuditService.js'
import { ModerationService } from './application/services/admin/ModerationService.js'
import type { IRateLimiter } from './application/ports/rateLimiter.js'
import { MutableRealtimePublisher } from './application/ports/realtime.js'
import { MutableTurnObserver } from './application/ports/turns.js'
import { AuthService } from './application/services/AuthService.js'
import { ChatService } from './application/services/ChatService.js'
import { GameCatalogService } from './application/services/GameCatalogService.js'
import { GameSessionService } from './application/services/GameSessionService.js'
import { GuestClaimService } from './application/services/GuestClaimService.js'
import { GuestSessionService } from './application/services/GuestSessionService.js'
import { InviteService } from './application/services/InviteService.js'
import { LoginThrottle } from './application/services/LoginThrottle.js'
import { MetricsRegistry } from './application/services/MetricsRegistry.js'
import { PresenceService } from './application/services/PresenceService.js'
import { GuestForfeitService } from './application/services/GuestForfeitService.js'
import { ReconciliationService } from './application/services/ReconciliationService.js'
import { RewardService } from './application/services/RewardService.js'
import { SeatEnforcementService } from './application/services/SeatEnforcementService.js'
import { SecurityEventService } from './application/services/SecurityEventService.js'
import { SettlementService } from './application/services/SettlementService.js'
import { SudokuHintService } from './application/services/SudokuHintService.js'
import { TableService } from './application/services/TableService.js'
import { TurnTimerService } from './application/services/TurnTimerService.js'
import { WalletService } from './application/services/WalletService.js'
import type { AdminEnv, Env } from './config/env.js'
import { getEnv } from './config/env.js'
import { AdminTokenIssuer, Aes256TotpProvider } from './infrastructure/admin/adapters.js'
import { buildGameRegistry, type GameRegistry } from './domain/games/registry.js'
import { sudokuEngine } from './domain/games/sudoku/engine.js'
import type { IUnitOfWork, Repositories } from './domain/repositories/Repositories.js'
import {
  Argon2PasswordHasher,
  HmacGuestTokenIssuer,
  JwtTokenIssuer,
} from './infrastructure/auth/adapters.js'
import { RandomInviteCodeGenerator } from './infrastructure/invites/inviteCode.js'
import { getLogger } from './infrastructure/logger.js'
import { prisma as defaultPrisma } from './infrastructure/prisma/client.js'
import { checkDatabase, type DependencyStatus } from './infrastructure/prisma/health.js'
import { buildRepositories, UnitOfWork } from './infrastructure/prisma/UnitOfWork.js'
import { SlidingWindowRateLimiter } from './infrastructure/rateLimit/slidingWindow.js'
import { createRedisConnection, type RedisConnection } from './infrastructure/redis/client.js'
import { RedisPresenceMirror } from './infrastructure/redis/presenceMirror.js'
import { RedisTurnTimerMirror } from './infrastructure/redis/turnTimerMirror.js'
import { RedisRateLimiter } from './infrastructure/redis/RedisRateLimiter.js'

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

  /**
   * S21 — the ledger. Every credit in the platform goes through this one
   * object: the settlement path (S36), the daily bonus, achievements, the
   * premium grant and the admin adjustment all call `credit`, so the caps and
   * the idempotency rule cannot be bypassed by adding a new earn source.
   */
  readonly wallets: WalletService

  /**
   * S35 — reward policy. Stateless: `RewardService.compute` is static and pure,
   * and the instance exists only for the three lookups the formula needs (the
   * rate card, the subscription, the repeat-matchup count).
   */
  readonly rewards: RewardService
  /**
   * ★ S36 — the only thing in the platform that pays somebody for playing.
   * One transaction per finished match, per seat, keyed by
   * `match:{matchResultId}:{seat}`.
   */
  readonly settlement: SettlementService
  /** ★ S38 — E1, measured. Raises `LEDGER_DRIFT` and never self-heals. */
  readonly reconciliation: ReconciliationService
  /** S38 — expired provisional balances, zeroed by a ledger row (10 §3.4). */
  readonly guestForfeits: GuestForfeitService
  /** S22 — journey J2, in one transaction. */
  readonly guestClaims: GuestClaimService

  /**
   * S17 — the catalog. `registry` is the domain's list of games and is what
   * S30 hangs engines off; `catalog` is what the API is allowed to say about
   * them. Both are exposed because the socket gateway (S24) needs the registry
   * directly, while every REST route wants the mapped view.
   */
  readonly registry: GameRegistry
  readonly catalog: GameCatalogService
  readonly tables: TableService
  readonly invites: InviteService

  /**
   * S24 — the broadcasting seam. Late-bound: `createGateway` attaches the
   * Socket.IO adapter once the HTTP server exists, and until then (and in every
   * test that has no transport) it silently drops. That is the correct
   * behaviour for both, and it is what breaks the services ⇄ server ⇄ handlers
   * cycle without a DI framework.
   */
  readonly realtime: MutableRealtimePublisher
  /** S25 — disconnect grace, heartbeat, `away`. Owns real timers; `stop()` in shutdown. */
  readonly presence: PresenceService
  /** S26 — chat, emotes, and the i18n-keyed SYSTEM narration. */
  readonly chat: ChatService

  /**
   * S28–S30 — the event log. Every move in the platform goes through
   * `applyMove`, and every projection through `broadcastState`: state is never
   * held in a process map, so an API restart loses zero games.
   */
  readonly games: GameSessionService

  /**
   * S31 — turn deadlines. Absolute, persisted as a `PHASE` event, mirrored to
   * Redis when there is one. Owns real timers; `stop()` in shutdown.
   */
  readonly turnTimers: TurnTimerService
  /**
   * S32–S34 — the consequence of a deadline passing: strikes, the safest
   * default action, ejection, the bot that takes the seat, and the reclaim.
   * Observes turns; registered with `PresenceService` for the disconnect path.
   */
  readonly seats: SeatEnforcementService
  /**
   * S31 — the fan-out told after every state change. Attached to by
   * `turnTimers` and `seats`; see `application/ports/turns.ts` for why this is
   * a port rather than a call.
   */
  readonly turns: MutableTurnObserver

  /**
   * S27 — present only when `REDIS_URL` is set. `null` is the ordinary
   * single-instance deployment, not a degraded one: the in-memory socket
   * adapter and the in-process limiter are correct for one process, and Redis
   * earns its place when there is a second (02 §3.2).
   */
  readonly redis: RedisConnection | null
  readonly presenceMirror: RedisPresenceMirror | null
  readonly turnTimerMirror: RedisTurnTimerMirror | null

  /** Reports every configured dependency, and only the configured ones. */
  readonly checkReadiness: () => Promise<Record<string, DependencyStatus>>
  readonly shutdown: () => Promise<void>
}

export interface ContainerOverrides {
  readonly prisma?: PrismaClient
  readonly logger?: Logger
  readonly env?: Env
  /** Tests hand in a limiter with a tiny window instead of sleeping. */
  readonly rateLimiter?: IRateLimiter
  /** S25's timers, so a 90-second grace window does not have to elapse in a test. */
  readonly clock?: Clock
  /** Shortens every disconnect grace to this, ignoring `meta.disconnectGraceMs`. */
  readonly graceMsOverride?: number
}

export function buildContainer(overrides: ContainerOverrides = {}): Container {
  const env = overrides.env ?? getEnv()
  const logger = overrides.logger ?? getLogger()
  const prisma = overrides.prisma ?? defaultPrisma

  const repos = buildRepositories(prisma)
  const uow: IUnitOfWork = new UnitOfWork(prisma)

  const metrics = new MetricsRegistry()

  /**
   * ★ Redis is optional, and the whole platform is built so that this line can
   * produce `null` without anything downstream caring (02 §3.2). Unset
   * `REDIS_URL` means the in-memory socket adapter, the in-process limiter and
   * no presence mirror — which is the correct configuration for a
   * single-process deployment, not a fallback from a better one.
   */
  const redis =
    env.REDIS_URL === undefined
      ? null
      : createRedisConnection({
          url: env.REDIS_URL,
          logger,
          onDegraded: () => metrics.increment('redis_degraded'),
        })

  const rateLimiter =
    overrides.rateLimiter ??
    (redis === null ? new SlidingWindowRateLimiter() : new RedisRateLimiter(redis, logger))

  const presenceMirror = redis === null ? null : new RedisPresenceMirror(redis, logger)
  const turnTimerMirror = redis === null ? null : new RedisTurnTimerMirror(redis, logger)
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

  /**
   * Declared here, well before the gateway exists, because `WalletService`
   * needs it and is built first. That costs nothing: a `MutableRealtimePublisher`
   * with nothing attached silently drops, which is the right behaviour for the
   * whole window before `createGateway` attaches the Socket.IO adapter.
   */
  const realtime = new MutableRealtimePublisher()

  const wallets = new WalletService({ uow, repos, metrics, logger, realtime })

  /**
   * The two S38 maintenance jobs. Ordinary services with an ordinary method —
   * there is no scheduler in this process and deliberately so (see each class's
   * docblock). `scripts/dev-reconcile.ts` and `scripts/dev-forfeit.ts` invoke
   * them in development; production schedules them the way it already
   * schedules anything else.
   */
  const reconciliation = new ReconciliationService({ repos, security, metrics, logger })
  const guestForfeits = new GuestForfeitService({ repos, wallets, metrics, logger })

  const guestClaims = new GuestClaimService({
    uow,
    repos,
    guests,
    wallets,
    hasher,
    tokens,
    security,
    metrics,
    logger,
  })

  /**
   * `fixture` is registered outside production only (11 §1.1). The flag is read
   * from `env` rather than from `process.env` so a test can build a production
   * container and assert the dev game is genuinely absent.
   */
  const registry = buildGameRegistry({
    includeDevGames: env.NODE_ENV !== 'production',
    engines: [sudokuEngine],
  })
  const catalog = new GameCatalogService(registry)

  const tables = new TableService({ repos, catalog, security, metrics, logger, realtime })

  const presence = new PresenceService({
    repos,
    registry,
    realtime,
    metrics,
    logger,
    clock: overrides.clock ?? systemClock,
    ...(overrides.graceMsOverride === undefined
      ? {}
      : { graceMsOverride: overrides.graceMsOverride }),
    ...(presenceMirror === null ? {} : { mirror: presenceMirror }),
  })

  const chat = new ChatService({ repos, tables, realtime, rateLimiter, metrics, logger })

  /**
   * ★ The Phase H wiring, and the order of these six statements is the design.
   *
   * `games` announces every state change to `turns`; `turns` fans out to
   * `seats` and then to `turnTimers`. Nothing points back at `games` except
   * through `applySystemMove`, which is the one way a timeout or a bot may move
   * a piece — so the cycle that would otherwise exist (timers need the log, the
   * log needs the timers) is broken by a port and an attachment order rather
   * than by a framework.
   *
   * `seats` is attached **before** `turnTimers`: it clears the acting seat's
   * strike count, which `turnTimers` then reads for the countdown it
   * broadcasts. See `MutableTurnObserver.run`.
   */
  const turns = new MutableTurnObserver((error: unknown) =>
    logger.error({ err: error }, 'turn observer threw'),
  )

  /**
   * ★ Phase I. `rewards` is stateless policy; `settlement` is the only thing in
   * the platform that may pay somebody for playing.
   *
   * Built **before** `games` because the dependency runs one way only: a
   * finished game settles, and settlement has no interest in the move pipeline.
   * That is the difference between this and the turn observer above — no port,
   * no late binding, no attachment order to get wrong.
   */
  const rewards = new RewardService({ repos })

  /**
   * M1 — Sudoku's hint points (`games/sudoku.md` §13). One service, both halves
   * of the rule: it charges for a hint through the move pipeline's authorizer
   * seam, and grants one back through settlement's hook seam. Registered by
   * slug in both, so no game-agnostic service learns a Sudoku rule.
   */
  const sudokuHints = new SudokuHintService({ wallets, metrics, logger })

  const settlement = new SettlementService({
    uow,
    repos,
    rewards,
    wallets,
    realtime,
    metrics,
    logger,
    hooks: { sudoku: sudokuHints.asSettlementHook() },
  })

  const games = new GameSessionService({
    uow,
    repos,
    registry,
    catalog,
    tables,
    chat,
    realtime,
    security,
    metrics,
    logger,
    rateLimiter,
    clock: overrides.clock ?? systemClock,
    turns,
    settlement,
    moveAuthorizers: { sudoku: sudokuHints.asMoveAuthorizer() },
  })

  const turnTimers = new TurnTimerService({
    repos,
    registry,
    realtime,
    metrics,
    logger,
    clock: overrides.clock ?? systemClock,
    ...(turnTimerMirror === null ? {} : { mirror: turnTimerMirror }),
  })

  const seats = new SeatEnforcementService({
    repos,
    registry,
    games,
    timers: turnTimers,
    realtime,
    chat,
    metrics,
    logger,
    clock: overrides.clock ?? systemClock,
  })

  seats.attach()
  turns.attach(seats)
  turns.attach(turnTimers)
  // The disconnect path into the *same* ejection, with a different reason —
  // 04 §5.2. The mechanism shipped at S25; this is the consequence it was
  // waiting for.
  presence.onGraceExpired((event) => seats.onGraceExpired(event))

  const invites = new InviteService({
    repos,
    registry,
    codes: new RandomInviteCodeGenerator(),
    security,
    metrics,
    logger,
    defaultTtlHours: env.INVITE_TTL_HOURS,
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
    wallets,
    rewards,
    settlement,
    reconciliation,
    guestForfeits,
    guestClaims,
    registry,
    catalog,
    tables,
    invites,
    realtime,
    presence,
    chat,
    games,
    turnTimers,
    seats,
    turns,
    redis,
    presenceMirror,
    turnTimerMirror,
    checkReadiness: async () => ({
      database: await checkDatabase(prisma),
      // Reported only when configured. An unconfigured dependency listed as
      // failing would take a perfectly healthy single-instance deployment out
      // of rotation for not having a Redis it never wanted.
      ...(redis === null ? {} : { redis: await redis.check() }),
    }),
    shutdown: async () => {
      // Presence first: it holds armed grace timers, and one firing against a
      // disconnected Prisma client would log an error during every shutdown.
      presence.stop()
      // Same reasoning, and the same failure mode: an armed turn deadline
      // firing against a disconnected Prisma client is an error on every
      // shutdown, and a bot move scheduled behind it is a second one.
      turnTimers.stop()
      seats.stop()
      turns.detachAll()
      rateLimiter.dispose()
      await Promise.all([redis?.close(), prisma.$disconnect()])
    },
  }
}

/**
 * ★ The admin process's services — 12-admin-console.md §2.2.
 *
 * In **this** file rather than a parallel composition root, because the whole
 * argument for two entrypoints over two backends was that the money rules must
 * not fork. `buildAdminServices` takes the container the public API would have
 * built and adds to it: the same `repos`, the same `uow`, the same
 * `WalletService` further down the line. There is one ledger, and this function
 * is where that is visible.
 *
 * The public process never calls it, which is why `AdminEnv` — and therefore
 * `ADMIN_TOTP_ENC_KEY` — appears only here and in `admin-main.ts`. An API on
 * the public internet has no business holding the key that decrypts every
 * admin's second factor.
 */
export interface AdminServices {
  readonly auth: AdminAuthService
  /** S50 — reads the append-only log and walks its hash chain. No write path. */
  readonly audit: AuditService
  /** S50 — the one mutating capability, and the proof that the spine holds. */
  readonly moderation: ModerationService
  readonly totp: ITotpProvider
  readonly tokens: IAdminTokenIssuer
}

export function buildAdminServices(container: Container, env: AdminEnv): AdminServices {
  const totp = new Aes256TotpProvider(env.ADMIN_TOTP_ENC_KEY)
  const tokens = new AdminTokenIssuer(env)

  const auth = new AdminAuthService({
    uow: container.uow,
    repos: container.repos,
    // The *same* argon2 configuration as the player side. An admin password
    // verified more cheaply than a player's would be an odd thing to explain.
    hasher: new Argon2PasswordHasher(env),
    totp,
    tokens,
    policy: {
      challengeTtlSec: env.ADMIN_CHALLENGE_TTL_SEC,
      sessionAbsoluteHours: env.ADMIN_SESSION_ABSOLUTE_HOURS,
      sessionIdleMin: env.ADMIN_SESSION_IDLE_MIN,
      stepUpWindowMin: env.ADMIN_STEPUP_WINDOW_MIN,
      mfaMaxAttempts: env.ADMIN_MFA_MAX_ATTEMPTS,
      lockoutMin: env.ADMIN_LOCKOUT_MIN,
      issuer: env.JWT_ISSUER,
    },
    security: container.security,
    metrics: container.metrics,
    logger: container.logger.child({ process: 'admin' }),
  })

  const audit = new AuditService(container.repos)

  const moderation = new ModerationService({
    // ★ `container.uow` — the same unit of work the settlement path uses. That
    // is what lets `withAudit` put the audit row in the caller's transaction,
    // and it is the concrete reason A3 is enforceable rather than aspirational.
    uow: container.uow,
    repos: container.repos,
    metrics: container.metrics,
    logger: container.logger.child({ process: 'admin' }),
  })

  return { auth, audit, moderation, totp, tokens }
}
