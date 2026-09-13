import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, client, registerUser, uniqueSuffix } from '../../helpers/app.js'
import { db, resetDb } from '../../helpers/db.js'
import {
  WalletBalanceSchema,
  WalletTransactionSchema,
} from '../../../src/contracts/dto/wallet.js'
import { RewardRulesResponseSchema } from '../../../src/contracts/dto/rewards.js'
import { userRef, guestRef } from '../../../src/domain/value-objects/identity.js'

/**
 * S37 — `GET /wallet`, `/wallet/transactions`, `/rewards/rules`.
 *
 * Three access levels in one file, because the *levels* are the interesting
 * part rather than the payloads:
 *
 *   - a **guest** can read their own provisional balance, or the entire signup
 *     incentive (10 §3.4) is invisible to the person it is aimed at;
 *   - a guest cannot read a statement, because a statement is an account
 *     feature and theirs would be two unspendable rows;
 *   - **anybody at all** can read the rate card, deliberately (10 §11).
 *
 * The assertion that matters most is the last one in the statement block: a
 * `CAP_REJECTED` row is *visible*, with its reason. A capped or forfeited
 * reward that simply did not appear would be indistinguishable from a bug, and
 * a player who thinks the economy is broken stops playing.
 */

const { app, container, resetLimits } = buildTestApp()

beforeEach(async () => {
  await resetDb()
  resetLimits()
  await seedGlobalRule()
})

afterAll(async () => {
  await container.shutdown()
})

async function seedGlobalRule(): Promise<void> {
  const caps = {
    capPerHour: 400,
    capPerDay: 2_000,
    capPerDayGuest: 500,
    capMatchesPerDay: 30,
    guestVestCap: 500,
  }
  const repeatDecayJson = JSON.stringify([1, 1, 0.6, 0.3, 0.1])

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
  await db.rewardRule.create({
    data: {
      id: 'shelem',
      gameSlug: 'shelem',
      assetCode: 'COIN',
      baseAmount: 80,
      placementJson: JSON.stringify({
        draw: 1,
        bySeatCount: { '4': { '1': 1.5, '2': 1.0, '3': 0.7, '4': 0.5 } },
      }),
      expectedMinMs: 480_000,
      repeatDecayJson,
      ...caps,
    },
  })
}

