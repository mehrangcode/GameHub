import type { Logger } from 'pino'
import type { GuestClaimRequest, Identity } from '../../contracts/dto/auth.js'
import { ASSET_CODES } from '../../contracts/enums.js'
import { guestForfeitKey, guestVestKey } from '../../domain/economy/idempotency.js'
import type { GuestSession, User } from '../../domain/entities/user.js'
import { UnauthorizedError } from '../../domain/errors/errors.js'
import type { IUnitOfWork, Repositories } from '../../domain/repositories/Repositories.js'
import { guestRef, userRef } from '../../domain/value-objects/identity.js'
import { toUserIdentity } from '../mappers/identity.js'
import { preferencesFromGuest } from '../mappers/preferences.js'
import { assertDisplayNameAllowed } from '../policies/displayName.js'
import { assertPasswordAcceptable } from '../policies/password.js'
import type { IPasswordHasher, ITokenIssuer, RequestContext } from '../ports/auth.js'
import type { GuestSessionService } from './GuestSessionService.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { SecurityEventService } from './SecurityEventService.js'
import type { WalletService } from './WalletService.js'

/**
 * ★ The guest→user claim — S22, journey J2, 03-data-model.md §6.1.
 *
 * A friend joined with no account, has been playing for forty minutes, has
 * earned coins, and now signs up **without leaving the table**. Twelve writes
 * across nine tables, and a partial failure loses somebody's seat mid-hand. So
 * it is one transaction, all of it or none of it, and the two steps that matter
 * most are:
 *
 * **Step 5 — the `TableMember` row is UPDATED, not recreated.** Same `id`, same
 * `seat`, same `team`, same `joinedAt`. No seat is vacated, so no
 * `table:seatVacated` is emitted, so from the other four players' point of view
 * *nothing happened* except a name badge losing its "guest" marker. Deleting
 * and re-inserting would be simpler to write and would flash an empty seat
 * across four screens mid-trick.
 *
 * **Step 9 — the coins come too.** `min(provisional, guestVestCap)` credited to
 * the new account, with a matched negative row on the guest wallet so coins are
 * *moved* rather than conjured (E1). This is what makes the sign-up pitch
 * concrete — "your 340 coins are now yours" — and it is why the vesting cap
 * exists: the incentive has to be real without making guest sessions a faucet.
 *
 * ### What happens when it fails
 *
 * Every failure mode 03 §6.1 names is a rollback of everything, and each is
 * tested: a duplicate email at step 2 leaves no user and no seat change, an
 * expired guest at step 1 creates nothing, and a throw at step 6 or step 9
 * unwinds the account *and* the seat transfer — because a claimed seat with no
 * wallet is exactly as broken as a wallet with no seat.
 *
 * ### Why the guest token cannot be replayed
 *
 * Step 11 is a **conditional** write (`claimIfUnclaimed`): it stamps
 * `claimedAt` only if the row is still unclaimed, and losing that race aborts
 * the whole transaction. Combined with `GuestSessionService.resolve` refusing
 * any session with `claimedAt` set, a claimed token is dead the instant the
 * transaction commits — and the row survives forever as the audit link between
 * the two identities.
 */

export interface ClaimedSession {
  readonly identity: Identity
  readonly redirectTo: string
  readonly vestedCoins: number
  readonly forfeitedCoins: number
  readonly seatPreserved: boolean
  /** For the `access` cookie. */
  readonly accessToken: string
  /** For the `refresh` cookie. */
  readonly refreshToken: string
}

export interface GuestClaimServiceDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly guests: GuestSessionService
  readonly wallets: WalletService
  readonly hasher: IPasswordHasher
  readonly tokens: ITokenIssuer
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
}

export class GuestClaimService {
  private readonly now: () => Date

