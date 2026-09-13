import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import { dealGame, pressTurns, seatMember, seatTable, waitFor } from '../helpers/game.js'
import { FakeClock } from '../fakes/clock.js'
import { RecordingPublisher } from '../fakes/realtime.js'
import { seatRoom } from '../../src/application/ports/realtime.js'
import { BOT_MOVE_DELAY_MS } from '../../src/application/services/SeatEnforcementService.js'
import { PREMIUM_EARN_MULTIPLIER } from '../../src/application/services/RewardService.js'
import type { GameRewardSettledPayload, WalletUpdatedPayload } from '../../src/contracts/events.js'
import type { GameInstance } from '../../src/domain/entities/game.js'
import type { GameResult } from '../../src/domain/games/GameEngine.js'
import { userRef, type IdentityRef } from '../../src/domain/value-objects/identity.js'
import { seatId } from '../../src/domain/value-objects/seat.js'

/**
 * ★★ S36 — settlement, and the M0 rule it exists to enforce.
 *
 * > *An ejected player on a winning team earns 0. Their partner earns the full
 * > winning reward.*
 *
 * The first describe block is that sentence, asserted from both ends: the
 * forfeited seat's zero **and** the partner's full amount, in the same match,
 * at the same rank, from one settlement. Asserting only the zero would pass for
 * a settlement that paid nobody, which is the failure mode worth guarding
 * against — a broken reward path and a correctly-applied penalty look identical
 * from the punished seat.
 *
 * Everything after it is the machinery that makes the rule safe to rely on:
 * idempotency at two levels, all-or-nothing rollback, guests, bots, and the
 * ledger invariant across randomized matches.
 *
 * ### Why most of these settle a hand-built `GameResult`
 *
 * `_fixture` is a two-outcome engine: one seat wins, everyone else does not.
 * Partnerships arrive with Shelem at M4. A `GameResult` is a plain record and
 * *is* the interface a partnership engine will hand settlement, so building one
 * with two seats sharing rank 1 tests exactly the code M4 will run — while the
 * last block below walks the whole real pipeline through the engine, so the
 * two halves cannot drift.
 */

const clock = new FakeClock()
const { container } = buildTestApp({ clock })
const published = new RecordingPublisher()
container.realtime.attach(published)

beforeEach(async () => {
  await resetDb()
  published.sent.length = 0
  container.turnTimers.stop()
  container.seats.stop()
  await seedRules()
})

afterAll(async () => {
  await container.shutdown()
})

// ── Setup ──────────────────────────────────────────────────────────────────

/** `resetDb` truncates `RewardRule`, so every test re-seeds its own rate card. */
async function seedRules(base = 80): Promise<void> {
  const caps = {
    capPerHour: 400,
    capPerDay: 2_000,
    capPerDayGuest: 500,
    capMatchesPerDay: 30,
    guestVestCap: 500,
  }
  const placement = JSON.stringify({
    draw: 1,
    bySeatCount: {
      '2': { '1': 1.5, '2': 0.6 },
      '4': { '1': 1.5, '2': 1.0, '3': 0.7, '4': 0.5 },
    },
  })
  const repeatDecayJson = JSON.stringify([1, 1, 0.6, 0.3, 0.1])

  await db.rewardRule.create({
    data: {
      id: 'fixture',
      gameSlug: 'fixture',
      assetCode: 'COIN',
      baseAmount: base,
      placementJson: placement,
      // 0 ⇒ durationFactor 1, so these tests measure the reward rules rather
      // than how quickly a scripted match happens to finish.
      expectedMinMs: 0,
      repeatDecayJson,
      ...caps,
    },
  })
  await db.rewardRule.create({
    data: {
      id: '_global',
      gameSlug: null,
      assetCode: 'COIN',
      baseAmount: 0,
      placementJson: JSON.stringify({ draw: 1, bySeatCount: {} }),
      expectedMinMs: 0,
      repeatDecayJson,
      ...caps,
    },
  })
}

