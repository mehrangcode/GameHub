import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_COOKIES } from '../../../src/contracts/dto/auth.js'
import { PrismaWalletRepository } from '../../../src/infrastructure/prisma/repositories/economy.js'
import { PrismaGameEventRepository } from '../../../src/infrastructure/prisma/repositories/games.js'
import { buildTestApp } from '../../helpers/app.js'
import { db, resetDb } from '../../helpers/db.js'

/**
 * ★ S22 — the guest→user claim, journey J2. 03-data-model.md §6.1.
 *
 * The whole session, stated as one sentence: *a friend who has been playing for
 * forty minutes signs up, and from the other four players' point of view
 * nothing happens except a name badge losing its "guest" marker.*
 *
 * So the assertions that matter here are about **identity, not equality**: the
 * `TableMember` row must keep its own `id`, `seat`, `team` and `joinedAt`. A
 * test that only checked "the new user is seated at seat 2" would pass against
 * a delete-and-reinsert implementation, which is the exact bug — it flashes an
 * empty seat across four screens mid-trick and, once S24 lands, emits a
 * `table:seatVacated` nobody should ever see.
 *
 * The four failure modes 03 §6.1 names explicitly each get a test, and each
 * asserts on what is *absent* afterwards.
 */

const { app, container, resetLimits } = buildTestApp()

const GLOBAL_CAPS = {
  gameSlug: null,
  assetCode: 'COIN',
  baseAmount: 0,
  placementJson: JSON.stringify({ draw: 1, bySeatCount: {} }),
  expectedMinMs: 0,
  repeatDecayJson: JSON.stringify([1, 1, 0.6, 0.3, 0.1]),
  capPerHour: 400,
  capPerDay: 2_000,
  capPerDayGuest: 500,
  capMatchesPerDay: 30,
  guestVestCap: 500,
  active: true,
}

let tableId: string
let hostId: string

const cookieOf = (res: request.Response, name: string): string => {
  const headers = (res.headers['set-cookie'] ?? []) as unknown as string[]
  return (headers.find((h) => h.startsWith(`${name}=`)) ?? '').split(';')[0] ?? ''
}

/** Joins as a guest and returns the cookie plus the session row. */
async function joinAsGuest(displayName = 'Sara') {
  const res = await request(app)
    .post('/api/v1/auth/guest')
    .send({ inviteCode: 'GOODCODE', displayName })
  expect(res.status).toBe(201)

  const session = await db.guestSession.findFirstOrThrow({
    where: { displayName },
    orderBy: { createdAt: 'desc' },
  })
  return { cookie: cookieOf(res, AUTH_COOKIES.guest), session }
}

/** Seats the guest, so the claim has a seat to preserve. */
async function seatGuest(guestSessionId: string, seat = 2, team: number | null = 1) {
  return db.tableMember.create({
    data: {
      tableId,
      guestSessionId,
      seat,
      team,
      role: 'PLAYER',
      joinedAt: new Date('2026-09-09T18:00:00.000Z'),
    },
  })
}

/** Grants provisional coins the way S36 will: through the ledger. */
async function grantProvisional(guestSessionId: string, amount: number) {
  await container.wallets.credit({
    holder: { kind: 'guest', guestSessionId },
    asset: 'COIN',
    amount,
    kind: 'MATCH_REWARD',
    idempotencyKey: `match:seed-${guestSessionId}:0`,
  })
}

const claim = (cookie: string, body: Record<string, unknown>) =>
  request(app).post('/api/v1/auth/guest/claim').set('Cookie', cookie).send(body)

const credentials = {
  email: 'sara@test.dev',
  password: 'correct-horse-battery',
}

