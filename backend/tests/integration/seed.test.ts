import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tsxCli } from '../bin.js'
import { db, resetDb } from '../helpers/db.js'

/**
 * The seed has to be safe to re-run — a dev loop that can't `npm run seed`
 * twice is a dev loop nobody uses. Everything is `upsert` on a stable id, and
 * this proves it.
 */
function runSeed(nodeEnv: 'development' | 'production'): void {
  // `node <tsx cli>`, not `npx tsx` — see tests/bin.ts for why the shim path
  // is not portable.
  execFileSync(process.execPath, [tsxCli(), 'prisma/seed.ts'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: nodeEnv, DATABASE_URL: 'file:./test.db' },
  })
}

async function counts() {
  return {
    cosmetics: await db.cosmeticItem.count(),
    storeItems: await db.storeItem.count(),
    rewardRules: await db.rewardRule.count(),
    achievements: await db.achievement.count(),
    users: await db.user.count(),
    tables: await db.table.count(),
    invites: await db.invite.count(),
    matches: await db.matchResult.count(),
    participants: await db.matchParticipant.count(),
    wallets: await db.wallet.count(),
    transactions: await db.walletTransaction.count(),
    cosmeticGrants: await db.userCosmetic.count(),
  }
}

describe('seed', () => {
  let first: Awaited<ReturnType<typeof counts>>
  let second: Awaited<ReturnType<typeof counts>>

  beforeAll(async () => {
    await resetDb()
    runSeed('development')
    first = await counts()
    runSeed('development')
    second = await counts()
  }, 120_000)

  afterAll(async () => {
    await resetDb()
    await db.$disconnect()
  })

  it('is idempotent — running it twice changes no row count', () => {
    expect(second).toEqual(first)
  })

  it('seeds the catalog', () => {
    expect(first.cosmetics).toBeGreaterThan(10)
    expect(first.storeItems).toBeGreaterThan(5)
    expect(first.achievements).toBeGreaterThan(3)
  })

  it('seeds one RewardRule per game slug plus _global', async () => {
    const global = await db.rewardRule.findUnique({ where: { id: '_global' } })
    expect(global).not.toBeNull()
    expect(global?.gameSlug).toBeNull()
    // 10 §3.7 — the caps the whole economy is bounded by.
    expect(global?.capPerHour).toBe(400)
    expect(global?.capPerDay).toBe(2000)
    expect(global?.capPerDayGuest).toBe(500)
    expect(global?.capMatchesPerDay).toBe(30)
    expect(global?.guestVestCap).toBe(500)
  })

  it('uses the base rates from 10 §3.2', async () => {
    const expected: Record<string, number> = {
      sudoku: 10,
      'sudoku:race': 20,
      blackjack: 25,
      chess: 30,
      'chess:rapid': 50,
      poker: 60,
      shelem: 80,
    }
    for (const [id, baseAmount] of Object.entries(expected)) {
      const rule = await db.rewardRule.findUnique({ where: { id } })
      expect(rule?.baseAmount, `${id} base rate`).toBe(baseAmount)
    }
  })

  it('every placementJson parses and covers ranks 1..seatCount', async () => {
    const rules = await db.rewardRule.findMany({ where: { NOT: { gameSlug: null } } })
    expect(rules.length).toBeGreaterThan(0)

    for (const rule of rules) {
      const parsed = JSON.parse(rule.placementJson) as {
        draw: number
        bySeatCount: Record<string, Record<string, number>>
      }
      expect(parsed.draw, `${rule.id} draw multiplier`).toBe(1)

      const seatCounts = Object.keys(parsed.bySeatCount)
      expect(seatCounts.length, `${rule.id} declares no seat counts`).toBeGreaterThan(0)

      for (const seatCount of seatCounts) {
        const table = parsed.bySeatCount[seatCount] ?? {}
        for (let rank = 1; rank <= Number(seatCount); rank++) {
          expect(
            table[String(rank)],
            `${rule.id}: seatCount ${seatCount} is missing rank ${rank}`,
          ).toBeTypeOf('number')
        }
      }
    }
  })

  it('every repeatDecayJson parses to a descending multiplier curve', async () => {
    const rules = await db.rewardRule.findMany()
    for (const rule of rules) {
      const curve = JSON.parse(rule.repeatDecayJson) as number[]
      expect(Array.isArray(curve)).toBe(true)
      expect(curve[0]).toBe(1)
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i]!).toBeLessThanOrEqual(curve[i - 1]!)
      }
    }
  })

  it('★ contains an ejected winner: on the winning team, rank 1, earning zero', async () => {
    const ejected = await db.matchParticipant.findFirst({
      where: { outcome: 'EJECTED_TIMEOUT' },
      include: { matchResult: true },
    })

    expect(ejected, 'the ejected-winner fixture is missing').not.toBeNull()
    expect(ejected?.rewardForfeited).toBe(true)
    expect(ejected?.coinsAwarded).toBe(0)
    expect(ejected?.team).toBe(ejected?.matchResult.winningTeam)
    expect(ejected?.rank).toBe(1)
  })

  it('pays the ejected player’s partner in full — forfeiture is per seat, not per team', async () => {
    const match = await db.matchResult.findFirstOrThrow({
      where: { participants: { some: { outcome: 'EJECTED_TIMEOUT' } } },
      include: { participants: true },
    })

    const winners = match.participants.filter((p) => p.team === match.winningTeam)
    expect(winners).toHaveLength(2)
    expect(winners.filter((p) => p.coinsAwarded > 0)).toHaveLength(1)
    expect(winners.filter((p) => p.coinsAwarded === 0)).toHaveLength(1)
  })

  it('records the forfeited reward as an explanatory zero-amount row, never silence', async () => {
    const ejected = await db.matchParticipant.findFirstOrThrow({
      where: { outcome: 'EJECTED_TIMEOUT' },
    })
    const tx = await db.walletTransaction.findUniqueOrThrow({
      where: { id: ejected.rewardTxId! },
    })
    expect(tx.amount).toBe(0)
    expect(tx.kind).toBe('CAP_REJECTED')
    expect(tx.reason).toBe('EJECTED_TIMEOUT')
  })

  it('keeps balance == Σ transactions on every seeded wallet (E1)', async () => {
    const wallets = await db.wallet.findMany({ include: { transactions: true } })
    expect(wallets.length).toBeGreaterThan(0)
    for (const wallet of wallets) {
      const sum = wallet.transactions.reduce((total, tx) => total + tx.amount, 0)
      expect(sum, `wallet ${wallet.id}`).toBe(wallet.balance)
    }
  })

  it('mints the SEEDDEMO invite the guest flow is verified against', async () => {
    const invite = await db.invite.findUnique({ where: { code: 'SEEDDEMO' } })
    expect(invite).not.toBeNull()
    expect(invite?.revokedAt).toBeNull()
    expect(invite!.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('seeds catalog only under NODE_ENV=production', async () => {
    await resetDb()
    runSeed('production')

    expect(await db.cosmeticItem.count()).toBe(first.cosmetics)
    expect(await db.storeItem.count()).toBe(first.storeItems)
    expect(await db.rewardRule.count()).toBe(first.rewardRules)

    // Catalog + the admin account, and nothing that looks like play.
    expect(await db.user.count()).toBe(1)
    expect(await db.table.count()).toBe(0)
    expect(await db.invite.count()).toBe(0)
    expect(await db.matchResult.count()).toBe(0)
    expect(await db.gameInstance.count()).toBe(0)
  }, 60_000)
})
