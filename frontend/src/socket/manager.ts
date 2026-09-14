import { io, type Socket } from 'socket.io-client'
import { api } from '@/api/client'
import type { SocketAck } from '@/contracts/errors'
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_AUTH_KEY,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@/contracts/events'
import { translateServerKey } from '@/i18n'
import { useAuthStore } from '@/stores/authStore'
import { useChatStore } from '@/stores/chatStore'
import { useGameStore } from '@/stores/gameStore'
import { useSocketStore } from '@/stores/socketStore'
import { useTableStore } from '@/stores/tableStore'
import { useWalletStore } from '@/stores/walletStore'

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>

/**
 * ★ **One socket per tab**, owned by this module — 06 §4.2.
 *
 * Never created inside a component: a `useEffect` that opens a socket opens
 * several under StrictMode's double-invoke and again on every fast refresh,
 * and the resulting duplicate room memberships are miserable to debug because
 * everything *works*, twice.
 *
 * Connecting is reference-counted rather than tied to a route: two mounted
 * components may both want the socket, and the last one to unmount is the one
 * that may close it.
 */
class SocketManager {
  private socket: TypedSocket | null = null
  private refCount = 0
  private refreshTried = false
  /** The table to re-join after a reconnect, and the game to resync. */
  private joinedTableId: string | null = null

  get raw(): TypedSocket | null {
    return this.socket
  }

  acquire(): void {
    this.refCount += 1
    this.connect()
  }

  release(): void {
    this.refCount = Math.max(0, this.refCount - 1)
    // Deliberately does NOT disconnect at zero. Navigating from the table to
    // the lobby and back should not renegotiate a websocket, and an idle
    // connection costs the server almost nothing.
  }

  connect(): void {
    if (this.socket !== null) {
      if (!this.socket.connected) this.socket.connect()
      return
    }

    useSocketStore.getState().setState('connecting')

    this.socket = io({
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      // The version travels in the handshake so a mismatch after a deploy is
      // one payload rather than a series of confusing failures mid-game.
      auth: { [PROTOCOL_VERSION_AUTH_KEY]: PROTOCOL_VERSION },
    })

    this.bind(this.socket)
  }

