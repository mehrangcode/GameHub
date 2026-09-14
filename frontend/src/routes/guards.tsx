import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router'
import { useAuthStore } from '@/stores/authStore'

/**
 * Route guards — 06 §2.
 *
 * | Guard | Allows |
 * |---|---|
 * | *(none)* | anyone — welcome, invite landing, game detail |
 * | `RequireIdentity` | a signed-in user **or a guest** |
 * | `RequireUser` | a signed-in user only |
 *
 * ★ `/table/:id` is `RequireIdentity`, **not** `RequireUser`. That single
 * choice is the guest-play promise expressed as a route guard, and getting it
 * wrong silently reintroduces the signup wall this whole product is built to
 * avoid.
 *
 * These are components rather than loaders on purpose: a loader runs once, at
 * navigation. Identity can be lost *mid-session* — a refresh that fails while
 * the tab sits open — and a component re-renders when the store changes, so
 * the redirect happens then too.
 */

function Waiting() {
  const { t } = useTranslation()
  // `status` is 'unknown' only while `bootstrap()` is in flight. Rendering the
  // signed-out view here instead would flash the login page on every reload of
  // a perfectly valid session.
  return (
    <p role="status" aria-live="polite">
      {t('state.loading')}
    </p>
  )
}

export function RequireIdentity({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status)
  const location = useLocation()

  if (status === 'unknown') return <Waiting />

  if (status === 'anonymous') {
    // `next` brings them back here afterwards, so a guard never costs somebody
    // their place.
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }

  return <>{children}</>
}

export function RequireUser({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status)
  const location = useLocation()

  if (status === 'unknown') return <Waiting />

  if (status !== 'authenticated') {
    // A guest is sent to *register*, not to sign in: they have no account to
    // sign into, and "sign in" is a dead end that reads as a rejection.
    const next = encodeURIComponent(location.pathname + location.search)
    const destination = status === 'guest' ? '/register' : '/login'
    return <Navigate to={`${destination}?next=${next}`} replace />
  }

  return <>{children}</>
}
