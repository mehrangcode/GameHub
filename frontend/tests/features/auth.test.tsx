import MockAdapter from 'axios-mock-adapter'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, resetRefreshState } from '../../src/api/client'
import { LoginPage } from '../../src/features/auth/LoginPage'
import { RegisterPage } from '../../src/features/auth/RegisterPage'
import i18n from '../../src/i18n'
import { resetAuthStore, useAuthStore } from '../../src/stores/authStore'
import { renderRouted } from '../helpers/render'

/**
 * S39 — the login and register forms.
 *
 * ★ The property under test is that **the client does not invent its own idea
 * of a valid credential**. Both forms validate with the schemas imported from
 * the generated `contracts/` mirror, so a rule tightened on the server tightens
 * here on the next `contracts:sync` — and the message the reader sees is
 * derived from the *same* key table the server uses, in the reader's own
 * language.
 */

let mock: MockAdapter

async function type(label: string | RegExp, value: string): Promise<void> {
  const input = screen.getByLabelText(label)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  await waitFor(() => {
    expect(input).toHaveValue(value)
  })
}

beforeEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  mock = new MockAdapter(api)
  resetRefreshState()
  resetAuthStore()
})

afterEach(() => {
  mock.restore()
})

describe('client-side validation', () => {
  it('★ rejects a short password using the SERVER’s own message key', async () => {
    renderRouted(<RegisterPage />)

    await type('Display name', 'Mehrang')
    await type('Email', 'me@test.dev')
    await type('Password', 'short')
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }))

    // `PasswordSchema` carries `errors.passwordTooShort` as its own message, so
    // this exact sentence is what the API would have answered too. The two can
    // no longer disagree.
    await waitFor(() => {
      expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument()
    })
    expect(mock.history.post).toHaveLength(0)
  })

  it('rejects a malformed email from the shared schema', async () => {
    renderRouted(<LoginPage />)

    await type('Email', 'not-an-email')
    await type('Password', 'correct-horse-battery')
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(screen.getByText('That format is not valid.')).toBeInTheDocument()
    })
  })

  it('★ renders the same refusal in Persian — never English prose', async () => {
    await act(async () => {
      await i18n.changeLanguage('fa')
    })

    try {
      renderRouted(<RegisterPage />)

      await type('نام نمایشی', 'مهرنگ')
      await type('ایمیل', 'me@test.dev')
      await type('گذرواژه', 'short')
      fireEvent.submit(screen.getByRole('button', { name: 'ساخت حساب' }))

      // Zod's own message here would be "String must contain at least 10
      // character(s)" — untranslatable, and exactly what the i18nKey contract
      // exists to keep off this screen.
      await waitFor(() => {
        expect(screen.getByText('دست‌کم ۱۰ نویسه وارد کنید.')).toBeInTheDocument()
      })
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en')
      })
    }
  })

  it('does not submit until the form is valid', async () => {
    renderRouted(<LoginPage />)

    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
    })
    expect(mock.history.post).toHaveLength(0)
  })
})

describe('server errors', () => {
  it('★ maps fieldErrors onto the right input, not onto the form', async () => {
    mock.onPost('/auth/register').reply(400, {
      code: 'VALIDATION_FAILED',
      i18nKey: 'errors.validationFailed',
      fieldErrors: { displayName: ['errors.displayNameReserved'] },
    })

    renderRouted(<RegisterPage />)

    await type('Display name', 'Administrator')
    await type('Email', 'me@test.dev')
    await type('Password', 'correct-horse-battery')
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(screen.getByText('That name is reserved.')).toBeInTheDocument()
    })
    // Attached to the field, so the red line is under the box that is wrong.
    expect(screen.getByLabelText('Display name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
  })

  it('★ EMAIL_TAKEN lands on the email field even with no fieldErrors', async () => {
    mock.onPost('/auth/register').reply(409, {
      code: 'EMAIL_TAKEN',
      i18nKey: 'errors.emailTaken',
    })

    renderRouted(<RegisterPage />)

    await type('Display name', 'Mehrang')
    await type('Email', 'taken@test.dev')
    await type('Password', 'correct-horse-battery')
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(screen.getByText('That email is already registered.')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows an unplaceable error at form level rather than swallowing it', async () => {
    mock.onPost('/auth/login').reply(429, {
      code: 'RATE_LIMITED',
      i18nKey: 'errors.rateLimited',
    })

    renderRouted(<LoginPage />)

    await type('Email', 'me@test.dev')
    await type('Password', 'correct-horse-battery')
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }))

    // A form that "does nothing" on submit is the worst possible outcome.
    await waitFor(() => {
      expect(screen.getByText('Too many attempts. Try again in a moment.')).toBeInTheDocument()
    })
  })
})

