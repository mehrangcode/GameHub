import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { socketManager } from '@/socket/manager'
import { useChatStore } from '@/stores/chatStore'
import { useGameStore } from '@/stores/gameStore'
import { useTableStore } from '@/stores/tableStore'
import { useWalletStore } from '@/stores/walletStore'
import { TableShell } from './TableShell'

/**
 * `/table/:tableId` — connect, join, and hand off to the shell (06 §5.1).
 *
 * The socket is **acquired**, not created: `socketManager` owns exactly one
 * connection for the tab's whole life. A `useEffect` that called `io()` would
 * open a second under StrictMode's double-invoke and a third on the next fast
 * refresh, and the duplicate room memberships are miserable to debug because
 * everything works — twice.
 */
export function TablePage() {
  const { tableId = '' } = useParams()
  const { t } = useTranslation()
  const connectedTableId = useTableStore((s) => s.connectedTableId)

  useEffect(() => {
    if (tableId === '') return

    socketManager.acquire()
    void socketManager.joinTable(tableId)

    return () => {
      socketManager.release()
      // Deliberately no `leaveTable` here: React unmounts and remounts under
      // StrictMode, and leaving on the first pass would drop the room the
      // second pass expects to be in. Presence is driven by the socket's own
      // lifecycle and its disconnect grace, which is the thing that actually
      // knows whether the player left.
    }
  }, [tableId])

  // A different table means a different game, a different transcript, and a
  // different set of balances to watch. Reset rather than let one table's
  // state bleed into the next.
  useEffect(() => {
    if (connectedTableId !== null && connectedTableId !== tableId) {
      useGameStore.getState().reset()
      useChatStore.getState().reset()
    }
  }, [connectedTableId, tableId])

  useEffect(() => {
    void useWalletStore.getState().hydrate()
  }, [])

  if (tableId === '') {
    return (
      <AppShell>
        <p>{t('notFound.title')}</p>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <TableShell />
    </AppShell>
  )
}
