import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import type { GameSummary } from '../../src/contracts/dto/games'

/**
 * Renders a component inside a router, which most pages need for `<Link>`.
 *
 * `routePath` matters whenever the component reads `useParams()`: mounting an
 * invite page under a `*` catch-all gives it an empty `inviteCode` and it
 * silently requests the wrong URL, which then looks like a component bug rather
 * than a test-harness one.
 */
export function renderRouted(
  element: ReactElement,
  initialPath = '/',
  routePath = '*',
): RenderResult {
  const router = createMemoryRouter([{ path: routePath, element }], {
    initialEntries: [initialPath],
  })
  return render(<RouterProvider router={router} />)
}

/**
 * A `GET /games` row, shaped like the real registry.
 *
 * Built by a factory rather than copied per test so that adding a field to the
 * contract breaks one place, not twenty.
 */
export function gameFixture(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    slug: 'shelem',
    comingSoon: true,
    minPlayers: 4,
    maxPlayers: 4,
    playableCounts: [4],
    teams: { size: 2, count: 2 },
    preview: {
      nameKey: 'games.shelem.name',
      taglineKey: 'games.shelem.tagline',
      complexity: 'heavy',
      avgMinutes: [30, 45],
      art: '/assets/games/shelem.svg',
      hasHiddenInfo: true,
      usesStandardDeck: true,
    },
    turnTimeoutMs: 30_000,
    supportsSpectators: true,
    supportsBots: true,
    matchmakingEnabled: false,
    ...overrides,
  }
}
