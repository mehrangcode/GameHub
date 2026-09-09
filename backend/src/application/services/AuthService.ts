import type { Logger } from 'pino'
import { ASSET_CODES } from '../../contracts/enums.js'
import type {
  AuthSessionResponse,
  Identity,
  LoginRequest,
  RegisterRequest,
} from '../../contracts/dto/auth.js'
import { ForbiddenError, UnauthorizedError } from '../../domain/errors/errors.js'
import type { Repositories, IUnitOfWork } from '../../domain/repositories/Repositories.js'
import type { User } from '../../domain/entities/user.js'
import { userRef } from '../../domain/value-objects/identity.js'
import { toUserIdentity } from '../mappers/identity.js'
import { assertPasswordAcceptable } from '../policies/password.js'
import { assertDisplayNameAllowed } from '../policies/displayName.js'
import type { IPasswordHasher, ITokenIssuer, RequestContext } from '../ports/auth.js'
import type { LoginThrottle } from './LoginThrottle.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { SecurityEventService } from './SecurityEventService.js'

/**
 * Registration, login, refresh rotation and logout — S13, S14.
 *
 * The service returns tokens; it does not touch cookies. Cookie attributes are
 * an HTTP concern and live in `infrastructure/auth/cookies.ts`, which is why
 * every method here is callable from a test with no `Response` in sight.
 */

export interface IssuedSession extends AuthSessionResponse {
  /** For the `access` cookie. */
  readonly accessToken: string
  /** For the `refresh` cookie. */
  readonly refreshToken: string
}

export interface AuthServiceDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly hasher: IPasswordHasher
  readonly tokens: ITokenIssuer
  readonly throttle: LoginThrottle
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

export class AuthService {
  private readonly now: () => Date
  /** Lazily built decoy for {@link burnTiming}. */
  private decoyHash: string | undefined

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Creates an account and everything an account cannot exist without — in
   * **one** transaction.
   *
   * A user with no `Wallet` row is not a lesser user, it is a user who crashes
   * the wallet screen; a user with no `UserPreferences` has no locale. So the
   * unit of work is "a usable account", not "a `User` row", and a failure
   * anywhere in it leaves nothing behind (the property S13's duplicate-email
   * test checks).
   */
  async register(input: RegisterRequest, context: RequestContext = {}): Promise<IssuedSession> {
    assertDisplayNameAllowed(input.displayName)
    assertPasswordAcceptable(input.password, {
      email: input.email,
      displayName: input.displayName,
    })

    // Hashing is 50–100 ms of deliberate CPU burn. Doing it *before* opening
    // the transaction keeps a write transaction from being held open for it.
    const passwordHash = await this.deps.hasher.hash(input.password)
    const now = this.now()

    const { user, redirectTo } = await this.deps.uow.run(async (repos) => {
      // No `findByEmail` pre-check: the unique constraint decides, and the
      // repository turns it into `EmailTakenError` (03 §6.3's discipline).
      const created = await repos.users.create({
        email: input.email,
        passwordHash,
        displayName: input.displayName,
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      })

      await repos.preferences.upsert(created.id, {
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      })

      // One wallet per asset, all VESTED — a real account's balance is
      // spendable from the first coin (10 §2.2). Guests get PROVISIONAL.
      for (const assetCode of ASSET_CODES) {
        await repos.wallets.ensure(userRef(created.id), assetCode)
      }

      for (const item of await repos.cosmetics.listItems({
        unlockKind: 'DEFAULT',
        active: true,
      })) {
        await repos.cosmetics.unlock(created.id, item.id, now)
      }

      await repos.users.touchLastSeen(created.id, now)

      return { user: created, redirectTo: await this.resolveInvite(repos, input.inviteCode, now) }
    })

    this.deps.metrics.increment('registrations')
    return this.issue(user, redirectTo, context, undefined)
  }

