import type { Logger } from 'pino'
import type {
  CreateInviteRequest,
  InviteResponse,
  PublicInviteResponse,
} from '../../contracts/dto/invites.js'
import type { Invite } from '../../domain/entities/table.js'
import {
  IllegalPhaseTransitionError,
  InviteExpiredError,
  NotFoundError,
} from '../../domain/errors/errors.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import type { GameRegistry } from '../../domain/games/registry.js'
import { activeMembers } from '../mappers/tables.js'
import type { RequestContext } from '../ports/auth.js'
import type { IInviteCodeGenerator } from '../ports/invites.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { SecurityEventService } from './SecurityEventService.js'

/**
 * Invites — S19. The mechanism journey J1→J2 rests on.
 *
 * ★ **`resolve` takes no identity and never reads a cookie.** That is the whole
 * feature: a friend opens the link in a private window, sees which game and
 * who is hosting, types a name, and is seated. An invite that required an
 * account first would turn a thirty-second join into a signup funnel, which is
 * exactly the product this platform is trying not to be (persona P2).
 *
 * ★ **Revoked, expired, exhausted and never-existed are one answer.** All four
 * produce the same `410 INVITE_EXPIRED` with a byte-identical body (07 §5.2).
 * Any difference between them — a distinct code, an extra `details` field, a
 * different message — turns the endpoint into an oracle for enumerating live
 * codes, so there is exactly one exit for every failure below.
 */

export interface InviteServiceDeps {
  readonly repos: Repositories
  readonly registry: GameRegistry
  readonly codes: IInviteCodeGenerator
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  /** `INVITE_TTL_HOURS` — the default life of a link. */
  readonly defaultTtlHours: number
  readonly now?: () => Date
}

/** Codes are 8 chars from a 30-symbol alphabet; five tries is already absurd. */
const MINT_ATTEMPTS = 5

export class InviteService {
  private readonly now: () => Date

  constructor(private readonly deps: InviteServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** Host only — the route enforces level **H** before this is called. */
  async mint(
    tableId: string,
    createdByUserId: string,
    input: CreateInviteRequest = {},
  ): Promise<InviteResponse> {
    const table = await this.deps.repos.tables.findById(tableId)
    if (table === null) throw new NotFoundError('Table', { tableId })
    if (table.closedAt !== null || table.status === 'CLOSED') {
      throw new IllegalPhaseTransitionError(table.status, 'WAITING', { tableId })
    }

    const ttlHours = input.expiresInHours ?? this.deps.defaultTtlHours
    const expiresAt = new Date(this.now().getTime() + ttlHours * 60 * 60 * 1000)

    const invite = await this.insertWithFreshCode({
      tableId,
      createdByUserId,
      expiresAt,
      maxUses: input.maxUses ?? null,
    })

    this.deps.metrics.increment('invites_minted')
    this.deps.logger.info({ tableId, inviteId: invite.id }, 'invite minted')

    return toInviteResponse(invite)
  }

  /**
   * Revocation is a **tombstone, not a delete**: `revokedAt` is what makes a
   * leaked link stop working while keeping the row that says the link existed,
   * who minted it and how often it was used. `GuestSession.tableId` already
   * points at guests who joined through it.
   */
  async revoke(tableId: string, code: string): Promise<InviteResponse> {
    const invite = await this.deps.repos.invites.findByCode(code)
    // Scoped to the table in the path: a host may only revoke their own
    // table's links, even holding a valid code for someone else's.
    if (invite === null || invite.tableId !== tableId) {
      throw new NotFoundError('Invite', { tableId })
    }

    const revoked =
      invite.revokedAt !== null
        ? invite
        : await this.deps.repos.invites.revoke(invite.id, this.now())

    this.deps.metrics.increment('invites_revoked')
    this.deps.logger.info({ tableId, inviteId: invite.id }, 'invite revoked')

    return toInviteResponse(revoked)
  }

  async listByTable(tableId: string): Promise<InviteResponse[]> {
    const invites = await this.deps.repos.invites.listByTable(tableId)
    return invites.map(toInviteResponse)
  }

  /**
   * ★ The public resolve — no authentication, by design.
   *
   * @throws {InviteExpiredError} for revoked, expired, exhausted, unknown, and
   *         for a link to a table that has since closed. One body, five causes.
   */
  async resolve(code: string, context: RequestContext = {}): Promise<PublicInviteResponse> {
    const now = this.now()
    const invite = await this.deps.repos.invites.findValidByCode(code, now)

    if (invite === null) return this.refuse(context, 'INVITE_NOT_USABLE')

    const table = await this.deps.repos.tables.findById(invite.tableId)
    // A dangling invite (table deleted) and a closed table are both dead
    // links, and must answer exactly as an unknown code does.
    if (table === null || table.closedAt !== null || table.status === 'CLOSED') {
      return this.refuse(context, 'TABLE_UNAVAILABLE')
    }

    const members = activeMembers(await this.deps.repos.tables.listMembers(table.id))
    const seatsTaken = members.filter((member) => member.seat !== null).length

    // `meta()` throws for a slug that is no longer registered — a table created
    // for a game we have since withdrawn. Treat it as a dead link rather than
    // a 500 on a public route.
    const meta = this.deps.registry.has(table.gameSlug)
      ? this.deps.registry.meta(table.gameSlug)
      : null
    if (meta === null) return this.refuse(context, 'GAME_UNAVAILABLE')

    const host =
      table.hostUserId === null ? null : await this.deps.repos.users.findById(table.hostUserId)

    this.deps.metrics.increment('invites_resolved')

    return {
      gameSlug: table.gameSlug,
      gameNameKey: meta.preview.nameKey,
      // A display name, and nothing else about the host. No id, no email —
      // this payload goes to anyone holding the code.
      hostDisplayName: host?.displayName ?? null,
      seatCount: table.seatCount,
      seatsFree: Math.max(0, table.seatCount - seatsTaken),
      inProgress: table.status === 'IN_PROGRESS',
      allowSpectators: table.allowSpectators,
      requireApproval: table.requireApproval,
    }
  }

  /**
   * One exit for every failure, so the response cannot accidentally diverge
   * between causes. The *reason* is recorded in the audit row, where it is
   * useful, and never sent to the caller who supplied the code.
   */
  private refuse(context: RequestContext, reason: string): never {
    this.deps.security.record('INVITE_ABUSE', {
      ip: context.ip,
      userAgent: context.userAgent,
      details: { reason },
    })
    this.deps.metrics.increment('invite_resolve_failures')
    throw new InviteExpiredError()
  }

  private async insertWithFreshCode(data: {
    tableId: string
    createdByUserId: string
    expiresAt: Date
    maxUses: number | null
  }): Promise<Invite> {
    let lastError: unknown

    for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt += 1) {
      try {
        return await this.deps.repos.invites.create({ ...data, code: this.deps.codes.next() })
      } catch (error) {
        // `Invite.code` is unique, so a collision surfaces as a constraint
        // violation. Retrying with a new code is the correct response and the
        // only one that stays correct under concurrency — checking whether a
        // code is free before inserting it has the same race the seat claim
        // avoids for the same reason.
        lastError = error
        this.deps.logger.warn({ attempt }, 'invite code collision — retrying')
      }
    }

    throw lastError
  }
}

function toInviteResponse(invite: Invite): InviteResponse {
  return {
    code: invite.code,
    // The server owns the link shape: `/t/:code` is the frontend's invite
    // landing route (S43), and having one place decide it means changing it
    // later does not mean grepping for string concatenation in the client.
    joinPath: `/t/${invite.code}`,
    expiresAt: invite.expiresAt.toISOString(),
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  }
}
