import type { Repositories } from '../../../src/domain/repositories/Repositories.js'
import type { SeatId } from '../../../src/domain/value-objects/seat.js'

/**
 * Fixture builders for the contract suite.
 *
 * They go through the **repository interfaces**, never through a store or a
 * Prisma client, so the same code builds a graph under both harnesses. That
 * also means the fixtures respect foreign keys — which the in-memory fakes do
 * not enforce and the database absolutely does. Writing them this way is what
 * stops "passes in memory, fails on SQLite" from being a category of bug.
 */
let unique = 0
export const uniq = (prefix: string): string => `${prefix}-${Date.now()}-${unique++}`

export async function makeUser(repos: Repositories, overrides: { email?: string } = {}) {
  return repos.users.create({
    email: overrides.email ?? `${uniq('u')}@test.dev`,
    passwordHash: 'argon2id$fixture',
    displayName: 'Tester',
  })
}

export async function makeTable(
  repos: Repositories,
  overrides: { hostUserId?: string | null; seatCount?: number } = {},
) {
  return repos.tables.create({
    gameSlug: 'fixture',
    options: {},
    seatCount: overrides.seatCount ?? 4,
    ...(overrides.hostUserId === undefined ? {} : { hostUserId: overrides.hostUserId }),
  })
}

export async function makeGuest(
  repos: Repositories,
  tableId: string,
  overrides: { tokenHash?: string; expiresAt?: Date } = {},
) {
  return repos.guests.create({
    tokenHash: overrides.tokenHash ?? uniq('hash'),
    displayName: 'Guest',
    tableId,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1000),
  })
}

export async function makeGame(repos: Repositories, tableId: string) {
  return repos.games.create({
    tableId,
    gameSlug: 'fixture',
    rngSeed: 'seed-1',
    seedCommit: 'commit-1',
    seating: [],
    options: {},
  })
}

export async function makeInvite(
  repos: Repositories,
  tableId: string,
  createdByUserId: string,
  overrides: { code?: string; expiresAt?: Date; maxUses?: number | null } = {},
) {
  return repos.invites.create({
    tableId,
    code: overrides.code ?? uniq('code'),
    createdByUserId,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    ...(overrides.maxUses === undefined ? {} : { maxUses: overrides.maxUses }),
  })
}

export const seat = (n: number): SeatId => n as SeatId
