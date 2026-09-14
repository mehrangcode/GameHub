import { create } from 'zustand'
import type { ChatMessageView } from '@/contracts/dto/chat'

/**
 * Table chat — 06 §3.
 *
 * ★ Chat **is** optimistic, unlike game state (06 §4.3). The distinction is not
 * inconsistency: a chat line is not adjudicated by anything, so showing it
 * immediately and reconciling on the ack costs nothing if it fails. A card is
 * adjudicated by an engine, and an optimistic play the server then rejects is
 * worse than 80 ms of latency.
 *
 * A SYSTEM message carries an **i18n key in `body`** and its arguments in
 * `params` — never a rendered sentence. That is what lets a Persian reader open
 * a transcript written while an English speaker was at the table and read it in
 * Persian.
 */

export interface PendingMessage {
  localId: string
  body: string
  failed: boolean
}

interface ChatState {
  messages: ChatMessageView[]
  pending: PendingMessage[]
  unread: number

  hydrate: (messages: readonly ChatMessageView[]) => void
  append: (message: ChatMessageView) => void
  addPending: (localId: string, body: string) => void
  resolvePending: (localId: string) => void
  failPending: (localId: string) => void
  markRead: () => void
  reset: () => void
}

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  pending: [],
  unread: 0,

  hydrate: (messages) => {
    // Oldest first, as the server sends them — so the client appends rather
    // than reverses, and a long transcript costs one array copy instead of a
    // sort on every render.
    set({ messages: [...messages], pending: [], unread: 0 })
  },

  append: (message) => {
    const { messages } = get()
    if (messages.some((existing) => existing.id === message.id)) return

    set({
      messages: [...messages.slice(-299), message],
      // Your own message arriving back is not an unread message.
      unread: message.author.isSelf ? get().unread : get().unread + 1,
    })
  },

  addPending: (localId, body) => {
    set({ pending: [...get().pending, { localId, body, failed: false }] })
  },

  resolvePending: (localId) => {
    // The real message arrives over `chat:message` and replaces this one.
    set({ pending: get().pending.filter((p) => p.localId !== localId) })
  },

  failPending: (localId) => {
    set({
      pending: get().pending.map((p) => (p.localId === localId ? { ...p, failed: true } : p)),
    })
  },

  markRead: () => {
    set({ unread: 0 })
  },

  reset: () => {
    set({ messages: [], pending: [], unread: 0 })
  },
}))
