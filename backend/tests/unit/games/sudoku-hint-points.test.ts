import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { MetricsRegistry } from '../../../src/application/services/MetricsRegistry.js'
import { WalletService } from '../../../src/application/services/WalletService.js'
import {
  HINT_POINT_CAP,
  SOLVES_PER_HINT_POINT,
  SOLVES_STAT_KEY,
  SudokuHintService,
} from '../../../src/application/services/SudokuHintService.js'
import { hintGrantKey, hintSpendKey } from '../../../src/domain/economy/idempotency.js'
import { ForbiddenError } from '../../../src/domain/errors/errors.js'
import type { GameInstance } from '../../../src/domain/entities/game.js'
import { sudokuEngine, type SudokuState } from '../../../src/domain/games/sudoku/engine.js'
import { sudokuMeta } from '../../../src/domain/games/sudoku/meta.js'
import { DEAL_RNG_KEY, gameRng } from '../../../src/domain/games/shared/rng.js'
import { guestRef, userRef } from '../../../src/domain/value-objects/identity.js'
import { seatId } from '../../../src/domain/value-objects/seat.js'
import {
  InMemoryUnitOfWork,
  buildInMemoryRepositories,
  type InMemoryRepositories,
} from '../../fakes/index.js'

/**
 * ★ Hint points — `games/sudoku.md` §13, cases 9c–9h of §10.
 *
 * The engine's own suite proves a hint *behaves* correctly; this one proves it
 * is *paid for* correctly, which is the half that touches the ledger and so the
 * half where a bug is expensive.
 */

const silent = pino({ level: 'silent' })
const USER = userRef('user-sudoku')

let repos: InMemoryRepositories
let uow: InMemoryUnitOfWork
let wallets: WalletService
let hints: SudokuHintService

beforeEach(() => {
  repos = buildInMemoryRepositories()
  uow = new InMemoryUnitOfWork(repos)
  const metrics = new MetricsRegistry()
  wallets = new WalletService({ uow, repos, metrics, logger: silent })
  hints = new SudokuHintService({ wallets, metrics, logger: silent })
  extra = null
  matchNo = 0
})

function state(options: Record<string, unknown> = {}): SudokuState {
  return sudokuEngine.createInitialState(
    {
      seats: [seatId(0)],
      options: sudokuMeta.optionsSchema.parse(options) as Record<string, unknown>,
    },
    gameRng('hint-points-seed', DEAL_RNG_KEY),
  )
}

function instance(overrides: Partial<GameInstance> = {}): GameInstance {
  return {
    id: 'game-1',
    tableId: 'table-1',
    gameSlug: 'sudoku',
    status: 'ACTIVE',
    rngSeed: 'seed',
    seedCommit: 'commit',
    seedRevealedAt: null,
    seq: 0,
    seating: [
      {
        seat: seatId(0),
        userId: USER.userId,
        guestSessionId: null,
        isBot: false,
        displayName: 'Player',
        team: null,
      },
    ],
    options: {},
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: null,
    ...overrides,
  } as GameInstance
}

async function balance(): Promise<number> {
  return (await repos.wallets.findByHolder(USER, 'HINT'))?.balance ?? 0
}

/**
 * The player's running stats blob, carried between calls exactly as the
 * `PlayerStats` row would be. Module-level rather than local to `solveTimes`
 * because the milestone is a function of the *lifetime* count — a helper that
 * restarted at zero on each call would re-derive milestone 1, collide on the
 * idempotency key, and look like a passing cap test for entirely the wrong
 * reason.
 */
let extra: Record<string, unknown> | null = null
let matchNo = 0

/** Settle `n` solved puzzles through the hook, as settlement would. */
async function solveTimes(n: number): Promise<Record<string, unknown> | null> {
  const hook = hints.asSettlementHook()

  for (let i = 0; i < n; i++) {
    matchNo++
    extra = await uow.run(async (r) =>
      hook.onSeatSettled({
        repos: r,
        instance: instance(),
        result: { summary: { perSeat: { '0': { solvedOrder: 1 } } } },
        matchResultId: `match-${matchNo}`,
        seat: seatId(0),
        holder: USER,
        previousExtra: extra,
      }),
    )
  }
  return extra
}