beforeEach(async () => {
  await resetDb()
  resetLimits()

  await db.rewardRule.upsert({
    where: { id: '_global' },
    create: { id: '_global', ...GLOBAL_CAPS },
    update: GLOBAL_CAPS,
  })
  await db.cosmeticItem.create({
    data: {
      id: 'back-default',
      category: 'CARD_BACK',
      nameKey: 'cosmetics.back.default',
      assetRef: 'backs/default.svg',
      unlockKind: 'DEFAULT',
    },
  })

  const host = await db.user.create({
    data: { email: 'host@test.dev', passwordHash: 'x', displayName: 'TheHost' },
  })
  hostId = host.id
  const table = await db.table.create({
    data: { hostUserId: host.id, gameSlug: 'fixture', optionsJson: '{}', seatCount: 4 },
  })
  tableId = table.id

  await db.invite.create({
    data: {
      tableId: table.id,
      code: 'GOODCODE',
      createdByUserId: host.id,
      maxUses: 20,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
})

describe('POST /auth/guest/claim — the happy path', () => {
  it('★ the seat keeps its identity: same id, seat, team and joinedAt', async () => {
    const { cookie, session } = await joinAsGuest()
    const before = await seatGuest(session.id)

    const res = await claim(cookie, credentials)
    expect(res.status).toBe(201)

    const after = await db.tableMember.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.id).toBe(before.id)
    expect(after.seat).toBe(before.seat)
    expect(after.team).toBe(before.team)
    expect(after.joinedAt.toISOString()).toBe(before.joinedAt.toISOString())
    // The transfer itself: the row now belongs to the account.
    expect(after.userId).toBe(res.body.identity.userId)
    expect(after.guestSessionId).toBeNull()
    // And nothing was recreated — there is still exactly one member row.
    expect(await db.tableMember.count({ where: { tableId } })).toBe(1)
    expect(res.body.seatPreserved).toBe(true)
  })

  it('★ redirectTo comes from the server, naming the table the seat is on', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)

    const res = await claim(cookie, credentials)
    // Decided by the same transaction that preserved the seat, so the client
    // cannot drift to the wrong table (06 §3.1).
    expect(res.body.redirectTo).toBe(`/table/${tableId}`)
  })

  it('★ provisional 120 becomes vested 120, with a balanced mirror row', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)
    await grantProvisional(session.id, 120)

    const guestWalletBefore = await db.wallet.findFirstOrThrow({
      where: { guestSessionId: session.id },
    })
    expect(guestWalletBefore.balance).toBe(120)
    expect(guestWalletBefore.status).toBe('PROVISIONAL')

    const res = await claim(cookie, credentials)
    expect(res.body.vestedCoins).toBe(120)
    expect(res.body.forfeitedCoins).toBe(0)

    const userWallet = await db.wallet.findFirstOrThrow({
      where: { userId: res.body.identity.userId, assetCode: 'COIN' },
    })
    expect(userWallet.balance).toBe(120)
    expect(userWallet.status).toBe('VESTED')

    // Step 10: the coins were *moved*, not conjured. The guest wallet holds a
    // matched negative row and lands on zero.
    const guestWallet = await db.wallet.findUniqueOrThrow({ where: { id: guestWalletBefore.id } })
    expect(guestWallet.balance).toBe(0)
    const mirror = await db.walletTransaction.findFirstOrThrow({
      where: { walletId: guestWallet.id, kind: 'GUEST_VEST' },
    })
    expect(mirror.amount).toBe(-120)
    expect(mirror.idempotencyKey).toBe(`vest:${session.id}`)

    // Σ across both wallets is conserved: 120 in, 120 out, 120 in again.
    const total = await db.walletTransaction.aggregate({ _sum: { amount: true } })
    expect(total._sum.amount).toBe(120)
  })

  it('★ provisional 900 vests 500 and forfeits 400, explained on its own row', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)
    // Two credits, because the guest daily cap is 500 — which is itself the
    // reason a guest can hold more than the vesting cap only over time.
    await db.wallet.update({
      where: {
        id: (await db.wallet.findFirstOrThrow({ where: { guestSessionId: session.id } })).id,
      },
      data: { balance: 900, lifetimeEarned: 900 },
    })
    const guestWalletId = (
      await db.wallet.findFirstOrThrow({ where: { guestSessionId: session.id } })
    ).id
    await db.walletTransaction.create({
      data: {
        walletId: guestWalletId,
        assetCode: 'COIN',
        amount: 900,
        kind: 'MATCH_REWARD',
        idempotencyKey: 'seeded-900',
        balanceAfter: 900,
      },
    })

    const res = await claim(cookie, credentials)
    expect(res.body.vestedCoins).toBe(500)
    expect(res.body.forfeitedCoins).toBe(400)

    const forfeit = await db.walletTransaction.findFirstOrThrow({
      where: { kind: 'GUEST_FORFEIT' },
    })
    expect(forfeit.amount).toBe(-400)
    // A machine reason, so the statement can say *why* 400 coins vanished
    // (10 §3.4's farming bound) rather than merely showing that they did.
    expect(forfeit.reason).toBe('GUEST_VEST_CAP')
    expect(forfeit.idempotencyKey).toBe(`forfeit:${session.id}`)

    const guestWallet = await db.wallet.findUniqueOrThrow({ where: { id: guestWalletId } })
    expect(guestWallet.balance).toBe(0)
    expect(guestWallet.status).toBe('VESTED')
  })

  it('a guest with no coins claims cleanly, writing no ledger rows', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)

    const res = await claim(cookie, credentials)
    expect(res.body.vestedCoins).toBe(0)
    expect(res.body.forfeitedCoins).toBe(0)
    expect(await db.walletTransaction.count()).toBe(0)
  })

  it('★ the event log, the chat and the participations are re-attributed', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)

    const game = await db.gameInstance.create({
      data: {
        tableId,
        gameSlug: 'fixture',
        rngSeed: 'seed',
        seedCommit: 'commit',
        seatingJson: '[]',
        optionsJson: '{}',
      },
    })
    const event = await db.gameEvent.create({
      data: {
        gameId: game.id,
        seq: 1,
        kind: 'MOVE',
        actorGuestId: session.id,
        seat: 2,
        payloadJson: '{}',
      },
    })
    const message = await db.chatMessage.create({
      data: { tableId, guestSessionId: session.id, body: 'nice trick' },
    })
    const result = await db.matchResult.create({
      data: {
        gameId: game.id,
        gameSlug: 'fixture',
        reason: 'NORMAL',
        summaryJson: '{}',
        durationMs: 1_000,
      },
    })
    const participant = await db.matchParticipant.create({
      data: { matchResultId: result.id, guestSessionId: session.id, seat: 2, rank: 1, score: 10 },
    })

    const res = await claim(cookie, credentials)
    const userId = res.body.identity.userId

    // The evening they just played counts toward the new account (03 §6.1).
    expect((await db.gameEvent.findUniqueOrThrow({ where: { id: event.id } })).actorUserId).toBe(
      userId,
    )
    expect(
      (await db.gameEvent.findUniqueOrThrow({ where: { id: event.id } })).actorGuestId,
    ).toBeNull()
    expect((await db.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).userId).toBe(
      userId,
    )
    expect(
      (await db.matchParticipant.findUniqueOrThrow({ where: { id: participant.id } })).userId,
    ).toBe(userId)
  })

  it('the guest session survives as the audit link between the two identities', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)

    const res = await claim(cookie, credentials)
    const settled = await db.guestSession.findUniqueOrThrow({ where: { id: session.id } })

    // Never deleted: it is how "who was this account before?" is answerable,
    // and it is what guarantees the token can never be reused.
    expect(settled.claimedAt).not.toBeNull()
    expect(settled.claimedByUserId).toBe(res.body.identity.userId)
  })

  it('★ the guest token is dead the moment the claim commits', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)
    await claim(cookie, credentials)

    // Not merely "cannot claim again" — the cookie no longer authenticates at
    // all, so it is not a second, weaker credential for the account's seat.
    const asGuest = await request(app).get('/api/v1/auth/me').set('Cookie', cookie)
    expect(asGuest.status).toBe(401)

    const again = await claim(cookie, { ...credentials, email: 'other@test.dev' })
    expect(again.status).toBe(401)
    expect(again.body.code).toBe('UNAUTHORIZED')
    expect(await db.user.count({ where: { email: 'other@test.dev' } })).toBe(0)
  })

  it('issues a working session, and clears the guest cookie in the same response', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)

    const res = await claim(cookie, credentials)
    expect(cookieOf(res, AUTH_COOKIES.access)).toBeTruthy()
    expect(cookieOf(res, AUTH_COOKIES.refresh)).toBeTruthy()
    // Cleared, not left to expire: the browser must stop sending a credential
    // that can only ever be refused now.
    expect(cookieOf(res, AUTH_COOKIES.guest)).toBe(`${AUTH_COOKIES.guest}=`)

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieOf(res, AUTH_COOKIES.access))
    expect(me.body).toMatchObject({ kind: 'user', email: credentials.email })

    // A fresh rotation family, not the guest's anything.
    expect(await db.refreshToken.count({ where: { userId: res.body.identity.userId } })).toBe(1)
  })

  it('carries the display name, locale and preferences chosen before signing up', async () => {
    const { cookie, session } = await joinAsGuest('Sara')
    await db.guestSession.update({
      where: { id: session.id },
      data: {
        locale: 'fa',
        prefsJson: JSON.stringify({ theme: 'dark', numeralSystem: 'persian', nonsense: 'dropped' }),
      },
    })

    const res = await claim(cookie, credentials)
    expect(res.body.identity.displayName).toBe('Sara')
    expect(res.body.identity.locale).toBe('fa')

    const prefs = await db.userPreferences.findUniqueOrThrow({
      where: { userId: res.body.identity.userId },
    })
    expect(prefs.theme).toBe('dark')
    expect(prefs.numeralSystem).toBe('persian')
    expect(prefs.locale).toBe('fa')
    // The unknown key was dropped rather than passed to Prisma — which would
    // have failed the whole claim over a preference.
    expect(await db.userCosmetic.count({ where: { userId: res.body.identity.userId } })).toBe(1)
  })

  it('lets the player rename themselves while signing up', async () => {
    const { cookie, session } = await joinAsGuest('Sara')
    await seatGuest(session.id)

    const res = await claim(cookie, { ...credentials, displayName: 'Sara Ahmadi' })
    expect(res.body.identity.displayName).toBe('Sara Ahmadi')
  })

  it('★ the balance a player sees goes PROVISIONAL 120 → VESTED 120', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)
    await grantProvisional(session.id, 120)

    // Exactly the two reads the S22 verify step makes by hand. They went
    // through the dev-only `/_probe/wallet` until S37; that route is gone and
    // these now hit the real `GET /wallet`, which is the point of having it.
    const before = await request(app).get('/api/v1/wallet').set('Cookie', cookie)
    expect(before.body.balances).toEqual([
      { asset: 'COIN', balance: 120, status: 'PROVISIONAL', lifetimeEarned: 120, lifetimeSpent: 0 },
    ])

    const res = await claim(cookie, credentials)
    const accessCookie = cookieOf(res, AUTH_COOKIES.access)
    const after = await request(app).get('/api/v1/wallet').set('Cookie', accessCookie)

    expect(after.body.balances).toContainEqual(
      expect.objectContaining({ asset: 'COIN', balance: 120, status: 'VESTED' }),
    )
    // A user holds all three assets from the moment the account exists.
    expect(after.body.balances.map((b: { asset: string }) => b.asset)).toEqual([
      'COIN',
      'GEM',
      'TICKET',
    ])

    // And the statement — a user's route, which the guest half of this journey
    // deliberately cannot reach.
    const statement = await request(app)
      .get('/api/v1/wallet/transactions')
      .set('Cookie', accessCookie)
    expect(statement.body.items[0]).toMatchObject({
      kind: 'GUEST_VEST',
      amount: 120,
      balanceAfter: 120,
    })
  })

  it('claims cleanly for a guest who never sat down', async () => {
    const { cookie } = await joinAsGuest()

    const res = await claim(cookie, credentials)
    expect(res.status).toBe(201)
    // Honest rather than convenient: there was no seat to preserve, and the
    // client needs to know whether to render a table or a lobby.
    expect(res.body.seatPreserved).toBe(false)
    expect(res.body.redirectTo).toBe(`/table/${tableId}`)
  })
})

