import type {
  ChatMessage,
  Invite,
  Table,
  TableMember,
  TableWithMembers,
} from '../../src/domain/entities/table.js'
import type {
  IChatRepository,
  IInviteRepository,
  ITableRepository,
  NewChatMessage,
  NewInvite,
  NewTable,
} from '../../src/domain/repositories/tables.js'
import type { PageQuery } from '../../src/domain/repositories/IRepository.js'
import type { IdentityRef, OccupantRef } from '../../src/domain/value-objects/identity.js'
import type { SeatId } from '../../src/domain/value-objects/seat.js'
import { Collection, cloneAll, nextId, paginate } from './store.js'

function occupantFields(
  occupant: OccupantRef,
): Pick<TableMember, 'userId' | 'guestSessionId' | 'isBot' | 'botDifficulty'> {
  switch (occupant.kind) {
    case 'user':
      return { userId: occupant.userId, guestSessionId: null, isBot: false, botDifficulty: null }
    case 'guest':
      return {
        userId: null,
        guestSessionId: occupant.guestSessionId,
        isBot: false,
        botDifficulty: null,
      }
    case 'bot':
      return { userId: null, guestSessionId: null, isBot: true, botDifficulty: occupant.difficulty }
  }
}

export class InMemoryTableRepository implements ITableRepository {
  readonly rows = new Collection<Table>('Table')
  readonly members = new Collection<TableMember>('TableMember')

  /** Set by the harness so `findByInviteCode` can resolve codes. */
  invites?: InMemoryInviteRepository

  async create(data: NewTable): Promise<Table> {
    const now = new Date()
    return this.rows.insert({
      id: nextId('tbl'),
      hostUserId: null,
      status: 'WAITING',
      origin: 'PRIVATE',
      presetId: null,
      rewardEligible: true,
      allowSpectators: true,
      requireApproval: false,
      startedAt: null,
      closedAt: null,
      ...data,
      createdAt: now,
      updatedAt: now,
    })
  }

  async findById(id: string): Promise<Table | null> {
    return this.rows.get(id)
  }

  async update(id: string, data: Partial<Table>): Promise<Table> {
    return this.rows.patch(id, { ...data, updatedAt: new Date() })
  }

  async delete(id: string): Promise<void> {
    this.rows.remove(id)
    for (const member of this.members.filter((m) => m.tableId === id)) {
      this.members.remove(member.id)
    }
  }

  async findByInviteCode(code: string, now = new Date()): Promise<Table | null> {
    const invite = await this.invites?.findValidByCode(code, now)
    return invite ? this.rows.get(invite.tableId) : null
  }

  async findWithMembers(id: string): Promise<TableWithMembers | null> {
    const table = this.rows.get(id)
    if (!table) return null
    return { ...table, members: await this.listMembers(id) }
  }

  async findOpenTablesForUser(userId: string): Promise<Table[]> {
    const open = new Set(['WAITING', 'IN_PROGRESS'])
    const joined = new Set(
      this.members
        .all()
        .filter((m) => m.userId === userId && m.leftAt === null)
        .map((m) => m.tableId),
    )
    return this.rows.filter(
      (t) => open.has(t.status) && (t.hostUserId === userId || joined.has(t.id)),
    )
  }

  /**
   * Simulates the `(tableId, seat)` unique constraint. Returning `null` rather
   * than throwing is the contract: losing a seat race is an ordinary outcome
   * that the caller turns into a `SeatTakenError`, not an exception path.
   */
  async claimSeat(
    tableId: string,
    seat: SeatId,
    occupant: OccupantRef,
    team: number | null = null,
  ): Promise<TableMember | null> {
    const taken = this.members.all().some((m) => m.tableId === tableId && m.seat === seat)
    if (taken) return null

    const fields = occupantFields(occupant)
    // The other two unique constraints: one identity cannot hold two seats.
    const duplicateIdentity = this.members
      .all()
      .some(
        (m) =>
          m.tableId === tableId &&
          ((fields.userId !== null && m.userId === fields.userId) ||
            (fields.guestSessionId !== null && m.guestSessionId === fields.guestSessionId)),
      )
    if (duplicateIdentity) return null

    return this.members.insert({
      id: nextId('mem'),
      tableId,
      seat,
      role: 'PLAYER',
      team,
      joinedAt: new Date(),
      leftAt: null,
      disconnectedAt: null,
      timeoutStrikes: 0,
      ejectedAt: null,
      ejectionReason: null,
      reclaimableUntil: null,
      botSubstituted: false,
      ...fields,
    })
  }

  async releaseSeat(tableId: string, seat: SeatId): Promise<void> {
    const member = this.members.all().find((m) => m.tableId === tableId && m.seat === seat)
    if (member) this.members.remove(member.id)
  }

