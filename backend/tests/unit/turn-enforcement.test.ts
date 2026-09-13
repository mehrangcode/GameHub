import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TURN_ENFORCEMENT,
  TurnEnforcementSchema,
} from '../../src/contracts/dto/turnEnforcement.js'
import {
  reclaimDeadline,
  withTurnEnforcementDefaults,
} from '../../src/application/policies/turnEnforcement.js'
import { integrityFactorOf, seatOutcomeOf } from '../../src/application/mappers/outcomes.js'
import { turnTimeoutFor } from '../../src/application/services/TurnTimerService.js'
import { narrationKindOf } from '../../src/application/services/GameSessionService.js'
import type { GameEvent } from '../../src/domain/entities/game.js'
import type { TableMember } from '../../src/domain/entities/table.js'
import type { GameMeta } from '../../src/domain/games/GameEngine.js'
import { fixtureMeta } from '../../src/domain/games/_fixture/meta.js'
import { seatId } from '../../src/domain/value-objects/seat.js'

/**
 * The pure half of Phase H — S31–S34.
 *
 * Everything here is a function of its arguments, so the interesting cases are
 * cheap: the boundary of a strike ladder, a reclaim window of zero, a returned
 * player whose ejection is still in the log. The timers, the sockets and the
 * database are in the integration suite; this is the part that must be right
 * before any of that is worth running.
 */

function member(patch: Partial<TableMember> = {}): TableMember {
  return {
    id: 'mem1',
    tableId: 'tbl1',
    userId: 'usr1',
    guestSessionId: null,
    isBot: false,
    botDifficulty: null,
    seat: seatId(1),
    role: 'PLAYER',
    team: null,
    joinedAt: new Date(),
    leftAt: null,
    disconnectedAt: null,
    timeoutStrikes: 0,
    ejectedAt: null,
    ejectionReason: null,
    reclaimableUntil: null,
    botSubstituted: false,
    ...patch,
  }
}

function event(patch: Partial<GameEvent> = {}): GameEvent {
  return {
    id: 'evt1',
    gameId: 'gam1',
    seq: 1,
    kind: 'MOVE',
    seat: seatId(1),
    actorUserId: null,
    actorGuestId: null,
    clientMoveId: null,
    payload: {},
    createdAt: new Date(),
    ...patch,
  }
}

describe('turnEnforcement options (04 §6.3)', () => {
  it('★ defaults to TWO strikes, not one — the deliberate softening of the literal rule', () => {
    // 04 §6.3: a single 30-second lapse would eject somebody from a 45-minute
    // Shelem match. If this ever flips to 1 by accident, long games become
    // unplayable for anyone with a doorbell.
    expect(DEFAULT_TURN_ENFORCEMENT.ejectAfterStrikes).toBe(2)
    expect(DEFAULT_TURN_ENFORCEMENT.warningSeconds).toBe(10)
    expect(DEFAULT_TURN_ENFORCEMENT.strikesResetOnAction).toBe(true)
    expect(DEFAULT_TURN_ENFORCEMENT.reclaimWindowSec).toBe(120)
  })

  it('★ the literal and the schema agree — the pin that lets contracts/ stay pure', () => {
    // `DEFAULT_TURN_ENFORCEMENT` is written out by hand because `contracts/`
    // executes nothing at import time (tests/unit/contracts-purity.test.ts).
    // This is what stops the literal and the schema's own `.default()` calls
    // from drifting into two different answers to "what does a table get?".
    expect(DEFAULT_TURN_ENFORCEMENT).toEqual(TurnEnforcementSchema.parse({}))
  })

  it('★ the literal rule is one field — ejectAfterStrikes: 1', () => {
    expect(withTurnEnforcementDefaults({ ejectAfterStrikes: 1 })).toEqual({
      ...DEFAULT_TURN_ENFORCEMENT,
      ejectAfterStrikes: 1,
    })
  })

  it('★ a partial patch keeps the fields it did not name', () => {
    // The bug this prevents: a host who changes one setting next month and
    // silently loses the warning window they chose today.
    const current = withTurnEnforcementDefaults({ warningSeconds: 5, reclaimWindowSec: 300 })
    const patched = withTurnEnforcementDefaults({ ejectAfterStrikes: 1 }, current)

    expect(patched).toEqual({
      ejectAfterStrikes: 1,
      warningSeconds: 5,
      strikesResetOnAction: true,
      reclaimWindowSec: 300,
    })
  })

  it('rejects unknown keys rather than ignoring them', () => {
    expect(() => TurnEnforcementSchema.parse({ ejectAfterStrikes: 2, ejectAfter: 1 })).toThrow()
  })

  it('refuses a strike limit outside 1..5 and a window outside 0..600', () => {
    expect(() => TurnEnforcementSchema.parse({ ejectAfterStrikes: 0 })).toThrow()
    expect(() => TurnEnforcementSchema.parse({ ejectAfterStrikes: 6 })).toThrow()
    expect(() => TurnEnforcementSchema.parse({ reclaimWindowSec: 601 })).toThrow()
    expect(() => TurnEnforcementSchema.parse({ warningSeconds: 31 })).toThrow()
  })

  it('a zero reclaim window means the bot keeps the seat immediately', () => {
    const now = new Date('2026-09-12T10:00:00.000Z')
    expect(reclaimDeadline(now, withTurnEnforcementDefaults({ reclaimWindowSec: 0 }))).toBeNull()
    expect(reclaimDeadline(now, DEFAULT_TURN_ENFORCEMENT)?.toISOString()).toBe(
      '2026-09-12T10:02:00.000Z',
    )
  })
})