/** A 4-seat table with partners across the diagonal — the Shelem shape. */
async function partnershipGame(): Promise<{
  instance: GameInstance
  tableId: string
  identities: readonly IdentityRef[]
}> {
  // `seatTable`, not `dealGame`: the teams have to be on the member rows
  // *before* the instance is created, because `GameInstance.seating` is the
  // historical snapshot and is what settlement reads.
  const seated = await seatTable(container, { seats: 4, target: 3 })

  // `fixture` declares no teams, so they are set here directly: the *rule*
  // being tested is per-seat reward eligibility inside a winning team, and the
  // team column is what makes "their partner" a meaningful phrase.
  for (const seat of [0, 1, 2, 3]) {
    const member = await seatMember(container, seated.tableId, seat)
    await container.repos.tables.updateMember(member.id, { team: seat % 2 })
  }

  const instance = await container.games.createInstance(seated.tableId, {
    identity: userRef(seated.hostUserId),
    isHost: true,
  })

  return { instance, tableId: seated.tableId, identities: seated.identities }
}

/** Seats 1 and 3 (team 1) win; seats 0 and 2 do not. */
function teamOneWins(overrides: Partial<GameResult> = {}): GameResult {
  return {
    standings: [0, 1, 2, 3].map((seat) => ({
      seat: seatId(seat),
      rank: seat % 2 === 1 ? 1 : 2,
      score: seat % 2 === 1 ? 165 : 100,
      // The engine says COMPLETED for everybody, always. Ejection is not its
      // business — settlement overwrites this from the member row.
      outcome: 'COMPLETED' as const,
      playedFraction: 1,
    })),
    winningTeam: 1,
    summary: { contract: 165 },
    reason: 'NORMAL' as const,
    ...overrides,
  }
}

async function eject(tableId: string, seat: number, reason = 'TURN_TIMEOUT'): Promise<void> {
  const member = await seatMember(container, tableId, seat)
  await container.repos.tables.updateMember(member.id, {
    ejectedAt: new Date(),
    ejectionReason: reason as 'TURN_TIMEOUT',
    botSubstituted: true,
  })
}

/**
 * A finished match between `holders`, written straight to the repositories.
 *
 * `MatchResult.gameId` is a foreign key, so a prior meeting needs a real
 * `GameInstance` behind it — which is honest: the repeat-decay lookup joins
 * results to participants, and a dangling result would be testing a shape the
 * database cannot hold.
 */
async function priorMatch(
  tableId: string,
  label: string,
  holders: readonly (IdentityRef | { userId: string })[],
  finishedAt: Date,
): Promise<void> {
  const instance = await container.repos.games.create({
    tableId,
    gameSlug: 'fixture',
    rngSeed: `seed-${label}`,
    seedCommit: `commit-${label}`,
    seating: [],
    options: {},
  })
  const match = await db.matchResult.create({
    data: {
      gameId: instance.id,
      gameSlug: 'fixture',
      reason: 'NORMAL',
      summaryJson: '{}',
      durationMs: 1_000,
      finishedAt,
    },
  })
  for (const [seat, holder] of holders.entries()) {
    const userId = 'userId' in holder ? holder.userId : null
    await db.matchParticipant.create({
      data: { matchResultId: match.id, userId, seat, rank: 1, score: 0 },
    })
  }
}

async function ledgerFor(identity: IdentityRef) {
  const wallet = await container.repos.wallets.findByHolder(identity, 'COIN')
  if (wallet === null) return { balance: 0, rows: [] }
  return { balance: wallet.balance, rows: await container.repos.wallets.listTransactions(wallet.id) }
}

// ───────────────────────────────────────────────────────────────────────────

