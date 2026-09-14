import { create } from 'zustand'
import type {
  GameFinishedPayload,
  GameNarrationPayload,
  GamePlayerEjectedPayload,
  GamePlayerReturnedPayload,
  GameRewardSettledPayload,
  GameStartedPayload,
  GameStatePayload,
  GameTurnTimerPayload,
} from '@/contracts/events'

/**
 * ★ The server's projection, verbatim — 06 §3.2.
 *
 * This store holds what arrived and derives **nothing**. Every one of these is
 * a P1 violation and reviewable as such:
 *
 * ```ts
 * const canPlay = (c) => c.suit === view.trump           // ❌ legality
 * const remaining = 52 - played.length - hand.length      // ❌ hidden info
 * const points = tricks.reduce(…)                         // ❌ scoring
 * const next = (view.toAct + 1) % 4                       // ❌ turn order
 * ```
 *
 * Each is server-supplied instead: `legalMoves`, `view.deckCount`,
 * `view.scores`, `toAct`. If you need something that is not here, the fix is a
 * field on the projection, never a computation in this file.
 *
 * ### On `seq` and gaps
 *
 * `seq` is monotonic but **not contiguous on any single channel**, by design:
 * the server skips narration for persisted turn-deadline events
 * (`isTimerEvent`), so a one-number hole is the ordinary case once per turn,
 * not a lost message. Three rules follow, and together they are the whole
 * recovery story:
 *
 *   1. anything at or below `seq` is **dropped silently** — stale, or a
 *      duplicate from a resync that overlapped live traffic;
 *   2. a hole **wider than one** is treated as a real gap and triggers
 *      `game:requestSync`, because a dropped message rarely loses exactly one;
 *   3. a reconnect and a server-sent `game:syncRequired` resync
 *      unconditionally — and those, not the heuristic, are what make this
 *      correct. On a live socket.io connection delivery is ordered and
 *      reliable, so the only way to miss a message is a disconnect, and the
 *      transport tells us when one happened.
 */

/** A hole this wide is indistinguishable from a server-skipped timer event. */
const SEQ_GAP_TOLERANCE = 1

export interface NarrationLine {
  seq: number
  kind: string
  seat: number | null
  key: string | null
  params: Record<string, unknown>
  strikes?: number
}

interface GameState {
  gameId: string | null
  gameSlug: string | null
  tableId: string | null
  /** Highest seq applied. Never decreases. */
  seq: number
  phase: string | null
  /** ★ EXACTLY what the server sent. Never augmented, never derived. */
  view: unknown
  /** ★ Server-computed, and present only for the seat that is to act. */
  legalMoves: readonly unknown[] | null
  toAct: number | null
  isTerminal: boolean
  seedCommit: string | null

  /** In flight → the UI disables input without predicting the outcome. */
  pendingMoveId: string | null
  syncing: boolean
  narration: NarrationLine[]

  // ── turn-timer slice (06 §3.3) ────────────────────────────────────────────
  /** Absolute epoch ms, server-supplied. Never a local countdown. */
  turnEndsAt: number | null
  turnSeat: number | null
  strikes: number
  ejectAfterStrikes: number
  ejectionWarning: { secondsRemaining: number; consequence: string } | null
  ejected: {
    reason: string
    replacedByBot: boolean
    reclaimableUntil: number | null
  } | null
  reward: GameRewardSettledPayload | null
  finished: GameFinishedPayload | null

  onStarted: (payload: GameStartedPayload) => void
  /** Returns true when the caller should emit `game:requestSync`. */
  applyServerState: (payload: GameStatePayload) => boolean
  appendNarration: (payload: GameNarrationPayload) => boolean
  applyTurnTimer: (payload: GameTurnTimerPayload) => void
  applyWarning: (secondsRemaining: number, consequence: string) => void
  applyEjection: (payload: GamePlayerEjectedPayload) => void
  applyReturn: (payload: GamePlayerReturnedPayload) => void
  applyReward: (payload: GameRewardSettledPayload) => void
  applyFinished: (payload: GameFinishedPayload) => void
  markPending: (clientMoveId: string | null) => void
  setSyncing: (syncing: boolean) => void
  reset: () => void
}