describe('turnTimeoutFor (04 §6.1)', () => {
  const withPhases: GameMeta = {
    ...fixtureMeta,
    turnTimeoutMs: 30_000,
    turnTimeoutByPhaseMs: { BIDDING: 45_000 },
  }

  it('★ a per-phase override beats the default — Shelem bids for 45 s and plays for 30', () => {
    expect(turnTimeoutFor(withPhases, 'BIDDING')).toBe(45_000)
    expect(turnTimeoutFor(withPhases, 'PLAYING')).toBe(30_000)
    expect(turnTimeoutFor(withPhases, null)).toBe(30_000)
  })

  it('★ a game with turnTimeoutMs: null is untimed, in every phase', () => {
    // Sudoku is a solo puzzle and Chess has its own clock. Arming a deadline
    // for either would eject a player for thinking.
    const untimed: GameMeta = { ...fixtureMeta, turnTimeoutMs: null }
    expect(turnTimeoutFor(untimed, 'PLAYING')).toBeNull()
    expect(turnTimeoutFor(untimed, null)).toBeNull()
  })
})

describe('seatOutcomeOf (03 §3.5, 10 §5.1)', () => {
  it('★ EJECTED_TIMEOUT and EJECTED_ABANDON stay distinct', () => {
    // 04 §5.2 warns against conflating the two timers, and 10 §5.1 pays them
    // differently. One `EJECTED` value would erase that difference forever.
    expect(seatOutcomeOf(member({ ejectedAt: new Date(), ejectionReason: 'TURN_TIMEOUT' }))).toBe(
      'EJECTED_TIMEOUT',
    )
    expect(seatOutcomeOf(member({ ejectedAt: new Date(), ejectionReason: 'ABANDON' }))).toBe(
      'EJECTED_ABANDON',
    )
    expect(seatOutcomeOf(member({ ejectedAt: new Date(), ejectionReason: 'KICKED' }))).toBe(
      'KICKED',
    )
  })

  it('★ a returned player is REPLACED_RETURNED even though the ejection is still logged', () => {
    // The member row is *cleared* by a reclaim, so the log is the only record
    // that they ever left — and being paid 0.5× rather than 0 is the whole
    // incentive to come back (04 §6.4).
    const returned = [
      event({ kind: 'SYSTEM', payload: { system: 'BOT_TOOK_OVER', ejection: true } }),
      event({ seq: 9, kind: 'SYSTEM', payload: { system: 'PLAYER_RETURNED' } }),
    ]
    expect(seatOutcomeOf(member(), returned)).toBe('REPLACED_RETURNED')
  })

  it('a return at another seat does not rescue this one', () => {
    const elsewhere = [
      event({ seat: seatId(3), kind: 'SYSTEM', payload: { system: 'PLAYER_RETURNED' } }),
    ]
    expect(
      seatOutcomeOf(member({ ejectedAt: new Date(), ejectionReason: 'ABANDON' }), elsewhere),
    ).toBe('EJECTED_ABANDON')
  })

  it('a bot seat is BOT, and a struck-but-present player is COMPLETED', () => {
    expect(seatOutcomeOf(member({ isBot: true, userId: null }))).toBe('BOT')
    // ★ A strike is not an outcome. Timing out once and playing on costs
    // nothing at settlement.
    expect(seatOutcomeOf(member({ timeoutStrikes: 1 }))).toBe('COMPLETED')
  })
})

