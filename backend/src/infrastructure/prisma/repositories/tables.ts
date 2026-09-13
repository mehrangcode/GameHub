import type {
  ChatMessage,
  Invite,
  Table,
  TableMember,
  TableWithMembers,
} from '../../../domain/entities/table.js'
import type { PageQuery } from '../../../domain/repositories/IRepository.js'
import type {
  IChatRepository,
  IInviteRepository,
  ITableRepository,
  NewChatMessage,
  NewInvite,
  NewTable,
} from '../../../domain/repositories/tables.js'
import type { IdentityRef, OccupantRef } from '../../../domain/value-objects/identity.js'
import type { SeatId } from '../../../domain/value-objects/seat.js'
import {
  toChatMessage,
  toInvite,
  toJson,
  toJsonOrNull,
  toTable,
  toTableMember,
} from '../mappers.js'
import { NEWEST_FIRST, PrismaRepositoryBase, cursorArgs } from './base.js'

function occupantFields(occupant: OccupantRef) {
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

function identityWhere(tableId: string, identity: IdentityRef) {
  return identity.kind === 'user'
    ? { tableId, userId: identity.userId }
    : { tableId, guestSessionId: identity.guestSessionId }
}

export class PrismaTableRepository extends PrismaRepositoryBase implements ITableRepository {
  async create(data: NewTable): Promise<Table> {
    const { options, turnEnforcement, ...rest } = data
    return toTable(
      await this.db.table.create({
        data: {
          ...rest,
          optionsJson: toJson(options),
          turnEnforcementJson: toJsonOrNull(turnEnforcement),
        },
      }),
    )
  }

  async findById(id: string): Promise<Table | null> {
    const row = await this.db.table.findUnique({ where: { id } })
    return row ? toTable(row) : null
  }

  async update(id: string, data: Partial<Table>): Promise<Table> {
    const { options, turnEnforcement, ...rest } = data
    return this.mapMissing(
      async () =>
        toTable(
          await this.db.table.update({
            where: { id },
            data: {
              ...rest,
              ...(options === undefined ? {} : { optionsJson: toJson(options) }),
              ...(turnEnforcement === undefined
                ? {}
                : { turnEnforcementJson: toJsonOrNull(turnEnforcement) }),
            },
          }),
        ),
      'Table',
      id,
    )
  }

  async delete(id: string): Promise<void> {
    await this.mapMissing(() => this.db.table.delete({ where: { id } }), 'Table', id)
  }

  async findByInviteCode(code: string, now = new Date()): Promise<Table | null> {
    const row = await this.db.table.findFirst({
      where: { invites: { some: { code, revokedAt: null, expiresAt: { gt: now } } } },
    })
    return row ? toTable(row) : null
  }

  async findWithMembers(id: string): Promise<TableWithMembers | null> {
    const table = await this.findById(id)
    return table ? { ...table, members: await this.listMembers(id) } : null
  }

  async findOpenTablesForUser(userId: string): Promise<Table[]> {
    const rows = await this.db.table.findMany({
      where: {
        status: { in: ['WAITING', 'IN_PROGRESS'] },
        OR: [{ hostUserId: userId }, { members: { some: { userId, leftAt: null } } }],
      },
      orderBy: { updatedAt: 'desc' },
    })
    return rows.map(toTable)
  }

  /**
   * ★ Insert and let the database arbitrate (03 §6.3).
   *
   * No `SELECT` first: a check-then-insert has a window between the check and
   * the insert, and two friends clicking seat 2 land in it. The unique
   * constraints on `(tableId, seat)`, `(tableId, userId)` and
   * `(tableId, guestSessionId)` close all three races at once, and a P2002
   * simply means "someone else got there".
   */
  async claimSeat(
    tableId: string,
    seat: SeatId,
    occupant: OccupantRef,
    team: number | null = null,
  ): Promise<TableMember | null> {
    const row = await this.nullOnConflict(() =>
      this.db.tableMember.create({
        data: { tableId, seat, team, role: 'PLAYER', ...occupantFields(occupant) },
      }),
    )
    return row ? toTableMember(row) : null
  }

  async releaseSeat(tableId: string, seat: SeatId): Promise<void> {
    await this.db.tableMember.deleteMany({ where: { tableId, seat } })
  }

  async addSpectator(tableId: string, occupant: OccupantRef): Promise<TableMember> {
    return toTableMember(
      await this.db.tableMember.create({
        data: { tableId, seat: null, role: 'SPECTATOR', ...occupantFields(occupant) },
      }),
    )
  }

  async listMembers(tableId: string): Promise<TableMember[]> {
    const rows = await this.db.tableMember.findMany({
      where: { tableId },
      orderBy: [{ seat: 'asc' }, { joinedAt: 'asc' }],
    })
    return rows.map(toTableMember)
  }

  async findMemberBySeat(tableId: string, seat: SeatId): Promise<TableMember | null> {
    const row = await this.db.tableMember.findFirst({ where: { tableId, seat } })
    return row ? toTableMember(row) : null
  }

  async findMemberByIdentity(tableId: string, identity: IdentityRef): Promise<TableMember | null> {
    const row = await this.db.tableMember.findFirst({ where: identityWhere(tableId, identity) })
    return row ? toTableMember(row) : null
  }

  async updateMember(memberId: string, data: Partial<TableMember>): Promise<TableMember> {
    return this.mapMissing(
      async () =>
        toTableMember(await this.db.tableMember.update({ where: { id: memberId }, data })),
      'TableMember',
      memberId,
    )
  }

  async countActiveMembers(tableId: string): Promise<number> {
    return this.db.tableMember.count({ where: { tableId, leftAt: null } })
  }

  async transferSeat(guestSessionId: string, userId: string): Promise<TableMember | null> {
    const member = await this.db.tableMember.findFirst({ where: { guestSessionId } })
    if (!member) return null

    return toTableMember(
      await this.db.tableMember.update({
        where: { id: member.id },
        data: { userId, guestSessionId: null },
      }),
    )
  }
}

export class PrismaInviteRepository extends PrismaRepositoryBase implements IInviteRepository {
  async create(data: NewInvite): Promise<Invite> {
    return toInvite(await this.db.invite.create({ data }))
  }

  async findById(id: string): Promise<Invite | null> {
    const row = await this.db.invite.findUnique({ where: { id } })
    return row ? toInvite(row) : null
  }

  async findByCode(code: string): Promise<Invite | null> {
    const row = await this.db.invite.findUnique({ where: { code } })
    return row ? toInvite(row) : null
  }

  async findValidByCode(code: string, now = new Date()): Promise<Invite | null> {
    const row = await this.db.invite.findFirst({
      where: { code, revokedAt: null, expiresAt: { gt: now } },
    })
    // `useCount < maxUses` cannot be expressed as a column comparison on the
    // SQLite ∩ Postgres intersection Prisma exposes, so it is checked here.
    if (!row || (row.maxUses !== null && row.useCount >= row.maxUses)) return null
    return toInvite(row)
  }

  async listByTable(tableId: string): Promise<Invite[]> {
    const rows = await this.db.invite.findMany({
      where: { tableId },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(toInvite)
  }

  async update(id: string, data: Partial<Invite>): Promise<Invite> {
    return this.mapMissing(
      async () => toInvite(await this.db.invite.update({ where: { id }, data })),
      'Invite',
      id,
    )
  }

  async delete(id: string): Promise<void> {
    await this.mapMissing(() => this.db.invite.delete({ where: { id } }), 'Invite', id)
  }

  async revoke(id: string, at: Date): Promise<Invite> {
    return this.mapMissing(
      async () => toInvite(await this.db.invite.update({ where: { id }, data: { revokedAt: at } })),
      'Invite',
      id,
    )
  }

  /**
   * Consumes one use under a conditional `updateMany`, so two people redeeming
   * the last slot of a link cannot both win: the second update matches no rows.
   */
  async consumeUse(id: string): Promise<Invite | null> {
    const invite = await this.db.invite.findUnique({ where: { id } })
    if (!invite) return null
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return null

    const { count } = await this.db.invite.updateMany({
      where: { id, useCount: invite.useCount },
      data: { useCount: invite.useCount + 1 },
    })
    return count === 0 ? null : this.findById(id)
  }
}

export class PrismaChatRepository extends PrismaRepositoryBase implements IChatRepository {
  async append(message: NewChatMessage): Promise<ChatMessage> {
    const { params, ...rest } = message
    return toChatMessage(
      await this.db.chatMessage.create({ data: { ...rest, paramsJson: toJsonOrNull(params) } }),
    )
  }

  async findById(id: string): Promise<ChatMessage | null> {
    const row = await this.db.chatMessage.findUnique({ where: { id } })
    return row ? toChatMessage(row) : null
  }

  async listByTable(tableId: string, page: PageQuery = {}): Promise<ChatMessage[]> {
    if (
      page.before !== undefined &&
      (await this.db.chatMessage.count({ where: { id: page.before } })) === 0
    ) {
      return []
    }
    const rows = await this.db.chatMessage.findMany({
      where: { tableId },
      orderBy: NEWEST_FIRST,
      take: page.limit ?? 25,
      ...cursorArgs(page.before),
    })
    return rows.map(toChatMessage)
  }

  async redact(id: string, at: Date): Promise<ChatMessage> {
    return this.mapMissing(
      async () =>
        toChatMessage(
          await this.db.chatMessage.update({ where: { id }, data: { redactedAt: at } }),
        ),
      'ChatMessage',
      id,
    )
  }

  async reattributeActor(guestSessionId: string, userId: string): Promise<number> {
    const { count } = await this.db.chatMessage.updateMany({
      where: { guestSessionId },
      data: { userId, guestSessionId: null },
    })
    return count
  }
}