describe('★★ the M0 rule: an ejected winner earns nothing, their partner earns in full', () => {
  it('★★ seat 1 is ejected on the WINNING team — 0 coins, forfeited; seat 3 gets the full amount', async () => {
    const game = await partnershipGame()
    await eject(game.tableId, 1)

    await container.settlement.settle(game.instance, teamOneWins())

    const participants = await db.matchParticipant.findMany({ orderBy: { seat: 'asc' } })

    // The ejected seat: rank 1, on the winning team, paid nothing.
    expect(participants[1]).toMatchObject({
      seat: 1,
      team: 1,
      rank: 1,
      outcome: 'EJECTED_TIMEOUT',
      coinsAwarded: 0,
      rewardForfeited: true,
    })

    // ★ Their partner: same team, same rank, same match — paid in full.
    // base 80 × placement 1.5 = 120.
    expect(participants[3]).toMatchObject({
      seat: 3,
      team: 1,
      rank: 1,
      outcome: 'COMPLETED',
      coinsAwarded: 120,
      rewardForfeited: false,
    })

    expect(await ledgerFor(game.identities[1]!)).toMatchObject({ balance: 0 })
    expect(await ledgerFor(game.identities[3]!)).toMatchObject({ balance: 120 })
  })

  it('★ the forfeit is RECORDED, never silent — a CAP_REJECTED row saying why (10 §5.2 rule 6)', async () => {
    const game = await partnershipGame()
    await eject(game.tableId, 1)

    await container.settlement.settle(game.instance, teamOneWins())

    const { rows } = await ledgerFor(game.identities[1]!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'CAP_REJECTED',
      amount: 0,
      // A machine code, not a translation key and not an English sentence: the
      // ledger is read by operators and by the reconciliation job.
      reason: 'EJECTED_TIMEOUT',
      refKind: 'match',
    })
  })

  it('★ losing seats still get paid — 0.5×, not nothing (§3.3)', async () => {
    const game = await partnershipGame()
    await container.settlement.settle(game.instance, teamOneWins())

    // Rank 2 of 4 → ×1.0 → 80. A game where losing pays nothing teaches people
    // to quit when behind, which is the behaviour ejection penalties exist to
    // discourage.
    expect((await ledgerFor(game.identities[0]!)).balance).toBe(80)
    expect((await ledgerFor(game.identities[2]!)).balance).toBe(80)
  })

  it('★ EJECTED_ABANDON forfeits too, and is recorded as the different thing it is', async () => {
    const game = await partnershipGame()
    await eject(game.tableId, 1, 'ABANDON')

    await container.settlement.settle(game.instance, teamOneWins())

    const { rows, balance } = await ledgerFor(game.identities[1]!)
    expect(balance).toBe(0)
    expect(rows[0]?.reason).toBe('EJECTED_ABANDON')
  })

  it('★ the ejected seat is told what it cost, and nobody else is (04 §6.6)', async () => {
    const game = await partnershipGame()
    await eject(game.tableId, 1)
    published.sent.length = 0

    await container.settlement.settle(game.instance, teamOneWins())

    const settled = published.sent.filter((sent) => sent.event === 'game:rewardSettled')
    expect(settled).toHaveLength(4)

    // Every receipt goes to exactly one seat room. Not one reaches the table.
    for (const sent of settled) {
      const payload = sent.payload as GameRewardSettledPayload
      expect(sent.room).toBe(seatRoom(game.instance.tableId, payload.seat))
    }

    const mine = settled.find(
      (sent) => (sent.payload as GameRewardSettledPayload).seat === 1,
    )?.payload as GameRewardSettledPayload
    expect(mine).toMatchObject({
      coinsAwarded: 0,
      forfeited: true,
      reasonKey: 'games.reward.forfeitedTimeout',
    })
    // ★ §11 — the arithmetic travels with the verdict, so the post-match screen
    // can show the line that was zeroed rather than just the zero.
    expect(mine.factors).toMatchObject({ base: 80, placement: 1.5, integrity: 0 })
  })

  it('a returned player recovers half — coming back beats staying away (04 §6.4)', async () => {
    const game = await partnershipGame()
    const member = await seatMember(container, game.tableId, 1)
    await container.repos.tables.updateMember(member.id, { team: 1 })

    // The reclaim cleared the member row, so the log is what remembers.
    await container.repos.events.append({
      gameId: game.instance.id,
      kind: 'SYSTEM',
      seat: seatId(1),
      actorUserId: null,
      actorGuestId: null,
      clientMoveId: null,
      payload: { system: 'PLAYER_RETURNED' },
    })

    await container.settlement.settle(game.instance, teamOneWins())

    expect((await ledgerFor(game.identities[1]!)).balance).toBe(60)
    const participants = await db.matchParticipant.findMany({ where: { seat: 1 } })
    expect(participants[0]).toMatchObject({ outcome: 'REPLACED_RETURNED', coinsAwarded: 60 })
  })
})

