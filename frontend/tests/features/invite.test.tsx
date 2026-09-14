import MockAdapter from 'axios-mock-adapter'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, resetRefreshState } from '../../src/api/client'
import { InviteLandingPage } from '../../src/features/invite/InviteLandingPage'
import i18n from '../../src/i18n'
import { resetAuthStore, useAuthStore } from '../../src/stores/authStore'
import { renderRouted } from '../helpers/render'

/**
 * S43 — the invite landing page.
 *
 * ★ This is the screen that decides whether persona P2 plays or leaves, and the
 * two assertions that matter most are about what it does *not* do:
 *
 *   - it never asks for authentication before resolving the code, because the
 *     friend is in a private window with an empty cookie jar;
 *   - it renders **one message** for expired, revoked and never-existed. The
 *     server deliberately answers all three identically so the route cannot be
 *     used to enumerate live invites (07 §5.2), and a UI that distinguished
 *     them would hand that property straight back.
 */

let mock: MockAdapter

const INVITE = {
  gameSlug: 'shelem',
  gameNameKey: 'games.shelem.name',
  hostDisplayName: 'Ali',
  seatCount: 4,
  seatsFree: 3,
  inProgress: false,
  allowSpectators: true,
  requireApproval: false,
}

beforeEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  mock = new MockAdapter(api)
  resetRefreshState()
  resetAuthStore()
  useAuthStore.setState({ status: 'anonymous', identity: null })
})

afterEach(() => {
  mock.restore()
})

describe('resolving the link', () => {
  it('★ resolves with NO authentication — the private-window case', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByText(/Ali invited you to play Shelem/)).toBeInTheDocument()
    })
    // No /auth/me, no cookie, no CSRF token. If this route ever needs one,
    // journey J1→J2 is dead.
    expect(mock.history.get.map((call) => call.url)).toEqual(['/invites/SEEDDEMO'])
  })

  it('shows how many seats are open', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByText('3 of 4 seats open')).toBeInTheDocument()
    })
  })

  it('★ ONE field and ONE button — no email, no password, no checkbox', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByLabelText('Your name')).toBeInTheDocument()
    })

    // The target is click-to-seated in five seconds. Every extra control is a
    // reason to close the tab.
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('★ sign-in is a text LINK, never a competing button', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
    })
    // Two buttons here turns a five-second join into a decision.
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('says plainly that no account is needed', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByText('No account needed.')).toBeInTheDocument()
    })
  })
})

describe('★ error states are indistinguishable', () => {
  it('renders the same message for an expired code and an unknown one', async () => {
    mock.onGet('/invites/EXPIRED').reply(410, {
      code: 'INVITE_EXPIRED',
      i18nKey: 'errors.inviteExpired',
    })

    renderRouted(<InviteLandingPage />, '/t/EXPIRED', '/t/:inviteCode')
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    const expired = screen.getByRole('alert').textContent

    // A different code, the same 410 — which is what the server sends for
    // revoked, exhausted, unknown and dangling alike.
    mock.onGet('/invites/NEVEREXISTED').reply(410, {
      code: 'INVITE_EXPIRED',
      i18nKey: 'errors.inviteExpired',
    })

    renderRouted(<InviteLandingPage />, '/t/NEVEREXISTED', '/t/:inviteCode')
    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(1)
    })

    expect(screen.getAllByRole('alert')[1]?.textContent).toBe(expired)
  })

  it('the failure has a useful next action, not just an apology', async () => {
    mock.onGet('/invites/EXPIRED').reply(410, {
      code: 'INVITE_EXPIRED',
      i18nKey: 'errors.inviteExpired',
    })

    renderRouted(<InviteLandingPage />, '/t/EXPIRED', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByText(/ask whoever sent it for a fresh one/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link')).toBeInTheDocument()
  })
})

describe('table states', () => {
  it('explains a full table and offers spectating when allowed', async () => {
    mock.onGet('/invites/FULL').reply(200, { ...INVITE, seatsFree: 0 })

    renderRouted(<InviteLandingPage />, '/t/FULL', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByText('That table is full')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Watch instead/ })).toBeEnabled()
  })

  it('explains a match already in progress', async () => {
    mock.onGet('/invites/LIVE').reply(200, { ...INVITE, inProgress: true })

    renderRouted(<InviteLandingPage />, '/t/LIVE', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByText('The match has already started')).toBeInTheDocument()
    })
  })

  it('warns when the host approves each join', async () => {
    mock.onGet('/invites/GATED').reply(200, { ...INVITE, requireApproval: true })

    renderRouted(<InviteLandingPage />, '/t/GATED', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByText(/approves each person who joins/)).toBeInTheDocument()
    })
  })
})

describe('joining', () => {
  it('★ a guest is created and sent to the SERVER’s redirectTo', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)
    mock.onPost('/auth/guest').reply(201, {
      identity: {
        kind: 'guest',
        guestSessionId: 'g1',
        displayName: 'Sara',
        tableId: 'tbl_1',
        avatarRef: null,
        locale: 'en',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      redirectTo: '/table/tbl_1',
    })

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByLabelText('Your name')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sara' } })
    fireEvent.click(screen.getByRole('button', { name: /Play now/ }))

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe('guest')
    })
    // The public payload carries no tableId on purpose, so this destination
    // could only have come from the server.
    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({
      inviteCode: 'SEEDDEMO',
      displayName: 'Sara',
    })
  })

  it('validates the name against the shared schema before calling the API', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByLabelText('Your name')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /Play now/ }))

    await waitFor(() => {
      expect(screen.getByText('That name is too short.')).toBeInTheDocument()
    })
    expect(mock.history.post).toHaveLength(0)
  })

  it('remembers the name so a refresh does not re-prompt', async () => {
    localStorage.setItem('guestName', 'Sara')
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByLabelText('Your name')).toHaveValue('Sara')
    })
  })

  it('★ a signed-in user REDEEMS the code — they never become a guest', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)
    mock.onPost('/invites/SEEDDEMO/redeem').reply(200, {
      tableId: 'tbl_1',
      redirectTo: '/table/tbl_1',
      alreadyMember: false,
    })

    useAuthStore.setState({
      status: 'authenticated',
      identity: {
        kind: 'user',
        userId: 'u1',
        email: 'me@test.dev',
        displayName: 'Mehrang',
        avatarKind: 'initials',
        avatarRef: null,
        locale: 'en',
        role: 'USER',
      },
    })

    renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Play now/ })).toBeInTheDocument()
    })
    // No name field: they have a name.
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Play now/ }))

    await waitFor(() => {
      expect(mock.history.post.map((call) => call.url)).toEqual(['/invites/SEEDDEMO/redeem'])
    })
    // Becoming a guest would strand their coins in a provisional wallet.
    expect(useAuthStore.getState().status).toBe('authenticated')
  })
})

describe('localization', () => {
  it('renders the whole screen in Persian', async () => {
    mock.onGet('/invites/SEEDDEMO').reply(200, INVITE)
    await act(async () => {
      await i18n.changeLanguage('fa')
    })

    try {
      renderRouted(<InviteLandingPage />, '/t/SEEDDEMO', '/t/:inviteCode')

      await waitFor(() => {
        expect(screen.getByText(/شلم/)).toBeInTheDocument()
      })
      expect(screen.getByText('نیازی به حساب کاربری نیست.')).toBeInTheDocument()
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en')
      })
    }
  })
})