  constructor(private readonly deps: GuestClaimServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * `POST /auth/guest/claim`.
   *
   * `guestToken` is the cookie value, not a body field — which guest is being
   * upgraded is never something a request may assert.
   */
  async claim(
    guestToken: string | undefined,
    input: GuestClaimRequest,
    context: RequestContext = {},
  ): Promise<ClaimedSession> {
    const session = await this.resolveClaimable(guestToken, context)

    const displayName = input.displayName ?? session.displayName
    assertDisplayNameAllowed(displayName)
    assertPasswordAcceptable(input.password, { email: input.email, displayName })

    // Outside the transaction on purpose: argon2 is 50–100 ms of deliberate CPU
    // burn, and holding a write transaction open for it would serialise every
    // other writer behind a hash (on SQLite, literally every one).
    const passwordHash = await this.deps.hasher.hash(input.password)
    const now = this.now()

    const claimed = await this.deps.uow.run(async (repos) => {
      // ── 1. verify the guest session, inside the transaction ───────────────
      // Re-read rather than trusting the resolve above: between the two, a
      // concurrent claim may have taken it.
      const live = await repos.guests.findById(session.id)
      if (!live || live.claimedAt !== null) throw claimRefused('ALREADY_CLAIMED')
      if (live.expiresAt.getTime() <= now.getTime()) throw claimRefused('GUEST_EXPIRED')

      // ── 2. the account ───────────────────────────────────────────────────
      // No `findByEmail` pre-check: `create` turns the unique constraint into
      // `EmailTakenError` (409), and that throw rolls back everything below.
      const user = await repos.users.create({
        email: input.email,
        passwordHash,
        displayName,
        locale: input.locale ?? live.locale,
        ...(live.avatarRef === null ? {} : { avatarRef: live.avatarRef }),
      })

      // ── 3. preferences chosen before signing up ──────────────────────────
      await repos.preferences.upsert(user.id, preferencesFromGuest(live, input.locale))

      // ── 4. the default cosmetics every account owns ───────────────────────
      for (const item of await repos.cosmetics.listItems({ unlockKind: 'DEFAULT', active: true })) {
        await repos.cosmetics.unlock(user.id, item.id, now)
      }

      // ── 5. ★ THE SEAT. An update, never a delete-and-insert ──────────────
      const member = await repos.tables.transferSeat(live.id, user.id)

      // ── 6, 7. re-attribution: the evening they just played is theirs ──────
      const events = await repos.events.reattributeActor(live.id, user.id)
      const messages = await repos.chat.reattributeActor(live.id, user.id)
      const participations = await repos.participants.reattributeActor(live.id, user.id)

      // ── 8. one VESTED wallet per asset ───────────────────────────────────
      for (const assetCode of ASSET_CODES) {
        await repos.wallets.ensure(userRef(user.id), assetCode)
      }

      // ── 9, 10. ★ THE COINS, moved rather than minted ─────────────────────
      const vesting = await this.vest(repos, live, user)

      // ── 11. ★ the arbitration point: claim it, or lose and roll back ──────
      const settled = await repos.guests.claimIfUnclaimed(live.id, user.id, now)
      if (!settled) throw claimRefused('CLAIM_RACE_LOST')

      // ── 12. a refresh token in a brand-new family ────────────────────────
      const minted = this.deps.tokens.issueRefresh()
      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: minted.tokenHash,
        familyId: minted.familyId,
        expiresAt: minted.expiresAt,
        ...(context.userAgent ? { userAgent: context.userAgent } : {}),
        ...(context.ip ? { ip: context.ip } : {}),
      })

      return {
        user,
        tableId: live.tableId,
        refresh: minted,
        seatPreserved: member !== null,
        ...vesting,
        rewritten: { events, messages, participations },
      }
    })

    const access = await this.deps.tokens.issueAccess({
      userId: claimed.user.id,
      role: claimed.user.role,
    })

    this.deps.metrics.increment('guest_claims')
    this.deps.metrics.increment('coins_vested', claimed.vestedCoins)
    this.deps.metrics.increment('coins_forfeited', claimed.forfeitedCoins)
    this.deps.logger.info(
      {
        userId: claimed.user.id,
        guestSessionId: session.id,
        tableId: claimed.tableId,
        vestedCoins: claimed.vestedCoins,
        forfeitedCoins: claimed.forfeitedCoins,
        seatPreserved: claimed.seatPreserved,
        rewritten: claimed.rewritten,
      },
      'guest session claimed',
    )