describe('idempotency — a settlement can be attempted any number of times', () => {
  it('★ settling twice credits NOTHING twice, and writes no second set of rows (E2)', async () => {
    const game = await partnershipGame()
    const result = teamOneWins()

    const first = await container.settlement.settle(game.instance, result)
    const second = await container.settlement.settle(game.instance, result)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.matchResult.id).toBe(first.matchResult.id)

    expect(await db.matchResult.count()).toBe(1)
    expect(await db.matchParticipant.count()).toBe(4)
    expect((await ledgerFor(game.identities[3]!)).balance).toBe(120)
    expect((await ledgerFor(game.identities[3]!)).rows).toHaveLength(1)
  })

  it('★ two settlements racing each other produce one match and one payment', async () => {
    const game = await partnershipGame()
    const result = teamOneWins()

    const outcomes = await Promise.allSettled([
      container.settlement.settle(game.instance, result),
      container.settlement.settle(game.instance, result),
    ])

    // One of them may lose on the unique constraint; neither may double-pay.
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
    expect(await db.matchResult.count()).toBe(1)
    expect((await ledgerFor(game.identities[3]!)).balance).toBe(120)
  })

  it('the per-seat key is exactly `match:{matchResultId}:{seat}` (10 §2.4)', async () => {
    const game = await partnershipGame()
    const settled = await container.settlement.settle(game.instance, teamOneWins())

    const { rows } = await ledgerFor(game.identities[3]!)
    expect(rows[0]?.idempotencyKey).toBe(`match:${settled.matchResult.id}:3`)
  })
})

describe('all-or-nothing', () => {
  it('★ a throw mid-loop rolls the WHOLE match back — no result, no partial credits', async () => {
    const game = await partnershipGame()

    // Seat 2's credit blows up. Everything written before it — the match
    // result, seats 0 and 1's participants, seat 0's coins — must vanish.
    const original = container.wallets.creditWithin.bind(container.wallets)
    let calls = 0
    const spy = async (...args: Parameters<typeof original>) => {
      calls += 1
      if (calls === 3) throw new Error('boom, mid-settlement')
      return original(...args)
    }
    ;(container.wallets as unknown as { creditWithin: typeof original }).creditWithin =
      spy as typeof original

    try {
      await expect(container.settlement.settle(game.instance, teamOneWins())).rejects.toThrow(
        'boom, mid-settlement',
      )
    } finally {
      ;(container.wallets as unknown as { creditWithin: typeof original }).creditWithin = original
    }

    expect(await db.matchResult.count()).toBe(0)
    expect(await db.matchParticipant.count()).toBe(0)
    expect(await db.walletTransaction.count()).toBe(0)

    // ★ And the match is still settleable — nothing is stuck.
    const retried = await container.settlement.settle(game.instance, teamOneWins())
    expect(retried.applied).toBe(true)
    expect((await ledgerFor(game.identities[3]!)).balance).toBe(120)
  })
})

