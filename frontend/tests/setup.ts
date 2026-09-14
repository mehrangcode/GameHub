import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

/**
 * jsdom implements neither `matchMedia` nor the scroll APIs, and `themeStore`
 * calls the former at module load to resolve `theme: 'system'`. Stubbed here
 * rather than guarded in the store, because the production code should not
 * carry branches that exist only for the test environment.
 */
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  // Every store that persists reads this at construction; a test that writes a
  // preference must not leak it into the next one.
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.dir = 'ltr'
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