    return {
      identity: toUserIdentity(claimed.user),
      // ★ From the server, decided by the transaction that kept the seat.
      redirectTo: `/table/${claimed.tableId}`,
      vestedCoins: claimed.vestedCoins,
      forfeitedCoins: claimed.forfeitedCoins,
      seatPreserved: claimed.seatPreserved,
      accessToken: access.token,
      refreshToken: claimed.refresh.token,
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Steps 9 and 10, together, because they are one accounting entry.
   *
   *   - `+min(provisional, guestVestCap)` on the user's wallet (`GUEST_VEST`)
   *   - `−same` on the guest's wallet, so Σ across both is unchanged (E1)
   *   - `−remainder` as `GUEST_FORFEIT` when the cap bit, so the guest wallet
   *     lands on exactly zero and the shortfall is *explained* rather than
   *     merely absent
   *
   * All three carry keys derived from the guest session id, so a retry vests
   * once (10 §3.4). `exemptFromCaps` because vesting moves coins the holder
   * already earned under the caps — charging them against the daily cap again
   * would mean a guest who earned right up to the limit could not keep their
   * own balance.
   */
  private async vest(
    repos: Repositories,
    guest: GuestSession,
    user: User,
  ): Promise<{ vestedCoins: number; forfeitedCoins: number }> {
    const provisional = await repos.wallets.findByHolder(guestRef(guest.id), 'COIN')
    const available = Math.max(0, provisional?.balance ?? 0)
    if (!provisional || available === 0) return { vestedCoins: 0, forfeitedCoins: 0 }

    const vested = await this.deps.wallets.vestable(available, repos)
    const forfeited = available - vested

    if (vested > 0) {
      await this.deps.wallets.creditWithin(repos, {
        holder: userRef(user.id),
        asset: 'COIN',
        amount: vested,
        kind: 'GUEST_VEST',
        idempotencyKey: guestVestKey(guest.id),
        exemptFromCaps: true,
        refKind: 'guestSession',
        refId: guest.id,
      })
      await repos.wallets.append({
        walletId: provisional.id,
        amount: -vested,
        kind: 'GUEST_VEST',
        // The same derived key on the other wallet: uniqueness is per wallet,
        // so the pair shares one identity and both halves replay together.
        idempotencyKey: guestVestKey(guest.id),
        reason: 'VESTED_TO_USER',
        refKind: 'user',
        refId: user.id,
      })
    }

    if (forfeited > 0) {
      await repos.wallets.append({
        walletId: provisional.id,
        amount: -forfeited,
        kind: 'GUEST_FORFEIT',
        idempotencyKey: guestForfeitKey(guest.id),
        // Machine code, not prose: the statement renders it in the reader's
        // language (02 §8.1).
        reason: 'GUEST_VEST_CAP',
        refKind: 'user',
        refId: user.id,
      })
    }

    // The wallet is emptied but kept, and marked vested — it is the guest half
    // of the audit trail, and `PROVISIONAL` on a zeroed wallet would read as
    // "coins still waiting" on any screen that filters by status.
    await repos.wallets.markVested(provisional.id)

    return { vestedCoins: vested, forfeitedCoins: forfeited }
  }

  /**
   * Resolves the cookie, or refuses.
   *
   * Unlike `GET /invites/:code`, this endpoint may say *why*: the caller is
   * presenting a cookie **we issued to them**, so possession is already proof
   * and a `reason` confirms nothing about anyone else's session. That is worth
   * having, because "your guest session expired" and "this session was already
   * upgraded" send the player to two different screens.
   *
   * What is *not* distinguished is a token that resolves to nothing —
   * malformed, forged, unknown and swept all produce one `NO_GUEST_SESSION`,
   * because there the difference would be information about which tokens
   * exist.
   */
  private async resolveClaimable(
    guestToken: string | undefined,
    context: RequestContext,
  ): Promise<GuestSession> {
    const session = guestToken ? await this.deps.guests.resolve(guestToken) : null
    if (session) return session

    this.deps.metrics.increment('guest_claims_failed')
    this.deps.security.record('BAD_TOKEN', {
      ip: context.ip,
      userAgent: context.userAgent,
      details: { reason: guestToken ? 'GUEST_TOKEN_UNUSABLE' : 'NO_GUEST_TOKEN', route: 'claim' },
    })
    throw claimRefused('NO_GUEST_SESSION')
  }
}

/** One constructor, so every refusal is a 401 with a machine `reason`. */
function claimRefused(reason: string): UnauthorizedError {
  return new UnauthorizedError('Guest session cannot be claimed', { reason })
}