  async addSpectator(tableId: string, occupant: OccupantRef): Promise<TableMember> {
    const fields = occupantFields(occupant)
    // `(tableId, userId)` and `(tableId, guestSessionId)` are unique, so one
    // identity cannot spectate twice or spectate while seated. Bots are exempt:
    // both columns are NULL and NULLs stay distinct on SQLite and Postgres.
    const duplicate = this.members
      .all()
      .some(
        (m) =>
          m.tableId === tableId &&
          ((fields.userId !== null && m.userId === fields.userId) ||
            (fields.guestSessionId !== null && m.guestSessionId === fields.guestSessionId)),
      )
    if (duplicate) throw new Error('unique constraint failed: TableMember identity')

    return this.members.insert({
      id: nextId('mem'),
      tableId,
      seat: null,
      role: 'SPECTATOR',
      team: null,
      joinedAt: new Date(),
      leftAt: null,
      disconnectedAt: null,
      timeoutStrikes: 0,
      ejectedAt: null,
      ejectionReason: null,
      reclaimableUntil: null,
      botSubstituted: false,
      ...fields,
    })
  }

  async listMembers(tableId: string): Promise<TableMember[]> {
    return cloneAll(
      this.members
        .all()
        .filter((m) => m.tableId === tableId)
        .sort((a, b) => (a.seat ?? Number.MAX_SAFE_INTEGER) - (b.seat ?? Number.MAX_SAFE_INTEGER)),
    )
  }

  async findMemberBySeat(tableId: string, seat: SeatId): Promise<TableMember | null> {
    return this.members.find((m) => m.tableId === tableId && m.seat === seat)
  }

  async findMemberByIdentity(tableId: string, identity: IdentityRef): Promise<TableMember | null> {
    return this.members.find((m) =>
      identity.kind === 'user'
        ? m.tableId === tableId && m.userId === identity.userId
        : m.tableId === tableId && m.guestSessionId === identity.guestSessionId,
    )
  }

  async updateMember(memberId: string, data: Partial<TableMember>): Promise<TableMember> {
    return this.members.patch(memberId, data)
  }

  async countActiveMembers(tableId: string): Promise<number> {
    return this.members.all().filter((m) => m.tableId === tableId && m.leftAt === null).length
  }

  async transferSeat(guestSessionId: string, userId: string): Promise<TableMember | null> {
    const member = this.members.all().find((m) => m.guestSessionId === guestSessionId)
    if (!member) return null
    return this.members.patch(member.id, { userId, guestSessionId: null })
  }
}

export class InMemoryInviteRepository implements IInviteRepository {
  readonly rows = new Collection<Invite>('Invite')

  async create(data: NewInvite): Promise<Invite> {
    if (this.rows.find((i) => i.code === data.code)) {
      throw new Error(`unique constraint failed: Invite.code = ${data.code}`)
    }
    return this.rows.insert({
      id: nextId('inv'),
      maxUses: null,
      useCount: 0,
      revokedAt: null,
      ...data,
      createdAt: new Date(),
    })
  }

  async findById(id: string): Promise<Invite | null> {
    return this.rows.get(id)
  }

  async findByCode(code: string): Promise<Invite | null> {
    return this.rows.find((i) => i.code === code)
  }

  async findValidByCode(code: string, now = new Date()): Promise<Invite | null> {
    return this.rows.find(
      (i) =>
        i.code === code &&
        i.revokedAt === null &&
        i.expiresAt.getTime() > now.getTime() &&
        (i.maxUses === null || i.useCount < i.maxUses),
    )
  }

  async listByTable(tableId: string): Promise<Invite[]> {
    return this.rows.filter((i) => i.tableId === tableId)
  }

  async update(id: string, data: Partial<Invite>): Promise<Invite> {
    return this.rows.patch(id, data)
  }

  async delete(id: string): Promise<void> {
    this.rows.remove(id)
  }

  async revoke(id: string, at: Date): Promise<Invite> {
    return this.rows.patch(id, { revokedAt: at })
  }

  async consumeUse(id: string): Promise<Invite | null> {
    const invite = this.rows.require(id)
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return null
    return this.rows.patch(id, { useCount: invite.useCount + 1 })
  }
}

export class InMemoryChatRepository implements IChatRepository {
  readonly rows = new Collection<ChatMessage>('ChatMessage')

  async append(message: NewChatMessage): Promise<ChatMessage> {
    return this.rows.insert({
      id: nextId('msg'),
      userId: null,
      guestSessionId: null,
      kind: 'TEXT',
      params: null,
      redactedAt: null,
      ...message,
      createdAt: new Date(),
    })
  }

  async findById(id: string): Promise<ChatMessage | null> {
    return this.rows.get(id)
  }

  async listByTable(tableId: string, page: PageQuery = {}): Promise<ChatMessage[]> {
    return paginate(
      this.rows.all().filter((m) => m.tableId === tableId),
      page,
    )
  }

  async redact(id: string, at: Date): Promise<ChatMessage> {
    return this.rows.patch(id, { redactedAt: at })
  }
}