const EMPTY = {
  gameId: null,
  gameSlug: null,
  tableId: null,
  seq: 0,
  phase: null,
  view: null,
  legalMoves: null,
  toAct: null,
  isTerminal: false,
  seedCommit: null,
  pendingMoveId: null,
  syncing: false,
  narration: [],
  turnEndsAt: null,
  turnSeat: null,
  strikes: 0,
  ejectAfterStrikes: 2,
  ejectionWarning: null,
  ejected: null,
  reward: null,
  finished: null,
} satisfies Partial<GameState>

export const useGameStore = create<GameState>()((set, get) => ({
  ...EMPTY,

  onStarted: (payload) => {
    set({
      ...EMPTY,
      gameId: payload.gameId,
      gameSlug: payload.gameSlug,
      tableId: payload.tableId,
      // Stored now and checked against `seedRevealed` in `game:finished`:
      // that pair is what makes "the server could not have chosen the deal
      // after seeing the cards" checkable rather than merely promised.
      seedCommit: payload.seedCommit,
      seq: payload.seq,
    })
  },

  applyServerState: (payload) => {
    const { seq } = get()

    // Rule 1: stale or duplicate. Dropped silently — a resync that overlaps
    // live traffic legitimately delivers the same state twice.
    if (payload.seq <= seq) return false

    const gap = payload.seq - seq - 1
    set({
      gameId: payload.gameId,
      tableId: payload.tableId,
      seq: payload.seq,
      phase: payload.phase,
      view: payload.view,
      legalMoves: payload.legalMoves,
      toAct: payload.toAct,
      isTerminal: payload.isTerminal,
      // A state that names a different acting seat means our move landed.
      pendingMoveId: null,
    })

    if (gap > SEQ_GAP_TOLERANCE) {
      set({ syncing: true })
      return true
    }
    return false
  },

  appendNarration: (payload) => {
    const { seq, narration } = get()
    if (payload.seq <= seq) return false

    const gap = payload.seq - seq - 1
    set({
      seq: payload.seq,
      // Bounded: a long Shelem match is hundreds of lines and nobody scrolls
      // past the last few dozen.
      narration: [
        ...narration.slice(-199),
        {
          seq: payload.seq,
          kind: payload.kind,
          seat: payload.seat,
          key: payload.descriptor?.key ?? null,
          params: payload.descriptor?.params ?? {},
          ...(payload.strikes === undefined ? {} : { strikes: payload.strikes }),
        },
      ],
    })

    if (gap > SEQ_GAP_TOLERANCE) {
      set({ syncing: true })
      return true
    }
    return false
  },

  applyTurnTimer: (payload) => {
    set({
      // ★ Absolute, from the server. The countdown is rendered as
      // `turnEndsAt − (Date.now() + clockOffset)` so a device whose clock is
      // ten minutes fast still sees the deadline that can eject it.
      turnEndsAt: Date.parse(payload.endsAt),
      turnSeat: payload.seat,
      strikes: payload.strikes,
      ejectAfterStrikes: payload.ejectAfterStrikes,
      // A fresh deadline means the previous warning is spent.
      ejectionWarning: null,
    })
  },

  applyWarning: (secondsRemaining, consequence) => {
    set({ ejectionWarning: { secondsRemaining, consequence } })
  },

  applyEjection: (payload) => {
    set({
      ejected: {
        reason: payload.reason,
        replacedByBot: payload.replacedByBot,
        reclaimableUntil:
          payload.reclaimableUntil === null ? null : Date.parse(payload.reclaimableUntil),
      },
      strikes: payload.strikes,
      ejectionWarning: null,
      turnEndsAt: null,
      turnSeat: null,
    })
  },

  applyReturn: (payload) => {
    if (payload.outcome === 'REPLACED_RETURNED') set({ ejected: null })
  },

  applyReward: (payload) => {
    set({ reward: payload })
  },

  applyFinished: (payload) => {
    set({
      finished: payload,
      isTerminal: true,
      turnEndsAt: null,
      turnSeat: null,
      ejectionWarning: null,
      seq: Math.max(get().seq, payload.seq),
    })
  },

  markPending: (pendingMoveId) => {
    set({ pendingMoveId })
  },

  setSyncing: (syncing) => {
    set({ syncing })
  },

  reset: () => {
    set({ ...EMPTY })
  },
}))
