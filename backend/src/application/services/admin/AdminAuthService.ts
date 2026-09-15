import type { Logger } from 'pino'
import type { AdminEnrollResponse, AdminLoginResponse } from '../../../contracts/admin/auth.js'
import type { AdminCredential, AdminSession } from '../../../domain/entities/admin.js'
import type { User } from '../../../domain/entities/user.js'
import { AdminLockedError, MfaEnrollmentRequiredError } from '../../../domain/errors/admin.js'
import { ForbiddenError, UnauthorizedError } from '../../../domain/errors/errors.js'
import type { IUnitOfWork, Repositories } from '../../../domain/repositories/Repositories.js'
import type { AdminAuthPolicy, IAdminTokenIssuer, ITotpProvider } from '../../ports/admin.js'
import type { IPasswordHasher } from '../../ports/auth.js'
import type { MetricsRegistry } from '../MetricsRegistry.js'
import type { SecurityEventService } from '../SecurityEventService.js'

/**
 * ★ Admin authentication — 12-admin-console.md §3.3, §3.4.
 *
 * Two steps, never one field. The password step and the code step are separate
 * requests with separate rate limits (applied by the router), because
 * brute-forcing a six-digit code is the realistic attack and it needs its own
 * counter — a combined endpoint would let a correct password reset the budget
 * that protects the code.
 *
 * What this service refuses to do, and why each refusal is load-bearing:
 *
 *   - **Issue anything to a `USER`.** The role check happens at the *password*
 *     step, so a player's correct credentials get the same answer as a wrong
 *     password. `:3100` is not a place a player is told exists.
 *   - **Let an unenrolled admin past `/auth/totp/enroll`.** `totpEnrolledAt`
 *     is the single source of truth for "enrolled", checked before anything
 *     decrypts, so the seed's empty `totpSecretEnc` can never be verified
 *     against.
 *   - **Accept a code twice.** `lastTotpStep` advances on every success.
 *   - **Refresh a session from a new IP.** It is revoked instead. A session
 *     cookie that travels is a session cookie that was copied.
 */

/** 12 §3.3 — the password step's receipt. Held in memory; see {@link Challenge}. */
interface Challenge {
  readonly userId: string
  readonly expiresAt: number
  readonly enrollmentRequired: boolean
  readonly ip: string
}

export interface AdminAuthDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly hasher: IPasswordHasher
  /** The second factor, behind a port — see `application/ports/admin.ts`. */
  readonly totp: ITotpProvider
  readonly tokens: IAdminTokenIssuer
  readonly policy: AdminAuthPolicy
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

export interface AdminRequestContext {
  readonly ip: string
  readonly userAgent: string
  readonly requestId: string
}

export interface IssuedAdminSession {
  readonly session: AdminSession
  readonly user: User
  /** For the `admin_access` cookie — minted by the interface layer. */
  readonly refreshToken: string
}

export interface ResolvedAdminSession {
  readonly session: AdminSession
  readonly user: User
}

export class AdminAuthService {
  private readonly now: () => Date
  private decoyHash: string | undefined

  /**
   * Challenges live in memory, deliberately.
   *
   * They are worth 120 seconds and prove exactly one thing — that a password
   * was verified a moment ago. Persisting them would add a table, a cleanup
   * job and a migration to hold something whose correct behaviour on restart is
   * *to be gone*; putting them in Redis would put an authentication step into
   * the one component 02 §3.2 says must only hold what is cheap to lose.
   *
   * The cost is that a restart mid-login means logging in again, and that a
   * second admin-api replica would not share them. The deployment is one
   * process (12 §2.1), and if that ever changes this is the line to revisit.
   */
  private readonly challenges = new Map<string, Challenge>()

