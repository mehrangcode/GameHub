import type {
  GuestSession,
  RefreshToken,
  SecurityEvent,
  User,
  UserPreferences,
} from '../../../domain/entities/user.js'
import type { PageQuery } from '../../../domain/repositories/IRepository.js'
import type {
  IGuestSessionRepository,
  IPreferencesRepository,
  IRefreshTokenRepository,
  ISecurityEventRepository,
  IUserRepository,
  NewGuestSession,
  NewRefreshToken,
  NewSecurityEvent,
  NewUser,
  SecurityEventFilter,
} from '../../../domain/repositories/identity.js'
import type { SecurityEventKind } from '../../../contracts/enums.js'
import { EmailTakenError } from '../../../domain/errors/errors.js'
import {
  toGuestSession,
  toJsonOrNull,
  toRefreshToken,
  toSecurityEvent,
  toUser,
  toUserPreferences,
} from '../mappers.js'
import { NEWEST_FIRST, PrismaRepositoryBase, cursorArgs } from './base.js'

export class PrismaUserRepository extends PrismaRepositoryBase implements IUserRepository {
  async create(data: NewUser): Promise<User> {
    const row = await this.nullOnConflict(() => this.db.user.create({ data }), 'email')
    if (row === null) throw new EmailTakenError()
    return toUser(row)
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { id } })
    return row ? toUser(row) : null
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { email } })
    return row ? toUser(row) : null
  }

  async findManyByIds(ids: readonly string[]): Promise<User[]> {
    if (ids.length === 0) return []
    const rows = await this.db.user.findMany({ where: { id: { in: [...ids] } } })
    return rows.map(toUser)
  }

  async update(id: string, data: Partial<User>): Promise<User> {
    return this.mapMissing(
      async () => toUser(await this.db.user.update({ where: { id }, data })),
      'User',
      id,
    )
  }

  async delete(id: string): Promise<void> {
    await this.mapMissing(() => this.db.user.delete({ where: { id } }), 'User', id)
  }

  async touchLastSeen(id: string, at: Date): Promise<void> {
    await this.mapMissing(
      () => this.db.user.update({ where: { id }, data: { lastSeenAt: at } }),
      'User',
      id,
    )
  }
}