describe('success', () => {
  const identity = {
    kind: 'user',
    userId: 'u1',
    email: 'me@test.dev',
    displayName: 'Mehrang',
    avatarKind: 'initials',
    avatarRef: null,
    locale: 'en',
    role: 'USER',
  }

  it('signing in populates the identity', async () => {
    mock.onPost('/auth/login').reply(200, { identity, redirectTo: null })

    renderRouted(<LoginPage />)

    await type('Email', 'me@test.dev')
    await type('Password', 'correct-horse-battery')
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe('authenticated')
    })
    expect(useAuthStore.getState().identity?.displayName).toBe('Mehrang')
  })

  it('★ registration sends the locale the form was filled in', async () => {
    mock.onPost('/auth/register').reply(201, { identity, redirectTo: null })

    renderRouted(<RegisterPage />)

    await type('Display name', 'Mehrang')
    await type('Email', 'me@test.dev')
    await type('Password', 'correct-horse-battery')
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(mock.history.post).toHaveLength(1)
    })
    // So the first email the account ever receives is in the right language.
    expect(JSON.parse(mock.history.post[0]?.data as string)).toMatchObject({ locale: 'en' })
  })

  it('★ carries an invite code through registration, for the server to redirect on', async () => {
    mock.onPost('/auth/register').reply(201, { identity, redirectTo: '/table/tbl_1' })

    renderRouted(<RegisterPage />, '/register?invite=SEEDDEMO')

    await type('Display name', 'Mehrang')
    await type('Email', 'me@test.dev')
    await type('Password', 'correct-horse-battery')
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(mock.history.post).toHaveLength(1)
    })
    // The destination is then decided by the server, not reconstructed here.
    expect(JSON.parse(mock.history.post[0]?.data as string)).toMatchObject({
      inviteCode: 'SEEDDEMO',
    })
  })
})

describe('bootstrap', () => {
  it('populates identity from GET /auth/me', async () => {
    mock.onGet('/auth/me').reply(200, {
      kind: 'user',
      userId: 'u1',
      email: 'me@test.dev',
      displayName: 'Mehrang',
      avatarKind: 'initials',
      avatarRef: null,
      locale: 'en',
      role: 'USER',
    })

    await useAuthStore.getState().bootstrap()

    expect(useAuthStore.getState().status).toBe('authenticated')
  })

  it('★ a guest bootstraps as "guest", not "authenticated" — different rights', async () => {
    mock.onGet('/auth/me').reply(200, {
      kind: 'guest',
      guestSessionId: 'g1',
      displayName: 'Sara',
      tableId: 'tbl_1',
      avatarRef: null,
      locale: 'en',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    await useAuthStore.getState().bootstrap()

    // The distinction drives `/wallet` vs the purse, and the signup nudge.
    expect(useAuthStore.getState().status).toBe('guest')
  })

  it('a 401 resolves to anonymous — not signed in is an answer, not a failure', async () => {
    mock.onGet('/auth/me').reply(401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })
    mock.onPost('/auth/refresh').reply(401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })

    await useAuthStore.getState().bootstrap()

    expect(useAuthStore.getState().status).toBe('anonymous')
    expect(useAuthStore.getState().identity).toBeNull()
  })

  it('★ is single-flight — StrictMode’s double call costs one request', async () => {
    mock.onGet('/auth/me').reply(200, {
      kind: 'user',
      userId: 'u1',
      email: 'me@test.dev',
      displayName: 'Mehrang',
      avatarKind: 'initials',
      avatarRef: null,
      locale: 'en',
      role: 'USER',
    })

    await Promise.all([useAuthStore.getState().bootstrap(), useAuthStore.getState().bootstrap()])

    expect(mock.history.get.filter((call) => call.url === '/auth/me')).toHaveLength(1)
  })
})