describe('sudoku hint points · earning (§13.1)', () => {
  it('grants one point every third solve (§10 case 9c)', async () => {
    // Solve 1..6, checking the balance after each: the 3rd and the 6th pay.
    const expected = [0, 0, 1, 1, 1, 2]
    for (const [i, want] of expected.entries()) {
      await solveTimes(1)
      expect(await balance(), `after solve ${i + 1}`).toBe(want)
    }
  })

  it('the counter and the balance move together over nine solves', async () => {
    const extra = await solveTimes(9)
    expect(extra?.[SOLVES_STAT_KEY]).toBe(9)
    expect(await balance()).toBe(9 / SOLVES_PER_HINT_POINT)
  })

  it('an unsolved match advances neither the counter nor the balance', async () => {
    const hook = hints.asSettlementHook()
    const extra = await uow.run(async (r) =>
      hook.onSeatSettled({
        repos: r,
        instance: instance(),
        result: { summary: { perSeat: { '0': { solvedOrder: null } } } },
        matchResultId: 'match-gaveup',
        seat: seatId(0),
        holder: USER,
        previousExtra: { [SOLVES_STAT_KEY]: 2 },
      }),
    )

    expect(extra).toBeNull()
    expect(await balance()).toBe(0)
  })

  it('★ a replayed settlement does not grant twice (§10 case 9d)', async () => {
    await solveTimes(3)
    expect(await balance()).toBe(1)

    // The same milestone, recomputed — as a settlement replay would.
    await uow.run(async (r) => hints.grantForSolve(r, USER, 3, 'match-3'))
    await uow.run(async (r) => hints.grantForSolve(r, USER, 3, 'match-3-again'))

    expect(await balance()).toBe(1)
  })

  it('the key is derived from the milestone, not the match', () => {
    expect(hintGrantKey('u1', 4)).toBe('sudoku-hint:u1:4')
    expect(hintSpendKey('g1', 2, 17)).toBe('sudoku-hint-spend:g1:2:17')
  })

  it('★ a grant beyond the cap writes a CAP_REJECTED row (§10 case 9g)', async () => {
    await solveTimes(SOLVES_PER_HINT_POINT * HINT_POINT_CAP)
    expect(await balance()).toBe(HINT_POINT_CAP)

    await solveTimes(SOLVES_PER_HINT_POINT)
    expect(await balance()).toBe(HINT_POINT_CAP)

    const wallet = await repos.wallets.findByHolder(USER, 'HINT')
    const rows = await repos.wallets.listTransactions(wallet?.id ?? '', { limit: 100 })
    const capped = rows.filter((row) => row.kind === 'CAP_REJECTED')
    // Never silence: the ledger answers "why did I not get a point?".
    expect(capped.length).toBeGreaterThan(0)
    expect(capped[0]?.amount).toBe(0)
    expect(capped[0]?.reason).toContain('CAP_HINT_POINTS')
  })

  it('a guest earns nothing (§13.1)', async () => {
    const hook = hints.asSettlementHook()
    const extra = await uow.run(async (r) =>
      hook.onSeatSettled({
        repos: r,
        instance: instance(),
        result: { summary: { perSeat: { '0': { solvedOrder: 1 } } } },
        matchResultId: 'match-guest',
        seat: seatId(0),
        holder: guestRef('guest-1'),
        previousExtra: null,
      }),
    )
    expect(extra).toBeNull()
  })
})

