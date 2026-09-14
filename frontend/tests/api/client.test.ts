import MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, isApiError, resetRefreshState, toAppError } from '../../src/api/client'
import { resetAuthStore, useAuthStore } from '../../src/stores/authStore'

/**
 * S39 — the Axios layer.
 *
 * The headline is the single-flight refresh, and it is worth stating why it is
 * a *correctness* test rather than a performance one: S14 **rotates** refresh
 * tokens and kills the whole family when one is reused. So five parallel
 * refreshes do not merely waste four requests — four of them present an
 * already-rotated token, which the server correctly reads as a stolen-token
 * replay and answers by revoking the family. The user is signed out for the
 * crime of loading a page with five widgets on it.
 */

let mock: MockAdapter

beforeEach(() => {
  mock = new MockAdapter(api)
  resetRefreshState()
  resetAuthStore()
})

afterEach(() => {
  mock.restore()
})

describe('single-flight refresh', () => {
  it('★ five concurrent 401s trigger EXACTLY ONE /auth/refresh', async () => {
    let refreshes = 0
    const attempts = new Map<string, number>()

    mock.onPost('/auth/refresh').reply(() => {
      refreshes += 1
      return [200, { identity: null, redirectTo: null }]
    })

    // Each distinct URL 401s on its first attempt and succeeds on its retry.
    // Counted per URL rather than by a timer, so the test asserts the
    // single-flight property rather than racing it.
    mock.onGet(/\/thing\/\d/).reply((config) => {
      const seen = (attempts.get(config.url ?? '') ?? 0) + 1
      attempts.set(config.url ?? '', seen)
      return seen === 1
        ? [401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' }]
        : [200, { ok: true }]
    })

    const results = await Promise.all([0, 1, 2, 3, 4].map((n) => api.get(`/thing/${n}`)))

    expect(refreshes).toBe(1)
    expect(results).toHaveLength(5)
  })

  it('retries the original request after the refresh, and it succeeds', async () => {
    let seen = 0
    mock.onPost('/auth/refresh').reply(200, {})
    mock.onGet('/protected').reply(() => {
      seen += 1
      return seen === 1
        ? [401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' }]
        : [200, { value: 42 }]
    })

    const response = await api.get('/protected')

    expect(response.data).toEqual({ value: 42 })
    expect(seen).toBe(2)
  })

  it('★ a failed refresh clears the identity and rejects the original call', async () => {
    useAuthStore.setState({
      identity: {
        kind: 'user',
        userId: 'u1',
        email: 'a@b.c',
        displayName: 'A',
        avatarKind: 'initials',
        avatarRef: null,
        locale: 'en',
        role: 'USER',
      },
      status: 'authenticated',
    })

    mock.onPost('/auth/refresh').reply(401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })
    mock.onGet('/protected').reply(401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })

    await expect(api.get('/protected')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    expect(useAuthStore.getState().identity).toBeNull()
    expect(useAuthStore.getState().status).toBe('anonymous')
  })

  it('★ never refreshes in response to the refresh call itself — no infinite loop', async () => {
    let refreshes = 0
    mock.onPost('/auth/refresh').reply(() => {
      refreshes += 1
      return [401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' }]
    })

    await expect(api.post('/auth/refresh')).rejects.toBeDefined()

    expect(refreshes).toBe(1)
  })

  it('retries a given request only once — the _retried guard', async () => {
    let calls = 0
    mock.onPost('/auth/refresh').reply(200, {})
    mock.onGet('/always401').reply(() => {
      calls += 1
      return [401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' }]
    })

    await expect(api.get('/always401')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    // Original + one retry. A missing guard makes this recurse until the stack
    // gives out.
    expect(calls).toBe(2)
  })

  it('a later 401 starts a fresh refresh — the promise is not cached forever', async () => {
    let refreshes = 0
    mock.onPost('/auth/refresh').reply(() => {
      refreshes += 1
      return [200, {}]
    })
    mock.onGet('/a').replyOnce(401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })
    mock.onGet('/a').reply(200, {})

    await api.get('/a')
    expect(refreshes).toBe(1)

    mock.resetHistory()
    mock.onGet('/b').replyOnce(401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })
    mock.onGet('/b').reply(200, {})

    await api.get('/b')
    expect(refreshes).toBe(2)
  })
})

describe('toAppError', () => {
  it('★ passes a contract error through untouched — code and i18nKey preserved', async () => {
    mock.onGet('/x').reply(400, {
      code: 'VALIDATION_FAILED',
      i18nKey: 'errors.validationFailed',
      fieldErrors: { email: ['errors.field.invalidFormat'] },
    })

    await expect(api.get('/x')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      i18nKey: 'errors.validationFailed',
      fieldErrors: { email: ['errors.field.invalidFormat'] },
    })
  })

  it('★ a network failure becomes a KEY, never Axios’s English "Network Error"', async () => {
    mock.onGet('/down').networkError()

    // The whole point of the code+i18nKey contract: a Persian reader must not
    // be shown untranslatable English prose from a transport library.
    await expect(api.get('/down')).rejects.toMatchObject({
      code: 'INTERNAL',
      i18nKey: 'errors.network',
    })
  })

  it('a timeout gets its own key, distinct from a dead network', async () => {
    mock.onGet('/slow').timeout()

    await expect(api.get('/slow')).rejects.toMatchObject({ i18nKey: 'errors.timeout' })
  })

  it('★ an unparseable body becomes opaque INTERNAL — a proxy’s HTML 502', async () => {
    mock.onGet('/broken').reply(502, '<html>Bad Gateway</html>')

    await expect(api.get('/broken')).rejects.toMatchObject({
      code: 'INTERNAL',
      i18nKey: 'errors.internal',
    })
  })

  it('a non-Axios throw still becomes an ApiError', () => {
    expect(toAppError(new Error('boom'))).toEqual({ code: 'INTERNAL', i18nKey: 'errors.internal' })
    expect(isApiError(toAppError(new Error('boom')))).toBe(true)
  })
})

describe('request headers', () => {
  it('★ echoes the csrf cookie in X-CSRF-Token — the double-submit half of 07 §5.4', async () => {
    document.cookie = 'csrf=token-abc'
    mock.onGet('/y').reply(200, {})

    await api.get('/y')

    expect(mock.history.get[0]?.headers?.['x-csrf-token']).toBe('token-abc')
  })

  it('sends a request id so a browser call can be found in the server log', async () => {
    mock.onGet('/z').reply(200, {})

    await api.get('/z')

    expect(mock.history.get[0]?.headers?.['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('★ sends credentials — the session is an httpOnly cookie, never a token in JS', async () => {
    mock.onGet('/w').reply(200, {})

    await api.get('/w')

    // If this is ever false, someone has started keeping a token somewhere an
    // XSS can read it.
    expect(mock.history.get[0]?.withCredentials).toBe(true)
  })
})

describe('localStorage', () => {
  it('★ no auth material is ever written to localStorage', async () => {
    mock.onPost('/auth/refresh').reply(200, {})
    mock.onGet('/p').replyOnce(401, { code: 'UNAUTHORIZED', i18nKey: 'errors.unauthorized' })
    mock.onGet('/p').reply(200, {})

    await api.get('/p')

    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? '')
    for (const value of stored) {
      expect(value).not.toMatch(/token|refresh|access|jwt/i)
    }
  })
})

// Keeps the unused-import lint quiet in a file that only spies indirectly.
void vi
