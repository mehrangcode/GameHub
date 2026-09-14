import { create } from 'zustand'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

interface SocketState {
  state: ConnectionState
  /**
   * ★ `serverTime − Date.now()`, measured at handshake.
   *
   * Every countdown in the app is rendered as `endsAt − (Date.now() + offset)`.
   * A player whose system clock is ten minutes fast must still see the deadline
   * that can eject them and forfeit their coins — which is why deadlines cross
   * the wire as absolute instants and why this number exists at all.
   */
  clockOffset: number
  /** Set when the server's protocol version differs from ours — 04 §1.2. */
  protocolMismatch: boolean
  /** Localized; rendered as a banner. */
  error: string | null

  setState: (state: ConnectionState) => void
  setClockOffset: (serverTime: number) => void
  setProtocolMismatch: (mismatch: boolean) => void
  setError: (error: string | null) => void
}

export const useSocketStore = create<SocketState>()((set) => ({
  state: 'idle',
  clockOffset: 0,
  protocolMismatch: false,
  error: null,

  setState: (state) => {
    set({ state })
  },

  setClockOffset: (serverTime) => {
    set({ clockOffset: serverTime - Date.now() })
  },

  setProtocolMismatch: (protocolMismatch) => {
    set({ protocolMismatch })
  },

  setError: (error) => {
    set({ error })
  },
}))

/** `Date.now()` corrected by the handshake offset. The only clock the UI trusts. */
export function serverNow(): number {
  return Date.now() + useSocketStore.getState().clockOffset
}
