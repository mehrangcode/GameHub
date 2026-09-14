import { useCallback, useEffect, useRef, useState } from 'react'
import { messageOf } from './apiErrors'

export interface AsyncState<T> {
  data: T | null
  /** Already localized, ready to render. Never a raw server string. */
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * The smallest thing that covers "fetch on mount, render loading / error /
 * data" — deliberately not a data-fetching library.
 *
 * M0 has a handful of reads and no cache invalidation problem worth 12 KB of
 * dependency. When matchmaking and the store arrive and the same resource is
 * read from four screens, this is the seam to replace.
 *
 * The `active` flag is what makes it StrictMode-safe: React mounts effects
 * twice in development, and a resolved promise from the discarded first mount
 * must not write state over the second.
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // Held in a ref so an inline arrow function does not re-run the effect on
  // every render — the caller should not have to `useCallback` their fetcher.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)

    fetcherRef
      .current()
      .then((result) => {
        if (active) setData(result)
      })
      .catch((caught: unknown) => {
        if (active) setError(messageOf(caught))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])

  return { data, error, loading, reload }
}
