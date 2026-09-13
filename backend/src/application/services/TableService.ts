import type { Logger } from 'pino'
import type {
  CreateTableRequest,
  PatchTableRequest,
  TableDetail,
  TableSummary,
} from '../../contracts/dto/tables.js'
import { withTurnEnforcementDefaults } from '../policies/turnEnforcement.js'
import type { Table, TableMember } from '../../domain/entities/table.js'
import {
  ForbiddenError,
  IllegalPhaseTransitionError,
  NotFoundError,
  SeatTakenError,
  ValidationError,
} from '../../domain/errors/errors.js'
import type { Repositories } from '../../domain/repositories/Repositories.js'
import { tableRoom, type IRealtimePublisher } from '../ports/realtime.js'
import type { IdentityRef, OccupantRef } from '../../domain/value-objects/identity.js'
import { seatId, teamOf, type SeatId } from '../../domain/value-objects/seat.js'
import {
  activeMembers,
  occupantIdsOf,
  toTableDetail,
  toTableSummary,
  type OccupantDirectory,
  type OccupantProfile,
} from '../mappers/tables.js'
import type { GameCatalogService } from './GameCatalogService.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import type { SecurityEventService } from './SecurityEventService.js'

/**
 * Tables — S18 (lifecycle) and S20 (seats).
 *
 * Two decisions here are worth knowing before reading the code:
 *
 * **Creating a table does not seat the host.** It would be convenient, and it
 * is wrong: seating is a separate act with its own authorization, its own race,
 * and — from S24 — its own socket event that everyone at the table watches
 * happen. A host who is auto-seated at seat 0 also cannot then choose seat 2,
 * because one identity may hold only one seat per table.
 *
 * **Nothing in here touches game state.** `GET /tables/:id` answers *who is
 * sitting where*; cards, turn order and legal moves belong to the socket, where
 * `projectState` runs once per viewer (02 §3.1).
 */

/**
 * A patch under construction.
 *
 * `Table`'s own fields are `readonly`, which is right for an entity handed
 * around the domain and wrong for an object assembled one field at a time from
 * an optional request body. Stripping the modifier here keeps the entity
 * immutable everywhere else.
 */
type TablePatch = { -readonly [K in keyof Table]?: Table[K] }

export interface TableServiceDeps {
  readonly repos: Repositories
  readonly catalog: GameCatalogService
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
  /**
   * S24, optional. Only `close` broadcasts from in here — every *seat* change
   * is announced by the socket handler that made it, which is the layer that
   * knows which socket to exclude and which system message to write.
   *
   * Closing is different because it is the one table transition that happens
   * over **REST** (`DELETE /tables/:id`), so nothing on the socket side would
   * otherwise notice. Without this, a host who closes a table from another tab
   * leaves everyone else looking at a lobby that no longer exists.
   */
  readonly realtime?: IRealtimePublisher
}

/** Who is asking, and what they may do beyond their own seat. */
export interface SeatActor {
  readonly identity: IdentityRef
  readonly isHost: boolean
}

export class TableService {
  private readonly now: () => Date