/** A guest session bound to a table, plus the cookie that proves it. */
async function guestClient() {
  const host = await db.user.create({
    data: { email: `host-${uniqueSuffix()}@test.dev`, passwordHash: 'x', displayName: 'TheHost' },
  })
  const table = await db.table.create({
    data: { hostUserId: host.id, gameSlug: 'fixture', optionsJson: '{}', seatCount: 2 },
  })
  const invite = await db.invite.create({
    data: {
      tableId: table.id,
      code: `WALLET${uniqueSuffix().toUpperCase().slice(-4)}`,
      createdByUserId: host.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })

  const agent = client(app)
  const response = await agent
    .post('/api/v1/auth/guest')
    .send({ inviteCode: invite.code, displayName: 'Sara' })

  return { agent, guestSessionId: response.body.identity.guestSessionId as string, table }
}

describe('GET /wallet — level G, guests included', () => {
  it('a new user sees three VESTED wallets at zero', async () => {
    const { agent } = await registerUser(app)

    const res = await agent.get('/api/v1/wallet')

    expect(res.status).toBe(200)
    expect(res.body.balances).toHaveLength(3)
    for (const balance of res.body.balances) {
      expect(() => WalletBalanceSchema.parse(balance)).not.toThrow()
      expect(balance).toMatchObject({ balance: 0, status: 'VESTED' })
    }
  })

  it('★ a guest sees a PROVISIONAL balance — the signup pitch has something to say', async () => {
    const { agent, guestSessionId } = await guestClient()
    await container.wallets.credit({
      holder: guestRef(guestSessionId),
      asset: 'COIN',
      amount: 120,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'match:test:0',
    })

    const res = await agent.get('/api/v1/wallet')

    expect(res.status).toBe(200)
    // COIN only. Gems and tickets are not earnable, so a guest has no use for
    // two rows that will always read zero.
    expect(res.body.balances).toHaveLength(1)
    expect(res.body.balances[0]).toMatchObject({
      asset: 'COIN',
      balance: 120,
      status: 'PROVISIONAL',
    })
  })

  it('refuses an anonymous caller — there is no wallet without an identity', async () => {
    const res = await request(app).get('/api/v1/wallet')
    expect(res.status).toBe(401)
  })

  it('carries no wallet id — an internal handle has no business on the wire', async () => {
    const { agent } = await registerUser(app)
    const res = await agent.get('/api/v1/wallet')

    expect(JSON.stringify(res.body)).not.toMatch(/walletId|"id"/)
  })
})

describe('GET /wallet/transactions — level U', () => {
  it('★ a guest is refused: a statement is an account feature', async () => {
    const { agent } = await guestClient()
    const res = await agent.get('/api/v1/wallet/transactions')

    // 403, not 401: "refresh and retry" is advice a guest can never act on.
    expect(res.status).toBe(403)
  })

  it('returns the ledger newest first, with balanceAfter on every row', async () => {
    const { agent, response } = await registerUser(app)
    const holder = userRef(response.body.identity.userId as string)

    for (const amount of [50, 30, 20]) {
      await container.wallets.credit({
        holder,
        asset: 'COIN',
        amount,
        kind: 'MATCH_REWARD',
        idempotencyKey: `match:m${String(amount)}:0`,
      })
    }

    const res = await agent.get('/api/v1/wallet/transactions?limit=10')

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(3)
    for (const row of res.body.items) {
      expect(() => WalletTransactionSchema.parse(row)).not.toThrow()
    }
    // Newest first, and the running balance reads downward consistently.
    expect(res.body.items.map((row: { amount: number }) => row.amount)).toEqual([20, 30, 50])
    expect(res.body.items.map((row: { balanceAfter: number }) => row.balanceAfter)).toEqual([
      100, 80, 50,
    ])
  })

  it('pagination is stable — the cursor never repeats or skips a row', async () => {
    const { agent, response } = await registerUser(app)
    const holder = userRef(response.body.identity.userId as string)

    for (let index = 0; index < 7; index += 1) {
      await container.wallets.credit({
        holder,
        asset: 'COIN',
        amount: 10,
        kind: 'MATCH_REWARD',
        idempotencyKey: `match:page${String(index)}:0`,
      })
    }

    const first = await agent.get('/api/v1/wallet/transactions?limit=3')
    expect(first.body.items).toHaveLength(3)
    expect(first.body.nextCursor).not.toBeNull()

    const second = await agent.get(
      `/api/v1/wallet/transactions?limit=3&cursor=${String(first.body.nextCursor)}`,
    )
    const ids = new Set([
      ...first.body.items.map((row: { id: string }) => row.id),
      ...second.body.items.map((row: { id: string }) => row.id),
    ])
    expect(ids.size).toBe(6)
  })

  it('★ a CAP_REJECTED row is VISIBLE, with its reason — a forfeit is not silence', async () => {
    const { agent, response } = await registerUser(app)
    const holder = userRef(response.body.identity.userId as string)

    await container.wallets.credit({
      holder,
      asset: 'COIN',
      amount: 0,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'match:forfeit:1',
      reason: 'EJECTED_TIMEOUT',
    })

    const res = await agent.get('/api/v1/wallet/transactions')

    expect(res.body.items[0]).toMatchObject({
      kind: 'CAP_REJECTED',
      amount: 0,
      reason: 'EJECTED_TIMEOUT',
    })
  })

  it('rejects an unknown query parameter rather than ignoring it (P7)', async () => {
    const { agent } = await registerUser(app)
    const res = await agent.get('/api/v1/wallet/transactions?holder=someone-else')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })
})

describe('GET /rewards/rules — level P, public on purpose (10 §11)', () => {
  it('★ needs no cookie at all', async () => {
    const res = await request(app).get('/api/v1/rewards/rules')

    expect(res.status).toBe(200)
    expect(() => RewardRulesResponseSchema.parse(res.body)).not.toThrow()
  })

  it('publishes every factor a player can check their own payout against', async () => {
    const res = await request(app).get('/api/v1/rewards/rules')

    const shelem = res.body.rules.find((rule: { id: string }) => rule.id === 'shelem')
    expect(shelem).toMatchObject({ base: 80, expectedMinMs: 480_000 })
    expect(shelem.placement.bySeatCount['4']['1']).toBe(1.5)
    expect(shelem.repeatDecay).toEqual([1, 1, 0.6, 0.3, 0.1])

    expect(res.body.caps).toMatchObject({ perHour: 400, perDay: 2_000, perDayGuest: 500 })
    expect(res.body.premiumMultiplier).toBe(1.5)
  })

  it('★ publishes the integrity factors — forfeiture is a published rule (§5.1)', () => {
    return request(app)
      .get('/api/v1/rewards/rules')
      .expect(200)
      .then((res) => {
        expect(res.body.integrityFactors).toMatchObject({
          COMPLETED: 1,
          EJECTED_TIMEOUT: 0,
          EJECTED_ABANDON: 0,
          RESIGNED: 0.25,
          REPLACED_RETURNED: 0.5,
          BOT: 0,
        })
      })
  })

  it('★ withholds the internal cap internals — guestVestCap is not a rate', async () => {
    const res = await request(app).get('/api/v1/rewards/rules')

    expect(JSON.stringify(res.body)).not.toMatch(/guestVestCap/)
    // And the `_global` row is not rendered as a game paying 0.
    expect(res.body.rules.some((rule: { id: string }) => rule.id === '_global')).toBe(false)
  })

  it('reads from the database, so a rebalance needs no deploy (10 §3)', async () => {
    await db.rewardRule.update({ where: { id: 'shelem' }, data: { baseAmount: 95 } })

    const res = await request(app).get('/api/v1/rewards/rules')
    const shelem = res.body.rules.find((rule: { id: string }) => rule.id === 'shelem')
    expect(shelem.base).toBe(95)
  })
})
