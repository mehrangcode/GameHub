import { create } from 'zustand'
import * as authApi from '@/api/auth'
import { setSessionLostHandler } from '@/api/client'
import type {
  GuestClaimRequest,
  GuestClaimResponse,
  Identity,
  LoginRequest,
  RegisterRequest,
} from '@/contracts/dto/auth'

/**
 * Who the viewer is — 06 §3.1.
 *
 * `status` is four-valued rather than a boolean because the three non-unknown
 * answers mean genuinely different things to the UI: a **guest** may sit at a
 * table and earn provisional coins but has no statement to paginate, and
 * `unknown` (before `bootstrap()` resolves) must not render as `anonymous` or
 * every reload flashes the signed-out chrome for a moment.
 */
export type AuthStatus = 'unknown' | 'authenticated' | 'guest' | 'anonymous'

interface AuthState {
  identity: Identity | null
  status: AuthStatus
  /** True while `bootstrap()` is in flight, so guards can wait rather than redirect. */
  loading: boolean

  bootstrap: () => Promise<void>
  login: (input: LoginRequest) => Promise<void>
  registerAccount: (input: RegisterRequest) => Promise<string | null>
  registerAsGuest: (inviteCode: string, displayName: string) => Promise<string | null>
  claimGuestAccount: (input: GuestClaimRequest) => Promise<GuestClaimResponse>
  logout: () => Promise<void>
  /** Called by the Axios interceptor when a refresh fails. Never navigates. */
  onSessionLost: () => void
}

function statusOf(identity: Identity | null): AuthStatus {
  if (identity === null) return 'anonymous'
  return identity.kind === 'guest' ? 'guest' : 'authenticated'
}

/** A single in-flight `bootstrap`, shared — StrictMode calls effects twice. */
let bootstrapping: Promise<void> | null = null

export const useAuthStore = create<AuthState>()((set) => ({
  identity: null,
  status: 'unknown',
  loading: false,

  bootstrap: async () => {
    bootstrapping ??= (async () => {
      set({ loading: true })
      try {
        const identity = await authApi.me()
        set({ identity, status: statusOf(identity) })
      } catch {
        // A 401 here is the ordinary "not signed in" answer, not a failure.
        // Note the interceptor has already tried exactly one refresh on our
        // behalf, which is what makes a reload with an expired access token
        // land authenticated rather than at the login form.
        set({ identity: null, status: 'anonymous' })
      } finally {
        set({ loading: false })
        bootstrapping = null
      }
    })()

    return bootstrapping
  },

  login: async (input) => {
    const session = await authApi.login(input)
    set({ identity: session.identity, status: statusOf(session.identity) })
  },

  registerAccount: async (input) => {
    const session = await authApi.register(input)
    set({ identity: session.identity, status: statusOf(session.identity) })
    return session.redirectTo
  },

  registerAsGuest: async (inviteCode, displayName) => {
    const session = await authApi.joinAsGuest({ inviteCode, displayName })
    set({ identity: session.identity, status: statusOf(session.identity) })
    return session.redirectTo
  },

  claimGuestAccount: async (input) => {
    const claimed = await authApi.claimGuestAccount(input)
    set({ identity: claimed.identity, status: 'authenticated' })
    return claimed
  },

  logout: async () => {
    try {
      await authApi.logout()
    } finally {
      // "Log me out" has exactly one acceptable outcome from the browser's
      // side, whatever the server managed to do about it.
      set({ identity: null, status: 'anonymous' })
    }
  },

  onSessionLost: () => {
    set({ identity: null, status: 'anonymous' })
  },
}))

// Registered rather than imported by `client.ts`, which would make a cycle.
setSessionLostHandler(() => {
  useAuthStore.getState().onSessionLost()
})

/** Test seam — the module-level bootstrap promise outlives a single test. */
export function resetAuthStore(): void {
  bootstrapping = null
  useAuthStore.setState({ identity: null, status: 'unknown', loading: false })
}