  private bind(socket: TypedSocket): void {
    socket.on('connect', () => {
      this.refreshTried = false
      useSocketStore.getState().setState('connected')
      useSocketStore.getState().setError(null)

      // ★ Rejoin and resync on every connect, including reconnects. This — not
      // the seq heuristic in `gameStore` — is what makes recovery correct: on
      // a live connection delivery is ordered and reliable, so the only way to
      // miss a message is a disconnect, and this is where one ends.
      const tableId = this.joinedTableId
      if (tableId !== null) void this.joinTable(tableId)
    })

    socket.on('connected', (payload) => {
      useSocketStore.getState().setClockOffset(payload.serverTime)
      useSocketStore
        .getState()
        .setProtocolMismatch(payload.protocolVersion !== PROTOCOL_VERSION)
    })

    socket.on('disconnect', (reason) => {
      // 'io client disconnect' is us, deliberately; everything else is a drop
      // socket.io will retry on its own.
      useSocketStore
        .getState()
        .setState(reason === 'io client disconnect' ? 'idle' : 'reconnecting')
    })

    socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      if (error.data?.code === 'UNAUTHORIZED' && !this.refreshTried) {
        // The access cookie expired while the socket was down. One refresh,
        // then reconnect — the same single-flight discipline the REST client
        // uses, and for the same reason: rotation kills a reused family.
        this.refreshTried = true
        void api
          .post('/auth/refresh')
          .then(() => {
            this.socket?.connect()
          })
          .catch(() => {
            useAuthStore.getState().onSessionLost()
            useSocketStore.getState().setState('failed')
          })
        return
      }
      useSocketStore.getState().setState('reconnecting')
    })

    // ── Table ───────────────────────────────────────────────────────────────
    socket.on('table:snapshot', (payload) => {
      useTableStore.getState().hydrate(payload)
      useChatStore.getState().hydrate(payload.chat)
      useSocketStore.getState().setClockOffset(payload.serverTime)
    })
    socket.on('table:memberJoined', (p) => useTableStore.getState().applyMemberJoined(p))
    socket.on('table:memberLeft', (p) => useTableStore.getState().applyMemberLeft(p))
    socket.on('table:seatChanged', (p) => useTableStore.getState().applySeatChanged(p))
    socket.on('table:optionsChanged', (p) => useTableStore.getState().applyOptionsChanged(p))
    socket.on('table:statusChanged', (p) => useTableStore.getState().applyStatusChanged(p))
    socket.on('table:presence', (p) => useTableStore.getState().applyPresence(p))

    socket.on('chat:message', (p) => useChatStore.getState().append(p.message))

    // ── Game ────────────────────────────────────────────────────────────────
    socket.on('game:started', (p) => useGameStore.getState().onStarted(p))

    socket.on('game:state', (payload) => {
      if (useGameStore.getState().applyServerState(payload)) {
        void this.requestSync(payload.gameId)
      }
    })

    socket.on('game:event', (payload) => {
      if (useGameStore.getState().appendNarration(payload)) {
        void this.requestSync(payload.gameId)
      }
    })

    socket.on('game:syncRequired', (payload) => {
      useGameStore.getState().setSyncing(true)
      void this.requestSync(payload.gameId, payload.reason === 'AHEAD_OF_SERVER')
    })

    socket.on('game:moveRejected', (payload) => {
      // The move did not happen. Clearing `pendingMoveId` re-enables input;
      // nothing about the game state changes, because nothing about it changed
      // on the server either.
      useGameStore.getState().markPending(null)
      useSocketStore.getState().setError(translateServerKey(payload.i18nKey, payload.details))
    })

    socket.on('game:finished', (p) => useGameStore.getState().applyFinished(p))

    // ── Turn enforcement ────────────────────────────────────────────────────
    socket.on('game:turnTimer', (p) => useGameStore.getState().applyTurnTimer(p))
    socket.on('game:ejectionWarning', (p) =>
      useGameStore.getState().applyWarning(p.secondsRemaining, p.consequence),
    )
    socket.on('game:playerEjected', (p) => useGameStore.getState().applyEjection(p))
    socket.on('game:playerReturned', (p) => useGameStore.getState().applyReturn(p))

    // ── Economy ─────────────────────────────────────────────────────────────
    socket.on('game:rewardSettled', (p) => useGameStore.getState().applyReward(p))
    socket.on('wallet:updated', (p) => useWalletStore.getState().applyUpdate(p))

    socket.on('error', (payload) => {
      useSocketStore.getState().setError(translateServerKey(payload.i18nKey, payload.details))
    })
  }

  // ── Emitting ──────────────────────────────────────────────────────────────

  /**
   * Every client→server event answers with an ack. Rejecting on the failure arm
   * means callers use ordinary `try`/`catch` and cannot forget to check `ok`.
   */
  private emit<E extends keyof ClientToServerEvents, T>(
    event: E,
    payload: Parameters<ClientToServerEvents[E]>[0],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket
      if (socket === null) {
        reject({ code: 'INTERNAL', i18nKey: 'errors.network' })
        return
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(socket.emit as any)(event, payload, (ack: SocketAck<T>) => {
        if (ack.ok) resolve(ack.data)
        else reject(ack)
      })
    })
  }

  async joinTable(tableId: string, asSpectator = false): Promise<void> {
    this.joinedTableId = tableId
    await this.emit('table:join', { tableId, ...(asSpectator ? { asSpectator: true } : {}) })

    // A join is also the moment to catch up on a game already in progress.
    const { gameId, seq } = useGameStore.getState()
    if (gameId !== null) await this.requestSync(gameId, false, seq)
  }

  async leaveTable(tableId: string): Promise<void> {
    this.joinedTableId = null
    await this.emit('table:leave', { tableId })
  }

  takeSeat(tableId: string, seat: number): Promise<unknown> {
    return this.emit('table:takeSeat', { tableId, seat })
  }

  releaseSeat(tableId: string): Promise<unknown> {
    return this.emit('table:releaseSeat', { tableId })
  }

  addBot(tableId: string, seat: number): Promise<unknown> {
    return this.emit('table:addBot', { tableId, seat, difficulty: 'medium' })
  }

  removeBot(tableId: string, seat: number): Promise<unknown> {
    return this.emit('table:removeBot', { tableId, seat })
  }

  startGame(tableId: string): Promise<unknown> {
    return this.emit('game:start', { tableId })
  }

  reclaimSeat(gameId: string): Promise<unknown> {
    return this.emit('game:reclaimSeat', { gameId })
  }

  async sendChat(tableId: string, body: string): Promise<void> {
    const localId = crypto.randomUUID()
    useChatStore.getState().addPending(localId, body)
    try {
      await this.emit('chat:send', { tableId, body })
      useChatStore.getState().resolvePending(localId)
    } catch (error) {
      useChatStore.getState().failPending(localId)
      throw error
    }
  }

  /**
   * ★ No optimistic game update — 06 §4.3.
   *
   * `markPending` lifts the card and disables input, which is what makes the
   * round-trip feel responsive. The board itself changes only when `game:state`
   * arrives, because the client has no idea whether the move was legal and
   * guessing wrong is worse than waiting 80 ms.
   *
   * `clientMoveId` is generated once and **retained** for the retry, so a
   * dropped ack followed by a resend plays one card, not two (03 §4.4).
   */
  async move(gameId: string, move: Record<string, unknown>): Promise<void> {
    const clientMoveId = crypto.randomUUID()
    useGameStore.getState().markPending(clientMoveId)

    try {
      await this.emit('game:move', { gameId, move, clientMoveId })
    } catch (error) {
      useGameStore.getState().markPending(null)
      throw error
    }
  }

  async requestSync(gameId: string, full = false, lastSeq?: number): Promise<void> {
    const seq = lastSeq ?? useGameStore.getState().seq
    try {
      // Omitting `lastSeq` asks for a full snapshot, which is *always* correct.
      // Never guess at reconciliation: a client that does not know where it
      // stands says so.
      await this.emit('game:requestSync', {
        gameId,
        ...(full || seq === 0 ? {} : { lastSeq: seq }),
      })
    } finally {
      useGameStore.getState().setSyncing(false)
    }
  }

  /** Full teardown. Used on sign-out, where the identity behind it is gone. */
  disconnect(): void {
    this.joinedTableId = null
    this.refCount = 0
    this.socket?.disconnect()
    this.socket = null
    useSocketStore.getState().setState('idle')
  }
}

export const socketManager = new SocketManager()
