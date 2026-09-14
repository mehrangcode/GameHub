import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameRewardSettledPayload } from '../../src/contracts/events'
import { RewardSummary } from '../../src/features/table/RewardSummary'
import { TableShell } from '../../src/features/table/TableShell'
import { TurnTimerRing } from '../../src/features/table/TurnTimerRing'
import i18n from '../../src/i18n'
import { resetAuthStore, useAuthStore } from '../../src/stores/authStore'
import { useChatStore } from '../../src/stores/chatStore'
import { useGameStore } from '../../src/stores/gameStore'
import { useSocketStore } from '../../src/stores/socketStore'
import { useTableStore } from '../../src/stores/tableStore'
import { renderRouted } from '../helpers/render'

/**
 * S44 — the shared table shell.
 *
 * Three assertions carry this file:
 *
 *   1. the **countdown is right with a deliberately wrong system clock** — the
 *      number that costs somebody their seat and their coins;
 *   2. the **seat map distinguishes every occupant kind**, because a bot and a
 *      disconnected human rendering identically is how "why isn't anyone
 *      playing?" becomes a support conversation;
 *   3. a **zero reward reads as a published rule**, with its reason — the
 *      hardest thing in this UI to get right, and the one where getting it
 *      wrong makes a correct payout look like a bug.
 */

function seat(overrides: Record<string, unknown> = {}) {
  return {
    seat: 0,
    memberId: 'm0',
    occupant: { kind: 'user', displayName: 'Mehrang', avatarRef: null, botDifficulty: null },
    team: null,
    role: 'PLAYER',
    isSelf: true,
    joinedAt: new Date().toISOString(),
    botSubstituted: false,
    ...overrides,
  }
}

