import { create } from 'zustand'

/**
 * Ephemeral UI state — dismissed nudges, open panels, toasts (06 §3).
 *
 * Dismissals persist to `localStorage`: a nudge the player closed must stay
 * closed across a reload, or "dismissible" is a lie that costs more goodwill
 * than never showing it would have.
 */

const STORAGE_KEY = 'dismissedNudges'

export type NudgeId = 'guestClaim'

interface UiState {
  dismissedNudges: NudgeId[]
  toast: { message: string; tone: 'info' | 'danger' } | null

  dismissNudge: (id: NudgeId) => void
  showToast: (message: string, tone?: 'info' | 'danger') => void
  clearToast: () => void
}

function readDismissed(): NudgeId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? [] : (JSON.parse(raw) as NudgeId[])
  } catch {
    return []
  }
}

export const useUiStore = create<UiState>()((set, get) => ({
  dismissedNudges: readDismissed(),
  toast: null,

  dismissNudge: (id) => {
    const next = [...new Set([...get().dismissedNudges, id])]
    set({ dismissedNudges: next })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Storage disabled — it stays dismissed for this page at least.
    }
  },

  showToast: (message, tone = 'info') => {
    set({ toast: { message, tone } })
  },

  clearToast: () => {
    set({ toast: null })
  },
}))