describe('POST /auth/guest/claim — the four failure modes (03 §6.1)', () => {
  it('★ duplicate email at step 2: no user, no seat change, no vest', async () => {
    const { cookie, session } = await joinAsGuest()
    const before = await seatGuest(session.id)
    await grantProvisional(session.id, 120)

    const res = await claim(cookie, { ...credentials, email: 'host@test.dev' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('EMAIL_TAKEN')

    // Everything, unwound. The seat is still the guest's.
    expect(await db.user.count()).toBe(1)
    const member = await db.tableMember.findUniqueOrThrow({ where: { id: before.id } })
    expect(member.guestSessionId).toBe(session.id)
    expect(member.userId).toBeNull()
    expect(
      (await db.wallet.findFirstOrThrow({ where: { guestSessionId: session.id } })).balance,
    ).toBe(120)
    expect(await db.walletTransaction.count({ where: { kind: 'GUEST_VEST' } })).toBe(0)
    expect(
      (await db.guestSession.findUniqueOrThrow({ where: { id: session.id } })).claimedAt,
    ).toBeNull()
  })

  it('★ expired guest at step 1: 401, and nothing is created', async () => {
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)
    await db.guestSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })

    const res = await claim(cookie, credentials)
    expect(res.status).toBe(401)
    expect(await db.user.count()).toBe(1)
    expect(await db.userPreferences.count()).toBe(0)
    expect(await db.refreshToken.count()).toBe(0)
  })

  it('★ a throw at step 6 rolls back the created user', async () => {
    const { cookie, session } = await joinAsGuest()
    const before = await seatGuest(session.id)

    // Step 6 is the event-log re-attribution — chosen by 03 §6.1 precisely
    // because it is *after* the user exists and after the seat has moved.
    //
    // The spy goes on the **prototype**, not on `container.repos`: `uow.run`
    // builds a fresh repository set bound to the transaction client, so the
    // container's instances are not the objects the claim uses. That is the
    // design working (02 §5.4) and it is worth knowing before writing the next
    // rollback test.
    const spy = vi
      .spyOn(PrismaGameEventRepository.prototype, 'reattributeActor')
      .mockRejectedValueOnce(new Error('re-attribution exploded'))

    const res = await claim(cookie, credentials)
    spy.mockRestore()

    expect(res.status).toBe(500)
    expect(await db.user.count({ where: { email: credentials.email } })).toBe(0)
    const member = await db.tableMember.findUniqueOrThrow({ where: { id: before.id } })
    expect(member.guestSessionId).toBe(session.id)
  })

  it('★ a throw at step 9 rolls back BOTH the user and the seat transfer', async () => {
    const { cookie, session } = await joinAsGuest()
    const before = await seatGuest(session.id)
    await grantProvisional(session.id, 120)

    // A claimed seat with no wallet is exactly as broken as a wallet with no
    // seat, which is why this case is called out separately in the spec.
    const spy = vi
      .spyOn(PrismaWalletRepository.prototype, 'markVested')
      .mockRejectedValueOnce(new Error('vesting exploded'))

    const res = await claim(cookie, credentials)
    spy.mockRestore()

    expect(res.status).toBe(500)
    expect(await db.user.count({ where: { email: credentials.email } })).toBe(0)

    const member = await db.tableMember.findUniqueOrThrow({ where: { id: before.id } })
    expect(member.userId).toBeNull()
    expect(member.guestSessionId).toBe(session.id)

    const guestWallet = await db.wallet.findFirstOrThrow({ where: { guestSessionId: session.id } })
    expect(guestWallet.balance).toBe(120)
    expect(guestWallet.status).toBe('PROVISIONAL')
    expect(await db.walletTransaction.count({ where: { kind: 'GUEST_VEST' } })).toBe(0)
    expect(
      (await db.guestSession.findUniqueOrThrow({ where: { id: session.id } })).claimedAt,
    ).toBeNull()
  })
})

