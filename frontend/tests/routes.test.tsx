import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { routes } from '../src/routes'

/** One concrete URL per route pattern in 06-frontend-architecture.md §2. */
const paths = [
  ['/', 'Welcome'],
  ['/login', 'Sign in'],
  ['/register', 'Create account'],
  ['/t/ABC12345', 'Invite'],
  ['/table/tbl_1', 'Table'],
  ['/games/shelem', 'Game detail'],
  ['/play', 'Play'],
  ['/customize', 'Customize'],
  ['/store', 'Store'],
  ['/wallet', 'Wallet'],
  ['/premium', 'Premium'],
  ['/profile', 'Profile'],
  ['/matches/m_1', 'Match summary'],
] as const

describe('route table', () => {
  it.each(paths)('renders %s', (path, heading) => {
    const router = createMemoryRouter(routes, { initialEntries: [path] })
    render(<RouterProvider router={router} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(heading)
  })

  it('falls back to the 404 page for an unknown path', () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/nope'] })
    render(<RouterProvider router={router} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Not found')
  })

  it('covers every declared route pattern', () => {
    // Guards against a route being added to the table without a smoke check.
    expect(routes).toHaveLength(paths.length + 1) // + the '*' catch-all
  })
})