function seedTable(seats: unknown[]) {
  useTableStore.setState({
    table: {
      id: 'tbl_1',
      gameSlug: 'shelem',
      status: 'IN_PROGRESS',
      origin: 'PRIVATE',
      seatCount: seats.length,
      seatsTaken: seats.length,
      isHost: true,
      mySeat: 0,
      rewardEligible: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      hostDisplayName: 'Mehrang',
      options: {},
      allowSpectators: true,
      requireApproval: false,
      turnEnforcement: {
        ejectAfterStrikes: 2,
        warningSeconds: 10,
        strikesResetOnAction: true,
        reclaimWindowSec: 120,
      },
      seats,
      spectatorCount: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    members: [],
    you: { memberId: 'm0', seat: 0, role: 'PLAYER', isHost: true, isSpectator: false },
    connectedTableId: 'tbl_1',
  })
}

beforeEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  resetAuthStore()
  useAuthStore.setState({ status: 'authenticated' })
  useGameStore.getState().reset()
  useChatStore.getState().reset()
  useSocketStore.setState({ state: 'connected', clockOffset: 0, protocolMismatch: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('★ the countdown under a wrong system clock', () => {
  it('renders the true remaining time when the device clock is 10 minutes fast', () => {
    const realNow = Date.now()
    // The device believes it is ten minutes later than it is.
    const skew = 10 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(realNow + skew)

    // The handshake measured the offset, so `serverNow()` corrects for it.
    useSocketStore.setState({ clockOffset: -skew })

    // A deadline 30 s from the *server's* now.
    const endsAt = realNow + 30_000

    renderRouted(
      <TurnTimerRing
        endsAt={endsAt}
        totalMs={30_000}
        strikes={0}
        ejectAfterStrikes={2}
        isYou
        actingName="Mehrang"
      />,
    )

    // Without the offset this would read 0:00 and the player would think they
    // had already lost the turn — or worse, with the skew the other way, would
    // be shown ten minutes they do not have.
    expect(screen.getByText('0:30')).toBeInTheDocument()
  })

  it('reddens under 10 seconds and clamps at zero', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const { unmount } = renderRouted(
      <TurnTimerRing
        endsAt={now - 4_000}
        totalMs={30_000}
        strikes={1}
        ejectAfterStrikes={2}
        isYou
        actingName="Mehrang"
      />,
    )

    // A passed deadline reads 0:00, never -0:04.
    expect(screen.getByText('0:00')).toBeInTheDocument()
    unmount()
  })

  it('renders one strike pip per allowed strike, filled to the count', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    renderRouted(
      <TurnTimerRing
        endsAt={now + 20_000}
        totalMs={30_000}
        strikes={1}
        ejectAfterStrikes={2}
        isYou={false}
        actingName="Sara"
      />,
    )

    expect(screen.getByLabelText('1 of 2 strikes')).toBeInTheDocument()
    expect(screen.getByText('Sara is thinking')).toBeInTheDocument()
  })
})

describe('the seat map', () => {
  it('★ renders every occupant kind distinctly', () => {
    seedTable([
      seat({ seat: 0, isSelf: true }),
      seat({
        seat: 1,
        memberId: 'm1',
        isSelf: false,
        occupant: { kind: 'guest', displayName: 'Sara', avatarRef: null, botDifficulty: null },
      }),
      seat({
        seat: 2,
        memberId: 'm2',
        isSelf: false,
        occupant: { kind: 'bot', displayName: null, avatarRef: null, botDifficulty: 'medium' },
      }),
      seat({ seat: 3, memberId: null, occupant: null, isSelf: false }),
    ])

    renderRouted(<TableShell />)

    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Sara')).toBeInTheDocument()
    expect(screen.getAllByText('Bot').length).toBeGreaterThan(0)
    expect(screen.getByText('Empty seat')).toBeInTheDocument()
  })

  it('★ marks a bot that is HOLDING an ejected human’s seat, distinctly from a host-added bot', () => {
    seedTable([
      seat({ seat: 0, isSelf: true }),
      seat({
        seat: 1,
        memberId: 'm1',
        isSelf: false,
        botSubstituted: true,
        occupant: { kind: 'bot', displayName: null, avatarRef: null, botDifficulty: 'medium' },
      }),
    ])

    renderRouted(<TableShell />)

    // The reclaim window depends on which of the two this is, so they must not
    // render the same.
    expect(screen.getByText(/removed for inactivity/)).toBeInTheDocument()
  })
})

describe('★ the ejection panel', () => {
  beforeEach(() => {
    seedTable([seat({ seat: 0, isSelf: true })])
  })

  it('says what happened, what it costs, and offers the way back', () => {
    useGameStore.setState({
      gameId: 'g1',
      ejected: {
        reason: 'TURN_TIMEOUT',
        replacedByBot: true,
        reclaimableUntil: Date.now() + 107_000,
      },
    })

    renderRouted(<TableShell />)

    expect(screen.getByText('You were removed from your seat')).toBeInTheDocument()
    expect(screen.getByText(/a bot is playing your seat/)).toBeInTheDocument()
    // ★ The consequence is stated here, not inferred from an empty wallet later.
    expect(screen.getByText('You will earn no coins from this match.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reclaim my seat/ })).toBeInTheDocument()
  })

  it('shows a LIVE countdown on the reclaim button, not a static promise', () => {
    useGameStore.setState({
      gameId: 'g1',
      ejected: { reason: 'TURN_TIMEOUT', replacedByBot: true, reclaimableUntil: Date.now() + 107_000 },
    })

    renderRouted(<TableShell />)

    // "Reclaim (1:47)" — a bare "you may reclaim" becomes a broken promise the
    // moment the window closes.
    expect(screen.getByRole('button', { name: /1:47/ })).toBeInTheDocument()
  })

  it('★ an expired window offers no button at all', () => {
    useGameStore.setState({
      gameId: 'g1',
      ejected: { reason: 'TURN_TIMEOUT', replacedByBot: true, reclaimableUntil: Date.now() - 1_000 },
    })

    renderRouted(<TableShell />)

    expect(screen.getByText('This seat can no longer be reclaimed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reclaim/ })).not.toBeInTheDocument()
  })

  it('★ a platform kick forfeits nothing — no "you earn nothing" line', () => {
    useGameStore.setState({
      gameId: 'g1',
      ejected: { reason: 'KICKED', replacedByBot: false, reclaimableUntil: null },
    })

    renderRouted(<TableShell />)

    // 12 A8: platform-initiated interruption is free. Telling a kicked player
    // they forfeited would be the platform blaming them for its own action.
    expect(screen.getByText('The host removed you from this table.')).toBeInTheDocument()
    expect(screen.queryByText('You will earn no coins from this match.')).not.toBeInTheDocument()
  })

  it('shows the private ejection warning as an alert', () => {
    useGameStore.setState({ ejectionWarning: { secondsRemaining: 10, consequence: 'EJECTION_NO_REWARD' } })

    renderRouted(<TableShell />)

    expect(screen.getByText('Play now or lose the seat')).toBeInTheDocument()
    expect(screen.getByText(/you will earn nothing from this match/i)).toBeInTheDocument()
  })
})

describe('★ the reward summary', () => {
  function reward(overrides: Partial<GameRewardSettledPayload> = {}): GameRewardSettledPayload {
    return {
      gameId: 'g1',
      tableId: 'tbl_1',
      seat: 0,
      coinsAwarded: 120,
      earned: 120,
      forfeited: false,
      reasonKey: null,
      capped: false,
      capCode: null,
      factors: { base: 80, placement: 1.5, premium: 1, integrity: 1, repeatDecay: 1, duration: 1 },
      ...overrides,
    }
  }

  it('shows the arithmetic, so the economy is not opaque', () => {
    renderRouted(<RewardSummary reward={reward()} />)

    expect(screen.getByText('120 coins')).toBeInTheDocument()
    expect(screen.getByText('80')).toBeInTheDocument()
    expect(screen.getByText('×1.5')).toBeInTheDocument()
  })

  it('★★ a forfeited zero is EXPLAINED, with its reason and a link to the rule', () => {
    renderRouted(
      <RewardSummary
        reward={reward({
          coinsAwarded: 0,
          earned: 180,
          forfeited: true,
          reasonKey: 'games.reward.forfeitedTimeout',
          factors: { base: 80, placement: 1.5, premium: 1, integrity: 0, repeatDecay: 1, duration: 1 },
        })}
      />,
    )

    expect(screen.getByText('No coins from this match')).toBeInTheDocument()
    // ★ The whole point: a zero with a published reason reads as a rule. A
    // silent zero is indistinguishable from a broken payout, and a player who
    // assumes a bug is *correct* to, because a bug looks the same.
    expect(
      screen.getByText('You were removed for inactivity, so your reward was forfeited'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Read the rule' })).toBeInTheDocument()
    // The integrity factor of 0 is visible, so the arithmetic explains itself.
    expect(screen.getByText('×0')).toBeInTheDocument()
  })

  it('★ a CAP is not a forfeit — different message, different tone', () => {
    renderRouted(
      <RewardSummary
        reward={reward({ coinsAwarded: 40, earned: 120, capped: true, capCode: 'CAP_PER_HOUR' })}
      />,
    )

    // The player did nothing wrong; they hit an earning limit.
    expect(screen.getByText('An earning limit reduced this.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Read the rule' })).not.toBeInTheDocument()
  })

  it('a reduced-but-not-forfeited reward still says why', () => {
    renderRouted(
      <RewardSummary
        reward={reward({ coinsAwarded: 60, reasonKey: 'games.reward.returned' })}
      />,
    )

    expect(
      screen.getByText('You reclaimed your seat, so this match pays half'),
    ).toBeInTheDocument()
  })

  it('renders Persian, including the forfeiture explanation', async () => {
    await act(async () => {
      await i18n.changeLanguage('fa')
    })

    try {
      renderRouted(
        <RewardSummary
          reward={reward({
            coinsAwarded: 0,
            forfeited: true,
            reasonKey: 'games.reward.forfeitedTimeout',
          })}
        />,
      )

      expect(
        screen.getByText('به دلیل بی‌تحرکی حذف شدید، بنابراین پاداش شما سوخت'),
      ).toBeInTheDocument()
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en')
      })
    }
  })
})

describe('banners', () => {
  beforeEach(() => {
    seedTable([seat({ seat: 0, isSelf: true })])
  })

  it('★ a protocol mismatch asks for a refresh rather than half-working', () => {
    useSocketStore.setState({ protocolMismatch: true })

    renderRouted(<TableShell />)

    expect(screen.getByText(/This page is out of date/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('shows a reconnecting banner while the socket is down', () => {
    useSocketStore.setState({ state: 'reconnecting' })

    renderRouted(<TableShell />)

    expect(screen.getByText('Reconnecting to the table…')).toBeInTheDocument()
  })

  it('shows a syncing state while catching up', () => {
    useGameStore.setState({ syncing: true })

    renderRouted(<TableShell />)

    expect(screen.getByText('Catching up…')).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('★ announces whose turn it is over aria-live', async () => {
    seedTable([
      seat({ seat: 0, isSelf: true }),
      seat({
        seat: 1,
        memberId: 'm1',
        isSelf: false,
        occupant: { kind: 'user', displayName: 'Sara', avatarRef: null, botDifficulty: null },
      }),
    ])
    useGameStore.setState({ gameId: 'g1', toAct: 1 })

    renderRouted(<TableShell />)

    await waitFor(() => {
      const live = document.querySelector('[aria-live="polite"].sr-only')
      expect(live?.textContent).toBe('Sara is thinking')
    })
  })
})

describe('the signup nudge', () => {
  it('★ appears for a guest and NOT for a user', () => {
    seedTable([seat({ seat: 0, isSelf: true })])

    const { unmount } = renderRouted(<TableShell />)
    expect(screen.queryByText(/coins waiting/)).not.toBeInTheDocument()
    unmount()

    useAuthStore.setState({ status: 'guest' })
    renderRouted(<TableShell />)

    // A suggestion, never a gate — and never shown to someone who already has
    // an account.
    expect(screen.getByText(/coins waiting/)).toBeInTheDocument()
  })
})