  constructor(private readonly deps: TableServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  // ── S18: lifecycle ────────────────────────────────────────────────────────

  async create(hostUserId: string, input: CreateTableRequest): Promise<TableDetail> {
    // Both throw before anything is written: an unplayable game or a seat count
    // the engine cannot seat is a 400, not a table nobody can use.
    const meta = this.deps.catalog.assertPlayable(input.gameSlug, input.seatCount)
    const options = this.deps.catalog.parseOptions(meta, input.options)

    const table = await this.deps.repos.tables.create({
      hostUserId,
      gameSlug: meta.slug,
      options,
      seatCount: input.seatCount,
      // A private table is reward-eligible by construction; the farming guard
      // (09 §7) is what flips this off, and it only inspects matchmade tables.
      origin: 'PRIVATE',
      rewardEligible: true,
      ...(input.allowSpectators === undefined ? {} : { allowSpectators: input.allowSpectators }),
      ...(input.requireApproval === undefined ? {} : { requireApproval: input.requireApproval }),
      // Written only when the host said something. A null column follows the
      // platform defaults as they move; a written one keeps what was chosen.
      ...(input.turnEnforcement === undefined
        ? {}
        : { turnEnforcement: withTurnEnforcementDefaults(input.turnEnforcement) }),
    })

    this.deps.metrics.increment('tables_created')
    this.deps.logger.info({ tableId: table.id, gameSlug: table.gameSlug }, 'table created')

    return this.view(table, [], { kind: 'user', userId: hostUserId })
  }

  /**
   * The "resume" list — 02 §5 level **U**, so guests never reach it. A guest
   * has exactly one table (its token names it) and no list to browse.
   *
   * One members read per table. The set is a single player's *open* tables, so
   * it is one or two rows in practice; a join would trade a real N+1 risk for a
   * repository method that only this screen would ever use.
   */
  async listMine(userId: string): Promise<TableSummary[]> {
    const tables = await this.deps.repos.tables.findOpenTablesForUser(userId)
    const viewer: IdentityRef = { kind: 'user', userId }

    return Promise.all(
      tables.map(async (table) =>
        toTableSummary(table, await this.deps.repos.tables.listMembers(table.id), viewer),
      ),
    )
  }

  /**
   * A table is readable by anyone who can name it: the id is a cuid and is
   * therefore the capability, exactly as the invite code is. A guest is
   * additionally pinned to its own table by `enforceGuestBinding` before this
   * is ever called (07 §3).
   */
  async detail(tableId: string, viewer: IdentityRef | null): Promise<TableDetail> {
    const table = await this.require(tableId)
    return this.view(table, await this.deps.repos.tables.listMembers(tableId), viewer)
  }

  async patch(
    tableId: string,
    input: PatchTableRequest,
    viewer: IdentityRef | null,
  ): Promise<TableDetail> {
    const table = await this.require(tableId)
    // Options and seat count describe the deal. Changing either mid-match would
    // rewrite the rules of a game already in progress (409, not 400 — the
    // request is well-formed, the table is simply past the point of accepting
    // it).
    this.assertWaiting(table)

    const patch: TablePatch = {}

    if (input.seatCount !== undefined) {
      this.deps.catalog.assertPlayable(table.gameSlug, input.seatCount)
      await this.assertNoOrphanedSeats(table, input.seatCount)
      patch.seatCount = input.seatCount
    }

    if (input.options !== undefined) {
      const meta = this.deps.catalog.assertPlayable(
        table.gameSlug,
        input.seatCount ?? table.seatCount,
      )
      patch.options = this.deps.catalog.parseOptions(meta, input.options)
    }

    if (input.allowSpectators !== undefined) patch.allowSpectators = input.allowSpectators
    if (input.requireApproval !== undefined) patch.requireApproval = input.requireApproval

    if (input.turnEnforcement !== undefined) {
      // Merged over the table's *current* setting rather than over the
      // defaults: a patch naming `ejectAfterStrikes` alone must not silently
      // reset a `warningSeconds` the host chose last week.
      patch.turnEnforcement = withTurnEnforcementDefaults(
        input.turnEnforcement,
        withTurnEnforcementDefaults(table.turnEnforcement),
      )
    }

    const updated = await this.deps.repos.tables.update(tableId, patch)
    return this.view(updated, await this.deps.repos.tables.listMembers(tableId), viewer)
  }

  /**
   * Closing is idempotent and never deletes.
   *
   * `closedAt` is a tombstone: the event log, the match results and the ledger
   * rows all reference this table, and a `DELETE` would either orphan them or
   * cascade away the history that pays people.
   */
  async close(tableId: string): Promise<void> {
    const table = await this.require(tableId)
    if (table.closedAt !== null) return

    await this.deps.repos.tables.update(tableId, {
      status: 'CLOSED',
      closedAt: this.now(),
    })

    this.deps.realtime?.publish(tableRoom(tableId), 'table:statusChanged', {
      tableId,
      status: 'CLOSED',
    })

    this.deps.metrics.increment('tables_closed')
    this.deps.logger.info({ tableId }, 'table closed')
  }

  // ── S20: seats ────────────────────────────────────────────────────────────

  /**
   * ★ The seat race, and the one method in this file where the *absence* of a
   * `SELECT` is the correctness argument.
   *
   * Two friends clicking seat 2 in the same millisecond is a real event, not a
   * theoretical one. There is no "is the seat free?" read here: the insert goes
   * in and the `(tableId, seat)` unique constraint decides, so the loser gets a
   * 409 rather than both winning and one silently overwriting the other
   * (03 §6.3). `tests/integration/seat-claim.test.ts` proves it with a
   * `Promise.all` of two claims.
   */
  async claimSeat(
    tableId: string,
    seat: number,
    occupant: OccupantRef,
    actor: SeatActor,
  ): Promise<TableDetail> {
    const table = await this.require(tableId)
    this.assertJoinable(table)

    if (!Number.isInteger(seat) || seat < 0 || seat >= table.seatCount) {
      throw new ValidationError(
        `seat ${seat} does not exist at a ${table.seatCount}-seat table`,
        { seat: ['errors.seatOutOfRange'] },
        { seatCount: table.seatCount },
      )
    }

    if (occupant.kind === 'bot' && !actor.isHost) {
      throw new ForbiddenError('Only the host may seat a bot', { reason: 'HOST_REQUIRED' })
    }

    /**
     * A leaked link's defence (03 §3.2). There is no pending-member state in
     * the schema yet, so approval is a refusal rather than a queue: the real
     * flow — the host is prompted over the socket and admits the caller —
     * arrives with the gateway in S24/S43.
     */
    if (table.requireApproval && !actor.isHost && occupant.kind !== 'bot') {
      throw new ForbiddenError('The host must approve joins at this table', {
        reason: 'APPROVAL_REQUIRED',
      })
    }

    const meta = this.deps.catalog.assertPlayable(table.gameSlug, table.seatCount)
    const team = meta.teams ? teamOf(seatId(seat), meta.teams.count) : null

    const member = await this.deps.repos.tables.claimSeat(tableId, seatId(seat), occupant, team)

    if (member === null) {
      // The constraint fired. Which of the three it was matters to the caller,
      // so name it: "that seat is taken" and "you are already sitting here"
      // are different problems with different buttons to press.
      const mine =
        occupant.kind === 'bot'
          ? null
          : await this.deps.repos.tables.findMemberByIdentity(tableId, occupant)

      if (mine !== null && mine.leftAt === null) {
        throw new SeatTakenError(seat, {
          reason: 'ALREADY_SEATED',
          ...(mine.seat === null ? {} : { yourSeat: mine.seat }),
        })
      }
      throw new SeatTakenError(seat, { reason: 'SEAT_OCCUPIED' })
    }

    this.deps.metrics.increment('seats_claimed')
    this.deps.logger.info({ tableId, seat, kind: occupant.kind }, 'seat claimed')

    return this.view(table, await this.deps.repos.tables.listMembers(tableId), actor.identity)
  }

  /**
   * Release behaves differently either side of the deal, and that difference is
   * the point (04 §5.2):
   *
   *   - **`WAITING`** — the row goes. Nothing has happened yet, so the seat is
   *     simply free again and someone else may take it.
   *   - **`IN_PROGRESS`** — the row stays and `disconnectedAt` is stamped. The
   *     seat belongs to the *match* now: it holds the player's cards, their
   *     chips and their reward eligibility, and the grace timer decides whether
   *     a bot takes over. Vacating it would delete a hand mid-play.
   */
  async releaseSeat(tableId: string, seat: number, actor: SeatActor): Promise<TableDetail> {
    const table = await this.require(tableId)
    const member = await this.deps.repos.tables.findMemberBySeat(tableId, seatId(seat))

    if (member === null || member.leftAt !== null) {
      throw new NotFoundError('Seat occupant', { tableId, seat })
    }

    // Your own seat, or the host removing someone. Anything else is one player
    // unseating another, which is a kick — and a kick is a host action.
    const isOwn = this.holds(member, actor.identity)
    if (!isOwn && !actor.isHost) {
      this.deps.security.record('SEAT_IMPERSONATION', {
        tableId,
        details: { reason: 'RELEASE_OTHER_SEAT', seat },
        ...identityFields(actor.identity),
      })
      throw new ForbiddenError('That is not your seat', { reason: 'NOT_YOUR_SEAT' })
    }

    if (table.status === 'IN_PROGRESS') {
      await this.deps.repos.tables.updateMember(member.id, { disconnectedAt: this.now() })
    } else {
      await this.deps.repos.tables.releaseSeat(tableId, seatId(seat))
    }

    this.deps.metrics.increment('seats_released')
    return this.view(table, await this.deps.repos.tables.listMembers(tableId), actor.identity)
  }

  /**
   * Spectators carry `seat: null`, which is also what lets any number of them
   * coexist: the `(tableId, seat)` unique constraint treats NULLs as distinct
   * on both SQLite and Postgres.
   */
  async joinAsSpectator(tableId: string, occupant: OccupantRef, viewer: IdentityRef | null) {
    const table = await this.require(tableId)
    this.assertJoinable(table)

    if (!table.allowSpectators) {
      throw new ForbiddenError('This table does not allow spectators', {
        reason: 'SPECTATORS_NOT_ALLOWED',
      })
    }

    try {
      await this.deps.repos.tables.addSpectator(tableId, occupant)
    } catch (error) {
      // `(tableId, userId)` is unique, so a second join — or a racing double
      // click — lands here. Already watching is the outcome the caller wanted,
      // so re-read and succeed rather than turning it into a 500.
      const existing =
        occupant.kind === 'bot'
          ? null
          : await this.deps.repos.tables.findMemberByIdentity(tableId, occupant)
      if (existing === null) throw error
    }

    return this.view(table, await this.deps.repos.tables.listMembers(tableId), viewer)
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Shared by the middleware (level **H**) and by every method above. */
  async require(tableId: string): Promise<Table> {
    const table = await this.deps.repos.tables.findById(tableId)
    if (table === null) throw new NotFoundError('Table', { tableId })
    return table
  }

  private assertWaiting(table: Table): void {
    if (table.status !== 'WAITING') {
      throw new IllegalPhaseTransitionError(table.status, 'WAITING', { tableId: table.id })
    }
  }

  private assertJoinable(table: Table): void {
    if (table.status === 'CLOSED' || table.status === 'FINISHED' || table.closedAt !== null) {
      throw new IllegalPhaseTransitionError(table.status, 'WAITING', { tableId: table.id })
    }
  }

  /** Shrinking a table must not evict someone who is already sitting down. */
  private async assertNoOrphanedSeats(table: Table, seatCount: number): Promise<void> {
    const occupied = activeMembers(await this.deps.repos.tables.listMembers(table.id))
      .map((member) => member.seat)
      .filter((seat): seat is SeatId => seat !== null)

    const highest = occupied.length === 0 ? -1 : Math.max(...occupied)
    if (highest >= seatCount) {
      throw new ValidationError(
        `seat ${highest} is occupied, so seatCount cannot drop to ${seatCount}`,
        { seatCount: ['errors.seatCountBelowOccupied'] },
        { occupiedSeats: occupied.slice().sort((a, b) => a - b) },
      )
    }
  }

  private holds(member: TableMember, identity: IdentityRef): boolean {
    return identity.kind === 'user'
      ? member.userId === identity.userId
      : member.guestSessionId === identity.guestSessionId
  }

  private async view(
    table: Table,
    members: readonly TableMember[],
    viewer: IdentityRef | null,
  ): Promise<TableDetail> {
    return toTableDetail(table, members, await this.directory(table, members), viewer)
  }

  /**
   * Resolves every display name the seat map needs in **two** reads, whatever
   * the seat count — one for users, one for guest sessions. The host is added
   * to the user batch even when they are not seated, because the detail
   * response names them.
   */
  async directory(
    table: Table | null,
    members: readonly TableMember[],
    /**
     * Ids that need a name but hold no member row.
     *
     * The case that forced this: a host who joins the lobby and has not sat
     * down yet is not a `TableMember` at all, so their chat lines rendered with
     * `displayName: null` — an unnamed message from the person who created the
     * table. Anyone who has *spoken* needs resolving, whether or not they are
     * sitting.
     */
    extra: { userIds?: readonly string[]; guestSessionIds?: readonly string[] } = {},
  ): Promise<OccupantDirectory> {
    const { userIds, guestSessionIds } = occupantIdsOf(members)
    if (table?.hostUserId != null && !userIds.includes(table.hostUserId)) {
      userIds.push(table.hostUserId)
    }
    for (const id of extra.userIds ?? []) if (!userIds.includes(id)) userIds.push(id)
    for (const id of extra.guestSessionIds ?? []) {
      if (!guestSessionIds.includes(id)) guestSessionIds.push(id)
    }

    const [users, guests] = await Promise.all([
      this.deps.repos.users.findManyByIds(userIds),
      this.deps.repos.guests.findManyByIds(guestSessionIds),
    ])

    return {
      users: new Map<string, OccupantProfile>(
        users.map((user) => [
          user.id,
          { displayName: user.displayName, avatarRef: user.avatarRef },
        ]),
      ),
      guests: new Map<string, OccupantProfile>(
        guests.map((guest) => [
          guest.id,
          { displayName: guest.displayName, avatarRef: guest.avatarRef },
        ]),
      ),
    }
  }
}

/** `SecurityEvent` columns for whichever kind of identity we have. */
function identityFields(identity: IdentityRef) {
  return identity.kind === 'user'
    ? { userId: identity.userId }
    : { guestSessionId: identity.guestSessionId }
}
