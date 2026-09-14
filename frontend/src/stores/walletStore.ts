import { create } from 'zustand'
import { getWallet } from '@/api/wallet'
import type { WalletUpdatedPayload } from '@/contracts/events'
import type { AssetCode, WalletStatus } from '@/contracts/enums'

/**
 * Balances — 06 §3.4, 10 §10.
 *
 * ★ **Display only.** The number here is never the basis for a purchase: a
 * purchase re-reads and row-locks server-side (07 §11.3). The client greys out
 * an unaffordable item as a *courtesy*, exactly as it greys out an illegal
 * card — helpful, never authoritative.
 *
 * `vested` and `provisional` stay separate rather than collapsing into one
 * total, because they mean different things to the person reading them: a
 * guest's provisional balance **is** the signup pitch ("120 coins waiting"),
 * and a single number makes that pitch impossible to write.
 */

export interface AssetBalance {
  balance: number
  status: WalletStatus
}

interface WalletState {
  balances: Partial<Record<AssetCode, AssetBalance>>
  /** True for a guest: the coins exist and cannot be spent until signup. */
  isProvisional: boolean
  loaded: boolean
  lastReward: { coins: number; forfeited: boolean; reasonKey: string | null } | null

  hydrate: () => Promise<void>
  applyUpdate: (payload: WalletUpdatedPayload) => void
  setLastReward: (reward: WalletState['lastReward']) => void
  reset: () => void
}

export const useWalletStore = create<WalletState>()((set, get) => ({
  balances: {},
  isProvisional: false,
  loaded: false,
  lastReward: null,

  hydrate: async () => {
    try {
      const summary = await getWallet()
      const balances: Partial<Record<AssetCode, AssetBalance>> = {}

      for (const row of summary.balances) {
        balances[row.asset] = { balance: row.balance, status: row.status }
      }

      set({
        balances,
        isProvisional: summary.balances.some((row) => row.status === 'PROVISIONAL'),
        loaded: true,
      })
    } catch {
      // Anonymous (401). An empty purse is the correct render, not an error.
      set({ balances: {}, isProvisional: false, loaded: true })
    }
  },

  applyUpdate: (payload) => {
    // The socket reports vested and provisional separately; a holder is only
    // ever one or the other, so whichever is non-zero is the live balance.
    const provisional = payload.provisional > 0
    const balances = {
      ...get().balances,
      [payload.asset]: {
        balance: provisional ? payload.provisional : payload.vested,
        status: (provisional ? 'PROVISIONAL' : 'VESTED') satisfies WalletStatus,
      },
    }

    set({
      balances,
      isProvisional: Object.values(balances).some((b) => b.status === 'PROVISIONAL'),
      loaded: true,
    })
  },

  setLastReward: (lastReward) => {
    set({ lastReward })
  },

  reset: () => {
    set({ balances: {}, isProvisional: false, loaded: false, lastReward: null })
  },
}))
