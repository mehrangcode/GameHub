import type { RouteObject } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { LoginPage } from '@/features/auth/LoginPage'
import { RegisterPage } from '@/features/auth/RegisterPage'
import { InviteLandingPage } from '@/features/invite/InviteLandingPage'
import { TablePage } from '@/features/table/TablePage'
import { GameDetailPage } from '@/features/welcome/GameDetailPage'
import { WelcomePage } from '@/features/welcome/WelcomePage'
import { NotFoundPage } from './NotFoundPage'
import { Placeholder } from './Placeholder'
import { RequireIdentity, RequireUser } from './guards'

/**
 * The route table from 06-frontend-architecture.md §2.
 *
 * ★ Two entries carry the product's whole shape:
 *
 *   - `/t/:inviteCode` has **no guard at all**. It is the link a friend clicks,
 *     and it must work in a private window with no cookies (journey J1→J2).
 *   - `/table/:tableId` is `RequireIdentity`, **not** `RequireUser` — a guest
 *     may play. That single word is the guest-play promise as a route guard.
 *
 * `/store` is `RequireIdentity` too: guests browse and see prices, because
 * showing them what their unvested coins could buy is the point. `/wallet` is
 * `RequireUser`, since a statement is an account feature.
 */

/** Screens that live inside the app chrome. */
function shell(element: React.ReactNode) {
  return <AppShell>{element}</AppShell>
}

export const routes: RouteObject[] = [
  { path: '/', element: shell(<WelcomePage />) },

  // No shell: a sign-in page with a navigation bar invites you to go somewhere
  // other than sign in.
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },

  // ★ Public, no auth loader — the highest-stakes screen (S43).
  { path: '/t/:inviteCode', element: <InviteLandingPage /> },

  {
    path: '/table/:tableId',
    element: (
      <RequireIdentity>
        <TablePage />
      </RequireIdentity>
    ),
  },

  { path: '/games/:slug', element: shell(<GameDetailPage />) },
  { path: '/play', element: shell(<Placeholder title="Play" />) },

  {
    path: '/customize',
    element: <RequireIdentity>{shell(<Placeholder title="Customize" />)}</RequireIdentity>,
  },
  {
    path: '/store',
    element: <RequireIdentity>{shell(<Placeholder title="Store" />)}</RequireIdentity>,
  },
  {
    path: '/wallet',
    element: <RequireUser>{shell(<Placeholder title="Wallet" />)}</RequireUser>,
  },

  { path: '/premium', element: shell(<Placeholder title="Premium" />) },
  {
    path: '/profile',
    element: <RequireUser>{shell(<Placeholder title="Profile" />)}</RequireUser>,
  },
  { path: '/matches/:id', element: shell(<Placeholder title="Match summary" />) },

  { path: '*', element: shell(<NotFoundPage />) },
]
