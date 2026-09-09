import type { Logger } from 'pino'
import type { GuestIdentity, GuestRequest } from '../../contracts/dto/auth.js'
import { ForbiddenError, InviteExpiredError } from '../../domain/errors/errors.js'
import type { GuestSession } from '../../domain/entities/user.js'
import type { IUnitOfWork, Repositories } from '../../domain/repositories/Repositories.js'
import { guestRef } from '../../domain/value-objects/identity.js'
import { toGuestIdentity } from '../mappers/identity.js'
import { assertDisplayNameAllowed } from '../policies/displayName.js'
import type { IGuestTokenIssuer, RequestContext } from '../ports/auth.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { SecurityEventService } from './SecurityEventService.js'

/**
 * Guest identities — S16, persona P2, 07 §5.1.
 *
 * "Play with no account" is the feature the whole product hangs on: a friend
 * opens a link, types a name, and is seated. The engineering problem is doing
 * that **without minting a wildcard identity**, and the answer is that a guest
 * is born already bound to one table — the invite decides which, the caller
 * never says.
 */

export interface IssuedGuestSession {
  readonly identity: GuestIdentity
  readonly redirectTo: string
  /** For the `guest` cookie. */
  readonly guestToken: string
}

export interface GuestSessionServiceDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly guestTokens: IGuestTokenIssuer
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

export class GuestSessionService {
  private readonly now: () => Date

  constructor(private readonly deps: GuestSessionServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Creates a guest session from an invite code.
   *
   * Unknown, expired and revoked codes all produce the **same**
   * `INVITE_EXPIRED` response, deliberately: 07 §5.2 requires an identical
   * response shape for all three so that probing codes yields no signal about
   * which ones exist.
   */
  async create(input: GuestRequest, context: RequestContext = {}): Promise<IssuedGuestSession> {
    assertDisplayNameAllowed(input.displayName)
    const now = this.now()

    const guest = await this.deps.uow.run(async (repos) => {
      const invite = await repos.invites.findValidByCode(input.inviteCode, now)
      if (!invite) {
        this.deps.security.record('INVITE_ABUSE', {
          ip: context.ip,
          userAgent: context.userAgent,
          // The code is recorded, not echoed: useful in the audit table, and
          // invisible to the caller who supplied it.
          details: { reason: 'INVITE_NOT_USABLE' },
        })
        throw new InviteExpiredError()
      }

      // Consume before creating, so an exhausted `maxUses` cannot be raced into
      // an extra guest by two people clicking one link simultaneously.
      if ((await repos.invites.consumeUse(invite.id)) === null) {
        throw new InviteExpiredError('Invite has no uses left')
      }

      // ★ The table comes from the invite, never from the request body.
      const minted = this.deps.guestTokens.issue({ tableId: invite.tableId })
      const created = await repos.guests.create({
        tokenHash: minted.tokenHash,
        displayName: input.displayName,
        tableId: minted.tableId,
        expiresAt: minted.expiresAt,
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      })

      // PROVISIONAL: it accrues while they play and vests into a real account
      // on signup (10 §3.4). COIN only — gems and tickets are not earnable, so
      // a guest has no use for those wallets.
      await repos.wallets.ensure(guestRef(created.id), 'COIN')

      return { session: created, token: minted.token }
    })

    this.deps.metrics.increment('guest_sessions_created')
    this.deps.logger.info(
      { guestSessionId: guest.session.id, tableId: guest.session.tableId },
      'guest session created',
    )

    return {
      identity: toGuestIdentity(guest.session),
      redirectTo: `/table/${guest.session.tableId}`,
      guestToken: guest.token,
    }
  }

  /**
   * Resolves a presented guest cookie to a live session, or `null`.
   *
   * Three ways a structurally valid token still resolves to nothing, and all
   * three matter:
   *
   *   1. **No row** — the session was swept or never existed.
   *   2. **Expired** — past the 12-hour window (10 §3.4).
   *   3. **Claimed** — the guest became a real account, so the token must stop
   *      working *immediately*. A claimed token that still authenticated would
   *      be a second, weaker credential for a real user's seat (07 §5.1).
   *
   * It also re-checks that the row's `tableId` matches the signed one. The two
   * can only disagree if the signing key leaked or the row was edited, and in
   * either case continuing would be worse than refusing.
   */
  async resolve(token: string): Promise<GuestSession | null> {
    let parsed
    try {
      parsed = this.deps.guestTokens.parse(token)
    } catch {
      return null
    }

    const session = await this.deps.repos.guests.findByTokenHash(parsed.tokenHash)
    if (!session) return null
    if (session.claimedAt !== null) return null
    if (session.expiresAt.getTime() <= this.now().getTime()) return null
    if (session.tableId !== parsed.tableId) {
      this.deps.security.record('SEAT_IMPERSONATION', {
        guestSessionId: session.id,
        tableId: session.tableId,
        details: { reason: 'TOKEN_TABLE_MISMATCH', signedTableId: parsed.tableId },
      })
      return null
    }

    return session
  }

  /**
   * ★ The check that makes T7 structural — 07 §3.
   *
   * A guest asking about any table other than its own is not a mistake to
   * tolerate; it is the shape of a privilege-escalation attempt, so it is a 403
   * **and** an audit row. Called by the `enforceGuestBinding` middleware for
   * every table-scoped route, which is why no individual route has to remember.
   */
  assertBoundTo(identity: GuestIdentity, tableId: string, context: RequestContext = {}): void {
    if (identity.tableId === tableId) return

    this.deps.security.record('SEAT_IMPERSONATION', {
      guestSessionId: identity.guestSessionId,
      tableId,
      ip: context.ip,
      userAgent: context.userAgent,
      details: { boundTableId: identity.tableId, requestedTableId: tableId },
    })

    throw new ForbiddenError('Guest token is bound to a different table', {
      reason: 'GUEST_TABLE_BINDING',
    })
  }

  /** Sliding TTL (07 §5.1): activity keeps a game night's session alive. */
  async touch(guestSessionId: string): Promise<void> {
    await this.deps.repos.guests.update(guestSessionId, { lastSeenAt: this.now() })
  }
}
