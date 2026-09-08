import type { RouteObject } from 'react-router'
import { Placeholder } from './Placeholder'

/**
 * The route table from 06-frontend-architecture.md §2.
 *
 * The guards (`requireIdentity` / `requireUser`) are named here as comments and
 * become real loaders in S39, once `authStore` exists. The distinction matters:
 * `/table/:tableId` is `requireIdentity`, **not** `requireUser` — that single
 * choice is the guest-play promise expressed as a route guard, and getting it
 * wrong reintroduces the signup wall.
 */
export const routes: RouteObject[] = [
  { path: '/', element: <Placeholder title="Welcome" /> },
  { path: '/login', element: <Placeholder title="Sign in" /> },
  { path: '/register', element: <Placeholder title="Create account" /> },
  // public, no auth — the highest-stakes screen (S43)
  { path: '/t/:inviteCode', element: <Placeholder title="Invite" /> },
  // requireIdentity
  { path: '/table/:tableId', element: <Placeholder title="Table" /> },
  { path: '/games/:slug', element: <Placeholder title="Game detail" /> },
  { path: '/play', element: <Placeholder title="Play" /> },
  // requireIdentity
  { path: '/customize', element: <Placeholder title="Customize" /> },
  // requireIdentity — guests may browse and see prices
  { path: '/store', element: <Placeholder title="Store" /> },
  // requireUser
  { path: '/wallet', element: <Placeholder title="Wallet" /> },
  { path: '/premium', element: <Placeholder title="Premium" /> },
  // requireUser
  { path: '/profile', element: <Placeholder title="Profile" /> },
  { path: '/matches/:id', element: <Placeholder title="Match summary" /> },
  { path: '*', element: <Placeholder title="Not found" /> },
]