export class PrismaGuestSessionRepository
  extends PrismaRepositoryBase
  implements IGuestSessionRepository
{
  async create(data: NewGuestSession): Promise<GuestSession> {
    const { prefs, ...rest } = data
    return toGuestSession(
      await this.db.guestSession.create({
        data: { ...rest, prefsJson: toJsonOrNull(prefs) },
      }),
    )
  }

  async findById(id: string): Promise<GuestSession | null> {
    const row = await this.db.guestSession.findUnique({ where: { id } })
    return row ? toGuestSession(row) : null
  }

  async findByTokenHash(tokenHash: string): Promise<GuestSession | null> {
    const row = await this.db.guestSession.findUnique({ where: { tokenHash } })
    return row ? toGuestSession(row) : null
  }

  async listByTable(tableId: string): Promise<GuestSession[]> {
    const rows = await this.db.guestSession.findMany({
      where: { tableId },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(toGuestSession)
  }

  async findManyByIds(ids: readonly string[]): Promise<GuestSession[]> {
    if (ids.length === 0) return []
    const rows = await this.db.guestSession.findMany({ where: { id: { in: [...ids] } } })
    return rows.map(toGuestSession)
  }

  async update(id: string, data: Partial<GuestSession>): Promise<GuestSession> {
    const { prefs, ...rest } = data
    return this.mapMissing(
      async () =>
        toGuestSession(
          await this.db.guestSession.update({
            where: { id },
            data: { ...rest, ...(prefs === undefined ? {} : { prefsJson: toJsonOrNull(prefs) }) },
          }),
        ),
      'GuestSession',
      id,
    )
  }

  async delete(id: string): Promise<void> {
    await this.mapMissing(() => this.db.guestSession.delete({ where: { id } }), 'GuestSession', id)
  }

  /**
   * ★ A conditional claim, not a read-then-write.
   *
   * `updateMany` with `claimedAt: null` in the predicate makes the database
   * decide who wins, exactly as `revokeIfActive` does for refresh rotation.
   * `count === 0` means the session was already claimed — by a concurrent
   * request, or by an earlier one whose token is being replayed — and the
   * caller's whole transaction must unwind.
   */
  async claimIfUnclaimed(id: string, userId: string, at: Date): Promise<GuestSession | null> {
    const { count } = await this.db.guestSession.updateMany({
      where: { id, claimedAt: null },
      data: { claimedAt: at, claimedByUserId: userId },
    })
    return count === 0 ? null : this.findById(id)
  }

  async deleteExpired(now: Date): Promise<number> {
    const { count } = await this.db.guestSession.deleteMany({ where: { expiresAt: { lte: now } } })
    return count
  }
}

export class PrismaRefreshTokenRepository
  extends PrismaRepositoryBase
  implements IRefreshTokenRepository
{
  async create(data: NewRefreshToken): Promise<RefreshToken> {
    return toRefreshToken(await this.db.refreshToken.create({ data }))
  }

  async findById(id: string): Promise<RefreshToken | null> {
    const row = await this.db.refreshToken.findUnique({ where: { id } })
    return row ? toRefreshToken(row) : null
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.db.refreshToken.findUnique({ where: { tokenHash } })
    return row ? toRefreshToken(row) : null
  }

  async listActiveByUser(userId: string, now: Date): Promise<RefreshToken[]> {
    const rows = await this.db.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { issuedAt: 'asc' },
    })
    return rows.map(toRefreshToken)
  }

  async update(id: string, data: Partial<RefreshToken>): Promise<RefreshToken> {
    return this.mapMissing(
      async () => toRefreshToken(await this.db.refreshToken.update({ where: { id }, data })),
      'RefreshToken',
      id,
    )
  }

  async delete(id: string): Promise<void> {
    await this.mapMissing(() => this.db.refreshToken.delete({ where: { id } }), 'RefreshToken', id)
  }

  async revoke(id: string, at: Date, replacedById?: string): Promise<RefreshToken> {
    return this.mapMissing(
      async () =>
        toRefreshToken(
          await this.db.refreshToken.update({
            where: { id },
            data: { revokedAt: at, ...(replacedById === undefined ? {} : { replacedById }) },
          }),
        ),
      'RefreshToken',
      id,
    )
  }

  async revokeIfActive(id: string, at: Date): Promise<boolean> {
    // `updateMany` with the guard in the WHERE clause is the whole point: the
    // database evaluates "still active" and writes in one statement, so two
    // concurrent rotations cannot both win.
    const { count } = await this.db.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    })
    return count === 1
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const { count } = await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
    })
    return count
  }

  async deleteExpired(now: Date): Promise<number> {
    const { count } = await this.db.refreshToken.deleteMany({ where: { expiresAt: { lte: now } } })
    return count
  }
}

export class PrismaPreferencesRepository
  extends PrismaRepositoryBase
  implements IPreferencesRepository
{
  async findByUser(userId: string): Promise<UserPreferences | null> {
    const row = await this.db.userPreferences.findUnique({ where: { userId } })
    return row ? toUserPreferences(row) : null
  }

  async upsert(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
    const { extra, userId: _ignored, updatedAt: _touched, ...rest } = patch
    const data = { ...rest, ...(extra === undefined ? {} : { extraJson: toJsonOrNull(extra) }) }
    return toUserPreferences(
      await this.db.userPreferences.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      }),
    )
  }
}

export class PrismaSecurityEventRepository
  extends PrismaRepositoryBase
  implements ISecurityEventRepository
{
  async record(event: NewSecurityEvent): Promise<SecurityEvent> {
    const { details, ...rest } = event
    return toSecurityEvent(
      await this.db.securityEvent.create({ data: { ...rest, detailsJson: toJsonOrNull(details) } }),
    )
  }

  async list(filter: SecurityEventFilter = {}, page: PageQuery = {}): Promise<SecurityEvent[]> {
    if (page.before !== undefined && !(await this.exists(page.before))) return []

    const rows = await this.db.securityEvent.findMany({
      where: {
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.userId === undefined ? {} : { userId: filter.userId }),
        ...(filter.since === undefined ? {} : { createdAt: { gte: filter.since } }),
      },
      orderBy: NEWEST_FIRST,
      take: page.limit ?? 25,
      ...cursorArgs(page.before),
    })
    return rows.map(toSecurityEvent)
  }

  async countSince(kind: SecurityEventKind, since: Date): Promise<number> {
    return this.db.securityEvent.count({ where: { kind, createdAt: { gte: since } } })
  }

  private async exists(id: string): Promise<boolean> {
    return (await this.db.securityEvent.count({ where: { id } })) > 0
  }
}