describe('who earns, and who cannot', () => {
  it('★ a bot seat produces a participant row and NO wallet transaction of any kind', async () => {
    const seated = await seatTable(container, { seats: 2, target: 3 })
    const member = await seatMember(container, seated.tableId, 1)
    await container.repos.tables.updateMember(member.id, { isBot: true })

    const instance = await container.games.createInstance(seated.tableId, {
      identity: userRef(seated.hostUserId),
      isHost: true,
    })

    await container.settlement.settle(instance, {
      standings: [
        { seat: seatId(0), rank: 1, score: 3, outcome: 'COMPLETED', playedFraction: 1 },
        { seat: seatId(1), rank: 2, score: 1, outcome: 'COMPLETED', playedFraction: 1 },
      ],
      summary: {},
      reason: 'NORMAL',
    })

    const bot = await db.matchParticipant.findFirst({ where: { seat: 1 } })
    expect(bot).toMatchObject({ isBot: true, outcome: 'BOT', coinsAwarded: 0, rewardTxId: null })
    // Exactly one ledger row in the whole database: the human's.
    expect(await db.walletTransaction.count()).toBe(1)
  })

  it('★ a guest earns into a PROVISIONAL wallet — the signup incentive (10 §3.4)', async () => {
    const seated = await seatTable(container, { seats: 2, target: 3 })
    const guest = await db.guestSession.create({
      data: {
        tokenHash: `hash-settle-${String(Date.now())}`,
        displayName: 'Sara',
        tableId: seated.tableId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const member = await seatMember(container, seated.tableId, 1)
    await container.repos.tables.updateMember(member.id, { userId: null, guestSessionId: guest.id })

    const instance = await container.games.createInstance(seated.tableId, {
      identity: userRef(seated.hostUserId),
      isHost: true,
    })

    await container.settlement.settle(instance, {
      standings: [
        { seat: seatId(0), rank: 2, score: 1, outcome: 'COMPLETED', playedFraction: 1 },
        { seat: seatId(1), rank: 1, score: 3, outcome: 'COMPLETED', playedFraction: 1 },
      ],
      summary: {},
      reason: 'NORMAL',
    })

    const wallet = await db.wallet.findFirst({ where: { guestSessionId: guest.id } })
    expect(wallet).toMatchObject({ status: 'PROVISIONAL', balance: 120 })
  })

  it('an ineligible table pays nobody, and says so — but nobody is "forfeited" (09 §7.2)', async () => {
    const game = await partnershipGame()
    await container.repos.tables.update(game.tableId, { rewardEligible: false })

    await container.settlement.settle(game.instance, teamOneWins())

    expect(await db.walletTransaction.aggregate({ _sum: { amount: true } })).toMatchObject({
      _sum: { amount: 0 },
    })
    const participants = await db.matchParticipant.findMany()
    expect(participants.every((row) => row.rewardForfeited === false)).toBe(true)
    expect(participants.every((row) => row.coinsAwarded === 0)).toBe(true)
  })
})

describe('the factors that need a database to resolve', () => {
  it('★ §3.5 — the same four people meeting a third time inside 30 minutes decay to 0.6×', async () => {
    const game = await partnershipGame()

    // Two prior meetings of exactly this group, both inside the window.
    for (const round of [1, 2]) {
      await priorMatch(
        game.tableId,
        `prior-${String(round)}`,
        game.identities,
        new Date(Date.now() - round * 60_000),
      )
    }

    await container.settlement.settle(game.instance, teamOneWins())

    // Third meeting: 120 × 0.6 = 72.
    expect((await ledgerFor(game.identities[3]!)).balance).toBe(72)
  })

  it('★ …and a DIFFERENT group is a different matchup, however recently they played', async () => {
    const game = await partnershipGame()
    const stranger = await db.user.create({
      data: {
        email: `stranger-${String(Date.now())}@test.dev`,
        passwordHash: 'x',
        displayName: 'Stranger',
      },
    })

    for (const round of [1, 2]) {
      // Three of the four, plus somebody else — not the same set.
      await priorMatch(
        game.tableId,
        `other-${String(round)}`,
        [...game.identities.slice(0, 3), { userId: stranger.id }],
        new Date(Date.now() - round * 60_000),
      )
    }

    await container.settlement.settle(game.instance, teamOneWins())
    expect((await ledgerFor(game.identities[3]!)).balance).toBe(120)
  })

  it('★ §6.1 — an active subscription earns 1.5×, and a lapsed one does not (E3)', async () => {
    const game = await partnershipGame()
    const subscriber = game.identities[3]!

    await db.subscription.create({
      data: {
        userId: subscriber.kind === 'user' ? subscriber.userId : '',
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    })
    // Seat 1 is on the same team, same rank, no subscription — the control.
    await container.settlement.settle(game.instance, teamOneWins())

    expect((await ledgerFor(subscriber)).balance).toBe(120 * PREMIUM_EARN_MULTIPLIER)
    expect((await ledgerFor(game.identities[1]!)).balance).toBe(120)
  })

  it('an EXPIRED subscription earns 1.0× — the period end is checked, not trusted', async () => {
    const game = await partnershipGame()
    const lapsed = game.identities[3]!

    await db.subscription.create({
      data: {
        userId: lapsed.kind === 'user' ? lapsed.userId : '',
        // Left ACTIVE by a webhook that never arrived. The date is the truth.
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      },
    })

    await container.settlement.settle(game.instance, teamOneWins())
    expect((await ledgerFor(lapsed)).balance).toBe(120)
  })

  it('PAST_DUE inside its grace window still earns 1.5× (§6.3)', async () => {
    const game = await partnershipGame()
    const graced = game.identities[3]!

    await db.subscription.create({
      data: {
        userId: graced.kind === 'user' ? graced.userId : '',
        status: 'PAST_DUE',
        currentPeriodEnd: new Date(Date.now() - 3_600_000),
        graceEndsAt: new Date(Date.now() + 86_400_000),
      },
    })

    await container.settlement.settle(game.instance, teamOneWins())
    expect((await ledgerFor(graced)).balance).toBe(120 * PREMIUM_EARN_MULTIPLIER)
  })
})

describe('the ledger stays true', () => {
  it('Σ coinsAwarded across seats equals Σ of the matching ledger rows', async () => {
    const game = await partnershipGame()
    const settled = await container.settlement.settle(game.instance, teamOneWins())

    const participants = await db.matchParticipant.findMany({
      where: { matchResultId: settled.matchResult.id },
    })
    const awarded = participants.reduce((sum, row) => sum + row.coinsAwarded, 0)

    const credited = await db.walletTransaction.aggregate({
      where: { refKind: 'match', refId: settled.matchResult.id },
      _sum: { amount: true },
    })

    expect(awarded).toBe(credited._sum.amount ?? 0)
    expect(awarded).toBe(settled.totalPaid)
  })

  it('★ balance == Σ transactions for every wallet, after 50 randomized settled matches (E1)', async () => {
    const players: { id: string; displayName: string }[] = []
    for (let index = 0; index < 6; index += 1) {
      players.push(
        await db.user.create({
          data: {
            email: `rand-${String(index)}-${String(Date.now())}@test.dev`,
            passwordHash: 'x',
            displayName: `R${String(index)}`,
          },
        }),
      )
    }

    const table = await db.table.create({
      data: { gameSlug: 'fixture', optionsJson: '{}', seatCount: 4, status: 'FINISHED' },
    })

    for (let match = 0; match < 50; match += 1) {
      const seated = [0, 1, 2, 3].map((seat) => players[(match + seat) % players.length]!)
      const instance = await container.repos.games.create({
        tableId: table.id,
        gameSlug: 'fixture',
        rngSeed: `seed-${String(match)}`,
        seedCommit: `commit-${String(match)}`,
        seating: seated.map((player, seat) => ({
          seat: seatId(seat),
          userId: player.id,
          guestSessionId: null,
          isBot: false,
          displayName: player.displayName,
          team: seat % 2,
        })),
        options: {},
      })

      const order = [0, 1, 2, 3].sort(() => ((match * 7 + 3) % 5) - 2)
      await container.settlement.settle(instance, {
        standings: order.map((seat, index) => ({
          seat: seatId(seat),
          rank: index + 1,
          score: 10 - index,
          outcome: index === 3 && match % 4 === 0 ? 'EJECTED_TIMEOUT' : 'COMPLETED',
          playedFraction: 1,
        })),
        summary: {},
        reason: match % 9 === 0 ? 'DRAW' : 'NORMAL',
      })
    }

    const wallets = await db.wallet.findMany()
    expect(wallets.length).toBeGreaterThan(0)
    for (const wallet of wallets) {
      const sum = await db.walletTransaction.aggregate({
        where: { walletId: wallet.id },
        _sum: { amount: true },
      })
      expect(sum._sum.amount ?? 0, `wallet ${wallet.id} drifted`).toBe(wallet.balance)
    }
  })
})

describe('★ end to end: the real ejection pipeline settles itself', () => {
  it('★★ an idle player is ejected, a bot finishes the match, and the ledger agrees', async () => {
    const game = await dealGame(container, { seats: 2, target: 3 })
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 0)

    // Two strikes, exactly as S33's headline test walks them.
    await lapse(game.game.id)
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 1)
    await pressTurns(container, game, 1, 1)
    await waitFor(() => container.turnTimers.deadlineOf(game.game.id)?.seat === 0)
    await lapse(game.game.id)
    await waitFor(async () => (await seatMember(container, game.tableId, 0)).ejectedAt !== null)

    await playOut(game, 1)
    await waitFor(async () => (await db.matchResult.count()) === 1)

    // ★ Settlement happened on its own, from the move pipeline — nobody in this
    // test called `settle`.
    const participants = await db.matchParticipant.findMany({ orderBy: { seat: 'asc' } })
    expect(participants).toHaveLength(2)
    expect(participants[0]).toMatchObject({
      seat: 0,
      outcome: 'EJECTED_TIMEOUT',
      coinsAwarded: 0,
    })

    // The ejected player's wallet holds the explanation and nothing else.
    const ejected = await ledgerFor(game.identities[0]!)
    expect(ejected.balance).toBe(0)
    expect(ejected.rows[0]).toMatchObject({ kind: 'CAP_REJECTED', reason: 'EJECTED_TIMEOUT' })

    // And the player who stayed was paid.
    expect((await ledgerFor(game.identities[1]!)).balance).toBeGreaterThan(0)
  })

  it('★ wallet:updated reaches the holder live', async () => {
    const game = await partnershipGame()
    published.sent.length = 0

    await container.settlement.settle(game.instance, teamOneWins())

    const updates = published.sent.filter((sent) => sent.event === 'wallet:updated')
    expect(updates.length).toBe(4)

    const winner = game.identities[3]!
    const mine = updates.find(
      (sent) => sent.room === (winner.kind === 'user' ? `user:${winner.userId}` : ''),
    )?.payload as WalletUpdatedPayload
    expect(mine).toMatchObject({ asset: 'COIN', vested: 120, provisional: 0, delta: 120 })
  })
})

// ── Local helpers for the end-to-end block ─────────────────────────────────

async function lapse(gameId: string, times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    const before = container.turnTimers.deadlineOf(gameId)
    if (before === null) return
    clock.advance(30_000)
    await waitFor(() => container.turnTimers.deadlineOf(gameId) !== before)
  }
}

async function playOut(
  game: { game: { id: string }; identities: readonly IdentityRef[] },
  humanSeat: number,
  maxSteps = 60,
): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    const rebuilt = await container.games.rebuildState(game.game.id)
    if (rebuilt.engine.isTerminal(rebuilt.state)) return

    const toAct = (rebuilt.state as { toAct: number | null }).toAct
    if (toAct === humanSeat) {
      await container.games.applyMove({
        gameId: game.game.id,
        identity: game.identities[humanSeat]!,
        move: { kind: 'press' },
        clientMoveId: `human-${String(step)}`,
      })
      continue
    }

    clock.advance(BOT_MOVE_DELAY_MS)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
