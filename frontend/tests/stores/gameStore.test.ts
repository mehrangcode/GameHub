import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GameStatePayload } from '../../src/contracts/events'
import { useGameStore } from '../../src/stores/gameStore'

/**
 * S42 — `seq` handling and the no-derivation rule.
 *
 * Two properties are under test, and the second is the more important:
 *
 *   1. stale payloads are dropped, wide gaps ask for a resync;
 *   2. ★ **the store derives nothing.** `gameStore` holds the server's
 *      projection verbatim. The last test in this file reads its own source and
 *      fails if anyone adds arithmetic to it — crude, and it is the only thing
 *      that catches "I just needed the remaining card count" before it ships.
 */

function state(seq: number, extra: Partial<GameStatePayload> = {}): GameStatePayload {
  return {
    gameId: 'g1',
    tableId: 't1',
    seq,
    phase: 'play',
    view: { secret: seq },
    toAct: 0,
    legalMoves: [{ kind: 'press' }],
    isTerminal: false,
    serverTime: Date.now(),
    ...extra,
  }
}

beforeEach(() => {
  useGameStore.getState().reset()
})

describe('seq handling', () => {
  it('applies a newer state and advances seq', () => {
    const resync = useGameStore.getState().applyServerState(state(1))

    expect(resync).toBe(false)
    expect(useGameStore.getState().seq).toBe(1)
    expect(useGameStore.getState().view).toEqual({ secret: 1 })
  })

  it('★ drops a stale payload silently — the view does not go backwards', () => {
    useGameStore.getState().applyServerState(state(5))
    const resync = useGameStore.getState().applyServerState(state(3))

    expect(resync).toBe(false)
    expect(useGameStore.getState().seq).toBe(5)
    // A resync that overlaps live traffic legitimately delivers an older state
    // after a newer one. Applying it would rewind the board under the player.
    expect(useGameStore.getState().view).toEqual({ secret: 5 })
  })

  it('drops an exact duplicate', () => {
    useGameStore.getState().applyServerState(state(4))

    expect(useGameStore.getState().applyServerState(state(4))).toBe(false)
    expect(useGameStore.getState().seq).toBe(4)
  })

  it('★ a hole of ONE does not resync — that is a skipped timer event, not a loss', () => {
    useGameStore.getState().applyServerState(state(1))
    const resync = useGameStore.getState().applyServerState(state(3))

    // The server persists a turn deadline as an event and deliberately does
    // not narrate it (`isTimerEvent`), so a one-number hole happens once per
    // turn. Resyncing on it would mean a resync storm for the whole match.
    expect(resync).toBe(false)
    expect(useGameStore.getState().seq).toBe(3)
  })

  it('★ a wider gap asks for a resync and shows the syncing state', () => {
    useGameStore.getState().applyServerState(state(1))
    const resync = useGameStore.getState().applyServerState(state(9))

    expect(resync).toBe(true)
    expect(useGameStore.getState().syncing).toBe(true)
    // The state is still applied: it is a complete projection, and the newest
    // truth beats waiting for a backfill of narration.
    expect(useGameStore.getState().seq).toBe(9)
  })

  it('a gap in the narration stream also asks for a resync', () => {
    useGameStore.getState().applyServerState(state(1))

    const resync = useGameStore.getState().appendNarration({
      gameId: 'g1',
      tableId: 't1',
      seq: 12,
      kind: 'MOVE',
      seat: 0,
      descriptor: { key: 'games.event.move', params: {} },
    })

    expect(resync).toBe(true)
  })

  it('narration accumulates in order and is bounded', () => {
    for (let seq = 1; seq <= 250; seq += 1) {
      useGameStore.getState().appendNarration({
        gameId: 'g1',
        tableId: 't1',
        seq,
        kind: 'MOVE',
        seat: 0,
        descriptor: { key: 'games.event.move', params: {} },
      })
    }

    const { narration } = useGameStore.getState()
    expect(narration.length).toBeLessThanOrEqual(200)
    expect(narration.at(-1)?.seq).toBe(250)
  })
})

describe('turn timer', () => {
  it('★ stores the deadline as an absolute instant, not a duration', () => {
    const endsAt = new Date('2030-01-01T00:00:30Z')

    useGameStore.getState().applyTurnTimer({
      gameId: 'g1',
      tableId: 't1',
      seat: 2,
      endsAt: endsAt.toISOString(),
      strikes: 1,
      ejectAfterStrikes: 2,
      serverTime: Date.now(),
    })

    // A duration would silently become wrong the moment the tab is
    // backgrounded and the timer throttled.
    expect(useGameStore.getState().turnEndsAt).toBe(endsAt.getTime())
    expect(useGameStore.getState().strikes).toBe(1)
  })

  it('a fresh deadline clears the previous ejection warning', () => {
    useGameStore.getState().applyWarning(10, 'EJECTION_NO_REWARD')
    useGameStore.getState().applyTurnTimer({
      gameId: 'g1',
      tableId: 't1',
      seat: 0,
      endsAt: new Date().toISOString(),
      strikes: 0,
      ejectAfterStrikes: 2,
      serverTime: Date.now(),
    })

    expect(useGameStore.getState().ejectionWarning).toBeNull()
  })

  it('★ a reclaim clears the ejection; a plain outcome does not', () => {
    useGameStore.getState().applyEjection({
      gameId: 'g1',
      tableId: 't1',
      seat: 1,
      reason: 'TURN_TIMEOUT',
      replacedByBot: true,
      reclaimableUntil: new Date(Date.now() + 120_000).toISOString(),
      strikes: 2,
    })
    expect(useGameStore.getState().ejected).not.toBeNull()

    useGameStore.getState().applyReturn({
      gameId: 'g1',
      tableId: 't1',
      seat: 1,
      outcome: 'REPLACED_RETURNED',
      rewardFactor: 0.5,
    })

    expect(useGameStore.getState().ejected).toBeNull()
  })
})

describe('★ the no-derivation rule (P1)', () => {
  // `import.meta.url` is an http:// URL under Vitest's jsdom transform, so the
  // path is resolved from the project root instead.
  const source = readFileSync(path.resolve('src/stores/gameStore.ts'), 'utf8')
  const body = source.slice(source.indexOf('export const useGameStore'))

  it('computes no scores, counts or turn order', () => {
    // Each of these is a rules engine in the client wearing a helper's name.
    // The server supplies `view.scores`, `view.deckCount`, `toAct` and
    // `legalMoves`; if you need something else, the fix is a field on the
    // projection, never a computation here.
    expect(body).not.toMatch(/\.reduce\(/)
    expect(body).not.toMatch(/52\s*-/)
    expect(body).not.toMatch(/%\s*4/)
    expect(body).not.toMatch(/\btrump\b/)
    expect(body).not.toMatch(/\bhasSuit\b|\bcardPoints\b|\blegalFor\b/)
  })

  it('stores `view` by reference, without touching it', () => {
    const view = { hand: ['AS', 'KD'], deckCount: 30 }
    useGameStore.getState().applyServerState(state(1, { view }))

    // Identity, not deep equality: anything that rebuilt or augmented the
    // object would fail here, which is the point.
    expect(useGameStore.getState().view).toBe(view)
  })

  it('stores `legalMoves` exactly as sent, including null for a non-acting seat', () => {
    useGameStore.getState().applyServerState(state(1, { legalMoves: null }))

    expect(useGameStore.getState().legalMoves).toBeNull()
  })
})
