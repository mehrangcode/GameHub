import type {
  GuestSession,
  RefreshToken,
  SecurityEvent,
  User,
  UserPreferences,
} from '../../src/domain/entities/user.js'
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
} from '../../src/domain/repositories/identity.js'
import type { PageQuery } from '../../src/domain/repositories/IRepository.js'
import { EmailTakenError } from '../../src/domain/errors/errors.js'
import { Collection, clone, nextId, paginate } from './store.js'

export class InMemoryUserRepository implements IUserRepository {
  readonly rows = new Collection<User>('User')

  async create(data: NewUser): Promise<User> {
    // Same domain error the Prisma repository raises from the real unique
    // constraint — the contract suite asserts both, so the fake cannot drift.
    if (this.rows.find((u) => u.email === data.email)) throw new EmailTakenError()
    const now = new Date()
    return this.rows.insert({
      id: nextId('usr'),
      avatarKind: 'preset',
      avatarRef: null,
      locale: 'en',
      role: 'USER',
      status: 'ACTIVE',
      statusReason: null,
      statusChangedAt: null,
      statusChangedBy: null,
      emailVerified: false,
      lastSeenAt: null,
      ...data,
      createdAt: now,
      updatedAt: now,
    })
  }

  async findById(id: string): Promise<User | null> {
    return this.rows.get(id)
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.rows.find((u) => u.email === email)
  }

  async update(id: string, data: Partial<User>): Promise<User> {
    return this.rows.patch(id, { ...data, updatedAt: new Date() })
  }

  async delete(id: string): Promise<void> {
    this.rows.remove(id)
  }

  async touchLastSeen(id: string, at: Date): Promise<void> {
    this.rows.patch(id, { lastSeenAt: at })
  }
}

export class InMemoryGuestSessionRepository implements IGuestSessionRepository {
  readonly rows = new Collection<GuestSession>('GuestSession')

  async create(data: NewGuestSession): Promise<GuestSession> {
    if (this.rows.find((g) => g.tokenHash === data.tokenHash)) {
      throw new Error('unique constraint failed: GuestSession.tokenHash')
    }
    return this.rows.insert({
      id: nextId('gst'),
      avatarRef: null,
      prefs: null,
      locale: 'en',
      lastSeenAt: null,
      claimedAt: null,
      claimedByUserId: null,
      ...data,
      createdAt: new Date(),
    })
  }

  async findById(id: string): Promise<GuestSession | null> {
    return this.rows.get(id)
  }

  async findByTokenHash(tokenHash: string): Promise<GuestSession | null> {
    return this.rows.find((g) => g.tokenHash === tokenHash)
  }

  async listByTable(tableId: string): Promise<GuestSession[]> {
    return this.rows.filter((g) => g.tableId === tableId)
  }

  async update(id: string, data: Partial<GuestSession>): Promise<GuestSession> {
    return this.rows.patch(id, data)
  }

  async delete(id: string): Promise<void> {
    this.rows.remove(id)
  }

  async markClaimed(id: string, userId: string, at: Date): Promise<GuestSession> {
    return this.rows.patch(id, { claimedAt: at, claimedByUserId: userId })
  }

  async deleteExpired(now: Date): Promise<number> {
    const stale = this.rows.filter((g) => g.expiresAt.getTime() <= now.getTime())
    for (const row of stale) this.rows.remove(row.id)
    return stale.length
  }
}

export class InMemoryRefreshTokenRepository implements IRefreshTokenRepository {
  readonly rows = new Collection<RefreshToken>('RefreshToken')

  async create(data: NewRefreshToken): Promise<RefreshToken> {
    if (this.rows.find((t) => t.tokenHash === data.tokenHash)) {
      throw new Error('unique constraint failed: RefreshToken.tokenHash')
    }
    return this.rows.insert({
      id: nextId('rft'),
      issuedAt: new Date(),
      revokedAt: null,
      replacedById: null,
      userAgent: null,
      ip: null,
      ...data,
    })
  }

  async findById(id: string): Promise<RefreshToken | null> {
    return this.rows.get(id)
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.rows.find((t) => t.tokenHash === tokenHash)
  }

  async listActiveByUser(userId: string, now: Date): Promise<RefreshToken[]> {
    return this.rows.filter(
      (t) => t.userId === userId && t.revokedAt === null && t.expiresAt.getTime() > now.getTime(),
    )
  }

  async update(id: string, data: Partial<RefreshToken>): Promise<RefreshToken> {
    return this.rows.patch(id, data)
  }

  async delete(id: string): Promise<void> {
    this.rows.remove(id)
  }

  async revoke(id: string, at: Date, replacedById?: string): Promise<RefreshToken> {
    return this.rows.patch(id, {
      revokedAt: at,
      ...(replacedById === undefined ? {} : { replacedById }),
    })
  }

  async revokeIfActive(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.revokedAt !== null) return false
    this.rows.patch(id, { revokedAt: at })
    return true
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const live = this.rows.filter((t) => t.familyId === familyId && t.revokedAt === null)
    for (const token of live) this.rows.patch(token.id, { revokedAt: at })
    return live.length
  }

  async deleteExpired(now: Date): Promise<number> {
    const stale = this.rows.filter((t) => t.expiresAt.getTime() <= now.getTime())
    for (const token of stale) this.rows.remove(token.id)
    return stale.length
  }
}

export class InMemoryPreferencesRepository implements IPreferencesRepository {
  readonly rows = new Map<string, UserPreferences>()

  async findByUser(userId: string): Promise<UserPreferences | null> {
    const row = this.rows.get(userId)
    return row ? clone(row) : null
  }

  async upsert(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
    const existing = this.rows.get(userId)
    const base: UserPreferences = existing ?? {
      userId,
      theme: 'system',
      locale: 'en',
      numeralSystem: 'auto',
      cardBackId: null,
      cardFaceId: null,
      feltId: null,
      animationSpeed: 'normal',
      soundEnabled: true,
      soundVolume: 70,
      showLegalMoveHints: true,
      reducedMotion: false,
      extra: null,
      updatedAt: new Date(),
    }
    const next = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value
    }
    next.updatedAt = new Date()
    this.rows.set(userId, next)
    return clone(next)
  }

  clear(): void {
    this.rows.clear()
  }
}

export class InMemorySecurityEventRepository implements ISecurityEventRepository {
  readonly rows = new Collection<SecurityEvent>('SecurityEvent')

  async record(event: NewSecurityEvent): Promise<SecurityEvent> {
    return this.rows.insert({
      id: nextId('sec'),
      severity: 'INFO',
      userId: null,
      guestSessionId: null,
      tableId: null,
      gameId: null,
      ip: null,
      userAgent: null,
      details: null,
      ...event,
      createdAt: new Date(),
    })
  }

  async list(filter: SecurityEventFilter = {}, page: PageQuery = {}): Promise<SecurityEvent[]> {
    const matching = this.rows.all().filter((e) => {
      if (filter.kind !== undefined && e.kind !== filter.kind) return false
      if (filter.userId !== undefined && e.userId !== filter.userId) return false
      if (filter.since !== undefined && e.createdAt.getTime() < filter.since.getTime()) return false
      return true
    })
    return paginate(matching, page)
  }

  async countSince(kind: SecurityEvent['kind'], since: Date): Promise<number> {
    return this.rows.all().filter((e) => e.kind === kind && e.createdAt >= since).length
  }
}
