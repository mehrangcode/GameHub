import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios'
import { AUTH_COOKIES, CSRF_HEADER } from '@/contracts/dto/auth'
import { ApiErrorSchema, type ApiError } from '@/contracts/errors'

/**
 * The one configured Axios instance — 06-frontend-architecture.md §4.1.
 *
 * `withCredentials` is what makes the httpOnly cookie session work; nothing in
 * this app ever reads or writes a token in JavaScript, so there is no
 * localStorage path for an XSS to steal a session from.
 *
 * In dev, Vite proxies `/api` to the backend, so the app is same-origin in
 * development exactly as it is in production. That is deliberate: cookie and
 * CSRF bugs that only appear in prod are miserable to find.
 */
export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  timeout: 15_000,
})

/** Marks a config we have already retried once, so a refresh cannot loop. */
interface RetriableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean
}

// ── CSRF + request id ────────────────────────────────────────────────────────

/**
 * The double-submit half of the server's CSRF defence (07 §5.4): the `csrf`
 * cookie is deliberately **not** httpOnly so we can read it here and echo it
 * back in a header. A cross-origin page can cause the cookie to be *sent* but
 * cannot *read* it, so it cannot produce this header.
 */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null

  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

api.interceptors.request.use((config) => {
  // Correlates a browser request with the server's log line for it. The backend
  // generates its own when we send none, so this is a convenience, not a
  // contract.
  config.headers.set('X-Request-Id', crypto.randomUUID())

  const csrf = readCookie(AUTH_COOKIES.csrf)
  if (csrf !== null) config.headers.set(CSRF_HEADER, csrf)

  return config
})

// ── Single-flight refresh ────────────────────────────────────────────────────

/**
 * ★ The shared in-flight refresh. `null` when no refresh is running.
 *
 * Without this, a page that fires five requests on mount answers five 401s with
 * five parallel `POST /auth/refresh` calls — and because S14 *rotates* refresh
 * tokens and kills the whole family on reuse, four of those five look exactly
 * like a stolen-token replay. The user is logged out for the crime of loading a
 * page. One promise, awaited by all of them, is the entire fix.
 */
let refreshing: Promise<void> | null = null

type SessionLostHandler = () => void
let onSessionLost: SessionLostHandler = () => {}

/**
 * `authStore` registers itself here at module init rather than being imported
 * directly, which would make `client → authStore → api/auth → client` a cycle.
 */
export function setSessionLostHandler(handler: SessionLostHandler): void {
  onSessionLost = handler
}

/** Test seam: the shared promise outlives a single test otherwise. */
export function resetRefreshState(): void {
  refreshing = null
}

api.interceptors.response.use(undefined, async (error: unknown) => {
  // `axios.isAxiosError` rather than `instanceof AxiosError`: the class
  // identity check fails whenever two copies of axios are in play — a
  // duplicated dependency, or a test adapter that constructs its own errors —
  // and the failure mode is silent, turning every server error into an opaque
  // INTERNAL with no refresh ever attempted.
  if (!axios.isAxiosError(error)) throw toAppError(error)

  const config = error.config as RetriableConfig | undefined
  const isRefreshCall = config?.url?.includes('/auth/refresh') ?? false

  if (error.response?.status === 401 && config && !config._retried && !isRefreshCall) {
    config._retried = true

    refreshing ??= api
      .post('/auth/refresh')
      .then(() => {
        refreshing = null
      })
      .catch((refreshError: unknown) => {
        refreshing = null
        // The session is genuinely gone — not a transient failure. Clearing
        // identity here rather than at each call site is what makes every
        // screen react to it the same way.
        onSessionLost()
        throw refreshError
      })

    try {
      await refreshing
    } catch {
      throw toAppError(error)
    }

    return api(config as AxiosRequestConfig)
  }

  throw toAppError(error)
})

// ── Error normalization ──────────────────────────────────────────────────────

/**
 * Every rejection this module produces is an {@link ApiError}: a stable machine
 * `code` plus an `i18nKey` the client renders in the reader's language.
 *
 * ★ Nothing here ever surfaces an English sentence from the server. The backend
 * does not send one (02 §5.6), and the two cases it *cannot* send anything for
 * — a dead network, a timeout — get their own keys rather than Axios's
 * `"Network Error"`, which is untranslatable and would read as English prose to
 * a Persian user.
 */
export function toAppError(error: unknown): ApiError {
  if (axios.isAxiosError(error)) {
    const parsed = ApiErrorSchema.safeParse(error.response?.data)
    if (parsed.success) return parsed.data

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return { code: 'INTERNAL', i18nKey: 'errors.timeout' }
    }
    if (error.response === undefined) {
      return { code: 'INTERNAL', i18nKey: 'errors.network' }
    }
    // A response we could not parse — a proxy's HTML 502, say. Opaque by
    // design: anything not matching the contract becomes INTERNAL (02 §5.6).
    return { code: 'INTERNAL', i18nKey: 'errors.internal' }
  }

  return { code: 'INTERNAL', i18nKey: 'errors.internal' }
}

/** Narrows an unknown caught value for `catch` blocks in stores and components. */
export function isApiError(value: unknown): value is ApiError {
  return ApiErrorSchema.safeParse(value).success
}
