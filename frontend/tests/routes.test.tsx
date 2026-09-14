import { isValidElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { RequireIdentity, RequireUser } from '../src/routes/guards'
import { routes } from '../src/routes'

/**
 * The route table — 06 §2.
 *
 * This file asserts **shape**, not rendering: every page now fetches, and
 * mounting thirteen of them to read an `<h1>` would be testing the network
 * mock rather than the routing. The screens have their own files.
 *
 * ★ The guard assertions below are the ones that matter. `/table/:tableId`
 * being `RequireIdentity` rather than `RequireUser` **is** the guest-play
 * promise, and it is the kind of thing a well-meaning refactor tightens by
 * accident.
 */

const paths = [
  '/',
  '/login',
  '/register',
  '/t/:inviteCode',
  '/table/:tableId',
  '/games/:slug',
  '/play',
  '/customize',
  '/store',
  '/wallet',
  '/premium',
  '/profile',
  '/matches/:id',
  '*',
]

/** Walks an element tree looking for a component used as a guard. */
function guardOf(element: unknown): unknown {
  if (!isValidElement(element)) return null

  const node = element as ReactElement<{ children?: unknown }>
  if (node.type === RequireIdentity || node.type === RequireUser) return node.type

  return guardOf(node.props.children)
}

function routeFor(path: string) {
  const route = routes.find((candidate) => candidate.path === path)
  expect(route, `no route declared for ${path}`).toBeDefined()
  return route!
}

describe('route table', () => {
  it('declares exactly the routes in 06 §2, and no others', () => {
    expect(routes.map((route) => route.path)).toEqual(paths)
  })

  it.each(['/', '/login', '/register', '/games/:slug', '/premium', '*'])(
    '%s is public — no guard',
    (path) => {
      expect(guardOf(routeFor(path).element)).toBeNull()
    },
  )

  it('★ /t/:inviteCode has NO guard — the link must work in a private window', () => {
    // The whole of journey J1→J2 dies if this route ever asks who you are.
    expect(guardOf(routeFor('/t/:inviteCode').element)).toBeNull()
  })

  it('★ /table/:tableId is RequireIdentity, NOT RequireUser — guests may play', () => {
    // Tightening this to RequireUser silently reintroduces the signup wall
    // this entire product exists to avoid.
    expect(guardOf(routeFor('/table/:tableId').element)).toBe(RequireIdentity)
  })

  it('★ /store is RequireIdentity — a guest browses and sees prices', () => {
    expect(guardOf(routeFor('/store').element)).toBe(RequireIdentity)
  })

  it('/customize is RequireIdentity — a guest may pick a theme', () => {
    expect(guardOf(routeFor('/customize').element)).toBe(RequireIdentity)
  })

  it.each(['/wallet', '/profile'])('%s is RequireUser — an account feature', (path) => {
    expect(guardOf(routeFor(path).element)).toBe(RequireUser)
  })
})
