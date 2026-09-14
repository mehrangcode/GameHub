import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router'
import { IconSprite } from './components/Icon'
// Side-effect import: i18next must be initialized before any component calls
// `t`, and `themeStore` reads its resolved language at construction.
import './i18n'
import { routes } from './routes'
import { useAuthStore } from './stores/authStore'
import { useThemeStore } from './stores/themeStore'
import { useWalletStore } from './stores/walletStore'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found in index.html')

const router = createBrowserRouter(routes)

/**
 * App-level bootstrap — started here rather than in a `useEffect`.
 *
 * Order matters: identity resolves first, because the other two depend on who
 * is asking. Doing it outside React means it starts during module evaluation
 * instead of after the first paint, and StrictMode's double-invoke cannot
 * double it (`bootstrap()` is single-flight regardless).
 *
 * Nothing here blocks rendering. `authStore.status` is `'unknown'` until this
 * resolves, and the route guards render a waiting state for exactly that long
 * rather than flashing the signed-out chrome at a valid session.
 */
void useAuthStore
  .getState()
  .bootstrap()
  .then(() => {
    // Both are identity-scoped, and both fail harmlessly for an anonymous
    // visitor — a 401 here is an answer, not an error.
    void useThemeStore.getState().hydrateFromServer()
    void useWalletStore.getState().hydrate()
  })

createRoot(container).render(
  <StrictMode>
    <IconSprite />
    <RouterProvider router={router} />
  </StrictMode>,
)