  /**
   * Verifies a password and issues a session.
   *
   * **Wrong password and unknown email are indistinguishable** — same status,
   * same body, and the same amount of work: an unknown email still pays for one
   * argon2 verification against a decoy hash. Skipping that makes the response
   * time itself a user-enumeration oracle, which is the failure mode that
   * survives every attempt to fix it in the response body alone.
   */
  async login(input: LoginRequest, context: RequestContext = {}): Promise<IssuedSession> {
    const ip = context.ip ?? 'unknown'
    await this.deps.throttle.attempt(input.email, ip)

    const user = await this.deps.repos.users.findByEmail(input.email)
    const ok = user
      ? await this.deps.hasher.verify(user.passwordHash, input.password)
      : await this.burnTiming(input.password)

    if (!user || !ok) {
      this.deps.metrics.increment('logins_failed')
      throw new UnauthorizedError('Invalid credentials', { reason: 'INVALID_CREDENTIALS' })
    }

    // A banned player who types the right password has earned a clear answer.
    // This is not enumeration: they already proved they own the account.
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenError('Account is not active', {
        status: user.status,
        ...(user.statusReason === null ? {} : { statusReason: user.statusReason }),
      })
    }

    const now = this.now()
    // Raising the argon2 cost only protects new accounts unless existing hashes
    // are upgraded, and login is the only moment the plaintext is in hand.
    if (this.deps.hasher.needsRehash(user.passwordHash)) {
      const rehashed = await this.deps.hasher.hash(input.password)
      await this.deps.repos.users.update(user.id, { passwordHash: rehashed })
      this.deps.logger.info({ userId: user.id }, 'password hash upgraded to current cost')
    }

    await this.deps.repos.users.touchLastSeen(user.id, now)
    await this.deps.throttle.clear(input.email, ip)
    this.deps.metrics.increment('logins')