describe('integrityFactorOf (04 §6.4, 10 §5.1)', () => {
  it('★ an ejected seat earns zero, a returned seat earns half, everyone else earns full', () => {
    expect(integrityFactorOf('EJECTED_TIMEOUT')).toBe(0)
    expect(integrityFactorOf('EJECTED_ABANDON')).toBe(0)
    expect(integrityFactorOf('REPLACED_RETURNED')).toBe(0.5)
    expect(integrityFactorOf('COMPLETED')).toBe(1)
  })

  it('★ coming back is strictly better than staying away, and worse than never leaving', () => {
    // The three-way inequality *is* the incentive design of 04 §6.4. Written as
    // a comparison rather than three literals so the property survives a
    // rebalance of the numbers themselves.
    expect(integrityFactorOf('EJECTED_TIMEOUT')).toBeLessThan(
      integrityFactorOf('REPLACED_RETURNED'),
    )
    expect(integrityFactorOf('REPLACED_RETURNED')).toBeLessThan(integrityFactorOf('COMPLETED'))
  })
})

describe('narrationKindOf (03 §4 vs 04 §5.2/§6.2)', () => {
  it('★ a TIMEOUT row is stored as TIMEOUT and narrated as TURN_TIMEOUT', () => {
    // Both documents are right: the log keeps the six kinds 03 §4 fixes, and
    // the client is told the ten names 04 narrates. This is the only place the
    // two vocabularies meet.
    expect(narrationKindOf(event({ kind: 'TIMEOUT', payload: { move: { kind: 'pass' } } }))).toBe(
      'TURN_TIMEOUT',
    )
  })

  it('★ a SYSTEM row is narrated by its discriminator', () => {
    expect(narrationKindOf(event({ kind: 'SYSTEM', payload: { system: 'BOT_TOOK_OVER' } }))).toBe(
      'BOT_TOOK_OVER',
    )
    expect(narrationKindOf(event({ kind: 'SYSTEM', payload: { system: 'PLAYER_RETURNED' } }))).toBe(
      'PLAYER_RETURNED',
    )
    expect(narrationKindOf(event({ kind: 'SYSTEM', payload: { system: 'SEAT_ABANDONED' } }))).toBe(
      'SEAT_ABANDONED',
    )
  })

  it('an unrecognised discriminator falls back to the stored kind', () => {
    expect(narrationKindOf(event({ kind: 'SYSTEM', payload: { system: 'WHATEVER' } }))).toBe(
      'SYSTEM',
    )
    expect(narrationKindOf(event({ kind: 'MOVE' }))).toBe('MOVE')
  })
})

describe('the fixture engine as a turn-enforcement fixture', () => {
  it('★ its default action is PASS, never PRESS — a strike costs the turn, not the match', () => {
    // 04 §6.5's rule, in the one game M0 has: a press is the only move that can
    // win, so applying one on somebody's behalf would spend a resource they
    // never authorised. The per-game version of this assertion is what M2 and
    // M5 reuse for "never auto-hit" and "never auto-call".
    const playing = { phase: 'PLAYING', toAct: 1 }
    expect(fixtureMeta.defaultActionOnTimeout(playing, seatId(1))).toEqual({ kind: 'pass' })
  })

  it('★ and it returns null when it is not that seat’s turn', () => {
    expect(fixtureMeta.defaultActionOnTimeout({ phase: 'PLAYING', toAct: 0 }, seatId(1))).toBeNull()
    expect(
      fixtureMeta.defaultActionOnTimeout({ phase: 'FINISHED', toAct: null }, seatId(1)),
    ).toBeNull()
  })
})