describe('sudoku hint points · spending (§13.3)', () => {
  it('spends the free allowance before any point', async () => {
    const funding = await uow.run(async (r) =>
      hints.authorizeHint({
        repos: r,
        instance: instance(),
        state: state({ maxHints: 3 }),
        seat: seatId(0),
        inputSeq: 1,
      }),
    )
    expect(funding).toBe('FREE')
    expect(await balance()).toBe(0)
  })

  it('debits one point once the free allowance is gone', async () => {
    await solveTimes(3)
    expect(await balance()).toBe(1)

    const funding = await uow.run(async (r) =>
      hints.authorizeHint({
        repos: r,
        instance: instance(),
        state: state({ maxHints: 0 }),
        seat: seatId(0),
        inputSeq: 1,
      }),
    )

    expect(funding).toBe('POINT')
    expect(await balance()).toBe(0)
  })

  it('★ refuses with no free hints and no points, writing nothing (§10 case 9e)', async () => {
    await expect(
      uow.run(async (r) =>
        hints.authorizeHint({
          repos: r,
          instance: instance(),
          state: state({ maxHints: 0 }),
          seat: seatId(0),
          inputSeq: 1,
        }),
      ),
    ).rejects.toThrow()

    expect(await balance()).toBe(0)
    const wallet = await repos.wallets.findByHolder(USER, 'HINT')
    if (wallet !== null && wallet !== undefined) {
      const rows = await repos.wallets.listTransactions(wallet.id, { limit: 10 })
      expect(rows).toHaveLength(0)
    }
  })

  it('refuses when the table disables hint points', async () => {
    await solveTimes(3)
    await expect(
      uow.run(async (r) =>
        hints.authorizeHint({
          repos: r,
          instance: instance(),
          state: state({ maxHints: 0, allowHintPoints: false }),
          seat: seatId(0),
          inputSeq: 1,
        }),
      ),
    ).rejects.toThrow(ForbiddenError)
    expect(await balance()).toBe(1)
  })

  it('★ a guest is told to make an account, not that they are broke (§10 case 9h)', async () => {
    const guestInstance = instance({
      seating: [
        {
          seat: seatId(0),
          userId: null,
          guestSessionId: 'guest-1',
          isBot: false,
          displayName: 'Guest',
          team: null,
        },
      ],
    })

    await expect(
      uow.run(async (r) =>
        hints.authorizeHint({
          repos: r,
          instance: guestInstance,
          state: state({ maxHints: 0 }),
          seat: seatId(0),
          inputSeq: 1,
        }),
      ),
    ).rejects.toThrow(/account/i)

    // And no HINT wallet was conjured for them along the way.
    expect(await repos.wallets.findByHolder(guestRef('guest-1'), 'HINT')).toBeNull()
  })

  it('★ charges nothing when the grid is contradicted (§13.3)', async () => {
    await solveTimes(3)
    const live = state({ maxHints: 0 })

    // Enter a wrong digit, so no technique can prove a next move.
    const index = live.puzzle.indexOf('0')
    const correct = Number(live.solution[index])
    const wrong = correct === 9 ? 1 : correct + 1
    const contradicted = sudokuEngine.applyMove(
      live,
      seatId(0),
      { type: 'SET_CELL', index, value: wrong },
      gameRng('x', 1),
    ).state

    const funding = await uow.run(async (r) =>
      hints.authorizeHint({
        repos: r,
        instance: instance(),
        state: contradicted,
        seat: seatId(0),
        inputSeq: 2,
      }),
    )

    expect(funding).toBe('FREE')
    // ★ The point survives: a hint that cannot be given is never paid for.
    expect(await balance()).toBe(1)
  })

  it('a retried move under the same seq charges once', async () => {
    await solveTimes(6)
    expect(await balance()).toBe(2)

    for (let attempt = 0; attempt < 2; attempt++) {
      await uow.run(async (r) =>
        hints.authorizeHint({
          repos: r,
          instance: instance(),
          state: state({ maxHints: 0 }),
          seat: seatId(0),
          inputSeq: 7,
        }),
      )
    }

    expect(await balance()).toBe(1)
  })
})

describe('sudoku hint points · the move authorizer', () => {
  it('overwrites any funding a client supplies', async () => {
    const authorizer = hints.asMoveAuthorizer()
    const applied = await uow.run(async (r) =>
      authorizer.authorize({
        repos: r,
        instance: instance(),
        state: state({ maxHints: 3 }),
        seat: seatId(0),
        // A hostile client claiming a point-funded hint it never paid for.
        move: { type: 'HINT', funding: 'POINT' },
        inputSeq: 1,
      }),
    )

    expect(applied).toEqual({ type: 'HINT', funding: 'FREE' })
  })

  it('leaves every other move untouched', async () => {
    const authorizer = hints.asMoveAuthorizer()
    const move = { type: 'SET_CELL', index: 4, value: 7 }
    const applied = await uow.run(async (r) =>
      authorizer.authorize({
        repos: r,
        instance: instance(),
        state: state(),
        seat: seatId(0),
        move,
        inputSeq: 1,
      }),
    )

    expect(applied).toBe(move)
  })
})