    return this.issue(user, null, context, undefined)
  }

  /**
   * ★ Rotates a refresh token, with family revocation on reuse — 03 §6.2.
   *
   * The containment property, spelled out:
   *
   *   - Every refresh issues a **new** token in the same `familyId` and marks
   *     the old one `replacedById`.
   *   - Presenting a token that was **already revoked** means two parties hold
   *     tokens from one login: the cookie leaked. There is no way to tell the
   *     thief from the victim, so the whole family dies and both must log in
   *     again. A stolen refresh token is contained in minutes instead of
   *     granting 30 days of access.
   *   - Two refreshes racing is *not* reuse — both presented an active token.
   *     `revokeIfActive` picks a winner atomically and the loser gets a 401 it
   *     can retry with the winner's cookie.
   */
  async refresh(
    presented: string | undefined,
    context: RequestContext = {},
  ): Promise<IssuedSession> {
    if (!presented) throw new UnauthorizedError('No refresh token', { reason: 'NO_TOKEN' })

    const tokenHash = this.deps.tokens.hashRefresh(presented)
    const existing = await this.deps.repos.refreshTokens.findByTokenHash(tokenHash)
    const now = this.now()

    if (!existing) {
      // Unknown hash: forged, or from a family already deleted. Either way the
      // presenter has a credential we did not issue.
      this.deps.security.record('BAD_TOKEN', {
        ip: context.ip,
        userAgent: context.userAgent,
        details: { reason: 'UNKNOWN_REFRESH_TOKEN' },
      })
      throw new UnauthorizedError('Invalid refresh token', { reason: 'UNKNOWN_TOKEN' })
    }

    if (existing.revokedAt !== null) {
      const revoked = await this.deps.repos.refreshTokens.revokeFamily(existing.familyId, now)
      this.deps.metrics.increment('token_reuse_detected')
      await this.deps.security.recordAndWait(
        'BAD_TOKEN',
        {
          userId: existing.userId,
          ip: context.ip,
          userAgent: context.userAgent,
          details: {
            reason: 'REFRESH_TOKEN_REUSED',
            familyId: existing.familyId,
            tokensRevoked: revoked,
          },
        },
        // A leaked cookie being replayed is the loudest thing this endpoint
        // ever sees. It outranks its default severity.
        'ALERT',
      )
      throw new UnauthorizedError('Refresh token was already used', { reason: 'TOKEN_REUSED' })
    }

    if (existing.expiresAt.getTime() <= now.getTime()) {
      // Expiry is ordinary, not suspicious: 401, no audit row, and definitely
      // no 500 (the S14 test that exists because this is easy to get wrong).
      throw new UnauthorizedError('Refresh token expired', { reason: 'TOKEN_EXPIRED' })
    }

    const user = await this.deps.repos.users.findById(existing.userId)
    if (!user || user.status !== 'ACTIVE') {
      await this.deps.repos.refreshTokens.revokeFamily(existing.familyId, now)
      throw new UnauthorizedError('Account cannot be refreshed', { reason: 'ACCOUNT_INACTIVE' })
    }

    const next = await this.deps.uow.run(async (repos) => {
      // Claim first. If someone else already rotated this token between the
      // read above and here, we lose and write nothing at all.
      if (!(await repos.refreshTokens.revokeIfActive(existing.id, now))) {
        throw new UnauthorizedError('Refresh already in flight', { reason: 'ROTATION_RACE' })
      }

      const minted = this.deps.tokens.issueRefresh({ familyId: existing.familyId })
      const created = await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: minted.tokenHash,
        familyId: minted.familyId,
        expiresAt: minted.expiresAt,
        ...(context.userAgent ? { userAgent: context.userAgent } : {}),
        ...(context.ip ? { ip: context.ip } : {}),
      })
      await repos.refreshTokens.update(existing.id, { replacedById: created.id })

      return minted
    })

    return this.issue(user, null, context, next)
  }

  /**
   * Revokes the presented token's whole family and reports nothing about it.
   *
   * Family-wide rather than token-only: "log out" from a user's point of view
   * means "this device's session is over", and a session *is* a family. It is
   * also idempotent — an unknown or missing token is a successful logout, since
   * the only honest outcome of "end my session" when there is no session is
   * "done".
   */
  async logout(presented: string | undefined, context: RequestContext = {}): Promise<void> {
    if (!presented) return

    const existing = await this.deps.repos.refreshTokens.findByTokenHash(
      this.deps.tokens.hashRefresh(presented),
    )
    if (!existing) return

    await this.deps.repos.refreshTokens.revokeFamily(existing.familyId, this.now())
    this.deps.logger.info({ userId: existing.userId, ip: context.ip }, 'session ended')
  }

  /**
   * S14's cleanup job: drops rows nobody can ever use again.
   *
   * Expired *and* revoked tokens both go — a revoked row's only remaining
   * purpose is reuse detection, and a token past its expiry is refused by the
   * expiry check anyway, so keeping it buys nothing. Guest sessions expire on
   * the same schedule (12 h) and are swept here too, except claimed ones:
   * those are audit records of a J2 conversion and are kept forever (03 §7).
   */
  async purgeExpired(): Promise<{ refreshTokens: number; guestSessions: number }> {
    const now = this.now()
    return {
      refreshTokens: await this.deps.repos.refreshTokens.deleteExpired(now),
      guestSessions: await this.deps.repos.guests.deleteExpired(now),
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async issue(
    user: User,
    redirectTo: string | null,
    context: RequestContext,
    rotated: { token: string; tokenHash: string; familyId: string; expiresAt: Date } | undefined,
  ): Promise<IssuedSession> {
    const access = await this.deps.tokens.issueAccess({ userId: user.id, role: user.role })
    const refresh = rotated ?? (await this.startFamily(user, context))

    return {
      identity: toUserIdentity(user) satisfies Identity,
      redirectTo,
      accessToken: access.token,
      refreshToken: refresh.token,
    }
  }

  private async startFamily(user: User, context: RequestContext) {
    const minted = this.deps.tokens.issueRefresh()
    await this.deps.repos.refreshTokens.create({
      userId: user.id,
      tokenHash: minted.tokenHash,
      familyId: minted.familyId,
      expiresAt: minted.expiresAt,
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
      ...(context.ip ? { ip: context.ip } : {}),
    })
    return minted
  }

  /**
   * A dead invite must not fail a sign-up: the account is still wanted, the
   * player just has nowhere to be sent. So this resolves leniently and returns
   * `null` rather than throwing.
   */
  private async resolveInvite(
    repos: Repositories,
    inviteCode: string | undefined,
    now: Date,
  ): Promise<string | null> {
    if (!inviteCode) return null
    const invite = await repos.invites.findValidByCode(inviteCode, now)
    return invite ? `/table/${invite.tableId}` : null
  }

  /**
   * Spends roughly one password verification on an unknown email.
   *
   * The decoy hash is generated once, lazily, at the current cost — so this
   * tracks the real cost automatically when the argon2 parameters are raised.
   */
  private async burnTiming(password: string): Promise<false> {
    this.decoyHash ??= await this.deps.hasher.hash('timing-equalisation-decoy-value')
    await this.deps.hasher.verify(this.decoyHash, password)
    return false
  }
}