describe('POST /auth/guest/claim — refusals', () => {
  it('with no guest cookie at all: 401 and an audit row', async () => {
    const res = await request(app).post('/api/v1/auth/guest/claim').send(credentials)

    expect(res.status).toBe(401)
    expect(await db.user.count()).toBe(1)

    // Polled, not read once. `SecurityEventService.record` is deliberately
    // fire-and-forget — an audit failure must never fail the audited request
    // (07 §6) — so the insert is *scheduled* before the 401 is written and may
    // land after it. Reading straight after the response asserts a synchrony
    // the service explicitly does not promise, and the resulting flake reads as
    // "auditing is broken" rather than as a test that raced.
    await expect
      .poll(() => db.securityEvent.count({ where: { kind: 'BAD_TOKEN' } }))
      .toBeGreaterThanOrEqual(1)
  })

  it('with a forged guest cookie: 401, no user, no oracle', async () => {
    const res = await claim(`${AUTH_COOKIES.guest}=g1.ZmFrZQ.nonce.deadbeef`, credentials)

    expect(res.status).toBe(401)
    // Forged, unknown, malformed and swept all answer identically — the
    // difference would be information about which tokens exist.
    expect(res.body.details?.reason).toBe('NO_GUEST_SESSION')
    expect(await db.user.count({ where: { email: credentials.email } })).toBe(0)
  })

  it('rejects a weak password before touching the database', async () => {
    const { cookie } = await joinAsGuest()

    const res = await claim(cookie, { ...credentials, password: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.fieldErrors?.password?.[0]).toBe('errors.passwordTooShort')
    expect(await db.user.count({ where: { email: credentials.email } })).toBe(0)
  })

  it('rejects a reserved display name', async () => {
    const { cookie } = await joinAsGuest()

    const res = await claim(cookie, { ...credentials, displayName: 'Admin' })
    expect(res.status).toBe(400)
    expect(await db.user.count({ where: { email: credentials.email } })).toBe(0)
  })

  it('rejects an unknown field rather than dropping it (P7)', async () => {
    const { cookie } = await joinAsGuest()

    // `tableId` is the field somebody will eventually try to add here. It must
    // be a 400, not a silently ignored key.
    const res = await claim(cookie, { ...credentials, tableId: 'somewhere-else' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('a guest cannot claim into another table s seat, because it names no table', async () => {
    const other = await db.table.create({
      data: { hostUserId: hostId, gameSlug: 'fixture', optionsJson: '{}', seatCount: 4 },
    })
    const { cookie, session } = await joinAsGuest()
    await seatGuest(session.id)

    const res = await claim(cookie, credentials)
    // The seat that moved is the one the guest actually held; the other table
    // is untouched, and there was never a field with which to ask otherwise.
    expect(res.body.redirectTo).toBe(`/table/${tableId}`)
    expect(await db.tableMember.count({ where: { tableId: other.id } })).toBe(0)
  })
})