  constructor(private readonly deps: AdminAuthDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  // ── step 1 ───────────────────────────────────────────────────────────────

  /**
   * Verifies the password and hands back a challenge.
   *
   * No cookie is set here and no session exists yet: holding a correct password
   * is not authentication on this surface, it is half of it.
   */
  async login(
    input: { email: string; password: string },
    context: AdminRequestContext,
  ): Promise<AdminLoginResponse> {
    const user = await this.deps.repos.users.findByEmail(input.email)

    // The verification runs even when there is no such user, against a decoy
    // hash of the same cost — otherwise the response time distinguishes "no
    // such admin" from "wrong password", and the console's login page becomes
    // a way to enumerate which accounts are privileged.
    const passwordOk = user
      ? await this.deps.hasher.verify(user.passwordHash, input.password)
      : await this.burnTiming(input.password)

    const eligible = user !== null && (user.role === 'ADMIN' || user.role === 'SUPPORT')

    if (!user || !passwordOk || !eligible || user.status !== 'ACTIVE') {
      this.deps.metrics.increment('admin_logins_failed')
      // ★ One answer for all four failures: unknown email, wrong password,
      // a player's correct credentials, and a disabled admin. A player who
      // guesses the console's URL learns nothing about their own role from it.
      if (user && passwordOk && !eligible) {
        this.deps.security.record('BAD_TOKEN', {
          userId: user.id,
          ip: context.ip,
          userAgent: context.userAgent,
          details: { reason: 'ADMIN_LOGIN_NON_ADMIN_ROLE', role: user.role },
        })
      }
      throw new UnauthorizedError('Invalid credentials', { reason: 'INVALID_CREDENTIALS' })
    }

    const credential = await this.deps.repos.adminCredentials.findByUser(user.id)
    this.assertNotLocked(credential?.lockedUntil ?? null)

    const enrollmentRequired = credential === null || credential.totpEnrolledAt === null
    const ttlSec = this.deps.policy.challengeTtlSec
    const challengeId = this.mintChallenge({
      userId: user.id,
      enrollmentRequired,
      ip: context.ip,
      ttlSec,
    })

    return { challengeId, ttlSec, ...(enrollmentRequired ? { enrollmentRequired: true } : {}) }
  }

  // ── enrollment ───────────────────────────────────────────────────────────

  /**
   * Issues the secret and the recovery codes — once, and only to an admin who
   * has none.
   *
   * Reached with a **challenge**, not a session, and that is the resolution of
   * an apparent contradiction in 12 §5: the table marks this route `S`, but a
   * fresh admin cannot hold a session because issuing one requires the second
   * factor they are here to create. The challenge is what the password step
   * already proved, so it is exactly the right credential for this one route —
   * and no other route accepts it.
   */
  async enroll(challengeId: string, context: AdminRequestContext): Promise<AdminEnrollResponse> {
    const challenge = this.takeChallenge(challengeId, context, { keep: true })
    const user = await this.requireAdmin(challenge.userId)

    const existing = await this.deps.repos.adminCredentials.findByUser(user.id)
    if (existing?.totpEnrolledAt !== null && existing !== null) {
      // Not `MfaEnrollmentRequiredError`'s opposite number by accident: a
      // second enrollment would silently invalidate the authenticator the
      // operator is holding, which is how somebody locks themselves out of
      // their own console.
      throw new ForbiddenError('This admin is already enrolled', {
        reason: 'ALREADY_ENROLLED',
      })
    }

    const secret = this.deps.totp.generateSecret()
    const recovery = this.deps.totp.generateRecoveryCodes()

    await this.deps.repos.adminCredentials.enroll(user.id, {
      totpSecretEnc: this.deps.totp.encryptSecret(secret),
      recoveryCodeHashes: recovery.hashes,
      enrolledAt: this.now(),
    })

    this.deps.logger.info({ userId: user.id }, 'admin enrolled a second factor')
    this.deps.metrics.increment('admin_totp_enrollments')

    return {
      otpauthUri: this.deps.totp.provisioningUri({
        secret,
        account: user.email,
        issuer: this.deps.policy.issuer,
      }),
      secret,
      recoveryCodes: [...recovery.codes],
      challengeId,
    }
  }

  // ── step 2 ───────────────────────────────────────────────────────────────

  /**
   * Spends the challenge, verifies the code, and creates the session.
   *
   * The audit row is written here rather than by the route: "who was in the
   * console, from where, at what time" is an audit question, and a log that
   * recorded only writes could not answer it.
   */
  async verifyMfa(
    input: { challengeId: string; code: string },
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession & { refreshTokenHash: string }> {
    const challenge = this.takeChallenge(input.challengeId, context)
    const user = await this.requireAdmin(challenge.userId)
    const now = this.now()

    const credential = await this.deps.repos.adminCredentials.findByUser(user.id)
    if (credential === null || credential.totpEnrolledAt === null) {
      throw new MfaEnrollmentRequiredError({ reason: 'NOT_ENROLLED' })
    }
    this.assertNotLocked(credential.lockedUntil)

    const accepted = await this.checkSecondFactor(credential, input.code, now)
    if (accepted === null) {
      const after = await this.deps.repos.adminCredentials.recordFailure(user.id, now, {
        maxAttempts: this.deps.policy.mfaMaxAttempts,
        lockoutMs: this.deps.policy.lockoutMin * 60_000,
      })
      this.deps.metrics.increment('admin_mfa_failed')

      if (after.lockedUntil !== null) {
        this.deps.metrics.increment('admin_locked')
        this.deps.security.record(
          'BAD_TOKEN',
          {
            userId: user.id,
            ip: context.ip,
            userAgent: context.userAgent,
            details: {
              reason: 'ADMIN_MFA_LOCKOUT',
              failedAttempts: after.failedAttempts,
              lockedUntil: after.lockedUntil.toISOString(),
            },
          },
          // Five wrong codes against a console account is somebody working
          // through the space, not an operator fumbling. ALERT, not WARN.
          'ALERT',
        )
        throw new AdminLockedError(after.lockedUntil)
      }

      throw new UnauthorizedError('Invalid second factor', { reason: 'INVALID_MFA_CODE' })
    }

    if (accepted.kind === 'totp') {
      // ★ The replay guard. Written before the session exists, so a crash
      // between the two leaves a spent step and no session — the safe order.
      await this.deps.repos.adminCredentials.recordSuccess(user.id, accepted.step, now)
    } else {
      await this.deps.repos.adminCredentials.recordSuccess(
        user.id,
        credential.lastTotpStep ?? 0,
        now,
      )
      this.deps.metrics.increment('admin_recovery_codes_used')
      this.deps.security.record(
        'BAD_TOKEN',
        {
          userId: user.id,
          ip: context.ip,
          userAgent: context.userAgent,
          details: { reason: 'ADMIN_RECOVERY_CODE_USED' },
        },
        // Not a failure — but a recovery code being spent is exactly the event
        // an operator wants to see if it was not them who spent it.
        'WARN',
      )
    }

    const { token: refreshToken, hash: refreshTokenHash } = this.deps.tokens.mintRefreshToken()
    const session = await this.deps.repos.adminSessions.create({
      userId: user.id,
      tokenHash: refreshTokenHash,
      ip: context.ip,
      userAgent: context.userAgent,
      mfaAt: now,
      expiresAt: new Date(now.getTime() + this.deps.policy.sessionAbsoluteHours * 3_600_000),
    })

    await this.deps.repos.adminAudit.append(
      {
        actorUserId: user.id,
        actorIp: context.ip,
        actorUserAgent: context.userAgent,
        requestId: context.requestId,
        action: 'admin.login',
        targetType: 'session',
        targetId: session.id,
        reason: null,
        after: { sessionId: session.id, via: accepted.kind },
      },
      now,
    )

    this.deps.metrics.increment('admin_logins')
    this.deps.logger.info({ userId: user.id, sessionId: session.id }, 'admin signed in')

    return { session, user, refreshToken, refreshTokenHash }
  }

  // ── the session, on every request ────────────────────────────────────────

  /**
   * Loads and validates the session an access token names — the three clocks
   * from 12 §3.2, plus the IP pin.
   *
   * Every failure revokes rather than merely refusing. A session that failed
   * one of these checks is not a session that will pass the next one, and
   * leaving the row live means an attacker who guessed wrong once may try
   * again from a better address.
   */
  async resolveSession(
    sessionId: string,
    context: { ip: string },
  ): Promise<ResolvedAdminSession> {
    const now = this.now()
    const session = await this.deps.repos.adminSessions.findById(sessionId)

    if (session === null || session.revokedAt !== null) {
      throw new UnauthorizedError('No admin session', { reason: 'SESSION_REVOKED' })
    }
    if (session.expiresAt <= now) {
      await this.deps.repos.adminSessions.revoke(session.id, now)
      throw new UnauthorizedError('Admin session expired', { reason: 'SESSION_EXPIRED' })
    }
    if (now.getTime() - session.lastSeenAt.getTime() > this.deps.policy.sessionIdleMin * 60_000) {
      await this.deps.repos.adminSessions.revoke(session.id, now)
      throw new UnauthorizedError('Admin session went idle', { reason: 'SESSION_IDLE' })
    }
    if (session.ip !== context.ip) {
      // ★ Revoked, not refreshed (§3.2). A session cookie presented from a new
      // address is a session cookie that was copied — and the legitimate
      // operator whose ISP just rotated their address loses four seconds and a
      // login, which is the cheaper of the two mistakes to make.
      await this.deps.repos.adminSessions.revoke(session.id, now)
      this.deps.security.record(
        'BAD_TOKEN',
        {
          userId: session.userId,
          ip: context.ip,
          details: { reason: 'ADMIN_SESSION_IP_MOVED', boundTo: session.ip },
        },
        'ALERT',
      )
      throw new UnauthorizedError('Admin session is bound to another address', {
        reason: 'SESSION_IP_MISMATCH',
      })
    }

    const user = await this.requireAdmin(session.userId)
    await this.deps.repos.adminSessions.touch(session.id, now)

    return { session: { ...session, lastSeenAt: now }, user }
  }

  /** Rotates the refresh token in place. The absolute cap is never extended. */
  async refresh(
    refreshTokenHash: string,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession & { refreshTokenHash: string }> {
    const now = this.now()
    const session = await this.deps.repos.adminSessions.findByTokenHash(refreshTokenHash)

    if (session === null || session.revokedAt !== null || session.expiresAt <= now) {
      throw new UnauthorizedError('No admin session', { reason: 'SESSION_REVOKED' })
    }
    if (session.ip !== context.ip) {
      await this.deps.repos.adminSessions.revoke(session.id, now)
      throw new UnauthorizedError('Admin session is bound to another address', {
        reason: 'SESSION_IP_MISMATCH',
      })
    }

    const user = await this.requireAdmin(session.userId)
    const { token: refreshToken, hash: nextHash } = this.deps.tokens.mintRefreshToken()
    const rotated = await this.deps.repos.adminSessions.rotate(session.id, nextHash, now)

    return { session: rotated, user, refreshToken, refreshTokenHash: nextHash }
  }

  /**
   * ⚡ A fresh factor, without a new session — 12 §3.4.
   *
   * Four seconds and six digits is the entire cost of making a stolen laptop
   * session unable to mint coins or ban somebody.
   */
  async stepUp(
    session: AdminSession,
    code: string,
    context: AdminRequestContext,
  ): Promise<AdminSession> {
    const now = this.now()
    const credential = await this.deps.repos.adminCredentials.findByUser(session.userId)

    if (credential === null || credential.totpEnrolledAt === null) {
      throw new MfaEnrollmentRequiredError({ reason: 'NOT_ENROLLED' })
    }
    this.assertNotLocked(credential.lockedUntil)

    const accepted = await this.checkSecondFactor(credential, code, now)
    if (accepted === null) {
      const after = await this.deps.repos.adminCredentials.recordFailure(session.userId, now, {
        maxAttempts: this.deps.policy.mfaMaxAttempts,
        lockoutMs: this.deps.policy.lockoutMin * 60_000,
      })
      if (after.lockedUntil !== null) throw new AdminLockedError(after.lockedUntil)
      throw new UnauthorizedError('Invalid second factor', { reason: 'INVALID_MFA_CODE' })
    }

    if (accepted.kind === 'totp') {
      await this.deps.repos.adminCredentials.recordSuccess(session.userId, accepted.step, now)
    }

    this.deps.metrics.increment('admin_step_ups')
    const refreshed = await this.deps.repos.adminSessions.refreshMfa(session.id, now)
    await this.deps.repos.adminAudit.append(
      {
        actorUserId: session.userId,
        actorIp: context.ip,
        actorUserAgent: context.userAgent,
        requestId: context.requestId,
        action: 'admin.stepUp',
        targetType: 'session',
        targetId: session.id,
        reason: null,
      },
      now,
    )

    return refreshed
  }

  async logout(session: AdminSession, context: AdminRequestContext): Promise<void> {
    const now = this.now()
    await this.deps.repos.adminSessions.revoke(session.id, now)
    await this.deps.repos.adminAudit.append(
      {
        actorUserId: session.userId,
        actorIp: context.ip,
        actorUserAgent: context.userAgent,
        requestId: context.requestId,
        action: 'admin.logout',
        targetType: 'session',
        targetId: session.id,
        reason: null,
      },
      now,
    )
  }

  /** When the ⚡ window closes for a session. Sent to the console so it can pre-empt. */
  stepUpValidUntil(session: AdminSession): Date {
    return new Date(session.mfaAt.getTime() + this.deps.policy.stepUpWindowMin * 60_000)
  }

  isStepUpFresh(session: AdminSession): boolean {
    return this.stepUpValidUntil(session) > this.now()
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * A TOTP code, or a recovery code. One field, because the operator reaching
   * for a recovery code has already lost their phone and should not also have
   * to find a different button.
   */
  private async checkSecondFactor(
    credential: AdminCredential,
    code: string,
    now: Date,
  ): Promise<{ kind: 'totp'; step: number } | { kind: 'recovery' } | null> {
    // The plaintext secret never enters this scope — the port takes the
    // ciphertext and decrypts inside itself.
    const verified = this.deps.totp.verify(credential.totpSecretEnc, code, {
      nowMs: now.getTime(),
      minStep: credential.lastTotpStep,
    })
    if (verified !== null) return { kind: 'totp', step: verified.step }

    const hash = this.deps.totp.matchRecoveryCode(code, credential.recoveryCodeHashes)
    if (hash === null) return null

    // Single-use, and the repository arbitrates: two requests presenting the
    // same recovery code must not both succeed.
    const spent = await this.deps.repos.adminCredentials.consumeRecoveryCode(
      credential.userId,
      hash,
    )
    return spent ? { kind: 'recovery' } : null
  }

  private assertNotLocked(lockedUntil: Date | null): void {
    if (lockedUntil !== null && lockedUntil > this.now()) throw new AdminLockedError(lockedUntil)
  }

  /**
   * Re-reads the user on every request rather than trusting the token's claims.
   *
   * The same trade `authenticate` makes on the public side, and for a sharper
   * reason: an admin whose role was revoked, or who was disabled, must lose
   * access *now*, not when their 15-minute access token happens to expire.
   */
  private async requireAdmin(userId: string): Promise<User> {
    const user = await this.deps.repos.users.findById(userId)
    if (!user || user.status !== 'ACTIVE' || (user.role !== 'ADMIN' && user.role !== 'SUPPORT')) {
      throw new UnauthorizedError('Not an active admin', { reason: 'NOT_ADMIN' })
    }
    return user
  }

  private mintChallenge(input: {
    userId: string
    enrollmentRequired: boolean
    ip: string
    ttlSec: number
  }): string {
    this.sweepChallenges()
    const id = this.deps.tokens.mintChallengeId()
    this.challenges.set(id, {
      userId: input.userId,
      enrollmentRequired: input.enrollmentRequired,
      ip: input.ip,
      expiresAt: this.now().getTime() + input.ttlSec * 1000,
    })
    return id
  }

  /**
   * Reads a challenge and — unless `keep` — spends it.
   *
   * `keep` is for enrollment, which has to be followed immediately by the code
   * step using the same challenge. Everything else consumes: a challenge that
   * survived its `/auth/mfa` call would let a captured `challengeId` be paired
   * with a later code.
   */
  private takeChallenge(
    id: string,
    context: { ip: string },
    options: { keep?: boolean } = {},
  ): Challenge {
    this.sweepChallenges()
    const challenge = this.challenges.get(id)

    if (challenge === undefined || challenge.expiresAt <= this.now().getTime()) {
      this.challenges.delete(id)
      throw new UnauthorizedError('Login challenge is no longer valid', {
        reason: 'CHALLENGE_EXPIRED',
      })
    }
    // The second step has to come from the address that passed the first one.
    if (challenge.ip !== context.ip) {
      this.challenges.delete(id)
      throw new UnauthorizedError('Login challenge is bound to another address', {
        reason: 'CHALLENGE_IP_MISMATCH',
      })
    }

    if (options.keep !== true) this.challenges.delete(id)
    return challenge
  }

  private sweepChallenges(): void {
    const now = this.now().getTime()
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id)
    }
  }

  /** Test seam: how many challenges are outstanding. */
  get pendingChallenges(): number {
    return this.challenges.size
  }

  private async burnTiming(password: string): Promise<false> {
    this.decoyHash ??= await this.deps.hasher.hash('decoy-for-constant-time-admin-login')
    await this.deps.hasher.verify(this.decoyHash, password)
    return false
  }
}
