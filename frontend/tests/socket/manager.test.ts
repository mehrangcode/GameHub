import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * S42 — socket discipline.
 *
 * ★ **One socket per tab.** The manager owns the connection, and nothing else
 * may create one. A `useEffect` calling `io()` opens a second under StrictMode's
 * double-invoke and a third on the next fast refresh — and the resulting
 * duplicate room memberships are miserable to debug precisely because
 * everything still *works*, twice: every event arrives twice, every chat line
 * renders twice, and every move is acked twice.
 */

const factory = vi.fn()

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => {
    factory(...args)
    return {
      connected: true,
      on: vi.fn(),
      emit: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
  },
}))

beforeEach(() => {
  factory.mockClear()
  vi.resetModules()
})

describe('connection lifecycle', () => {
  it('★ creates EXACTLY ONE socket across many acquires', async () => {
    const { socketManager } = await import('../../src/socket/manager')

    socketManager.acquire()
    socketManager.acquire()
    socketManager.acquire()
    socketManager.connect()

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('★ does NOT disconnect when the last component releases', async () => {
    const { socketManager } = await import('../../src/socket/manager')

    socketManager.acquire()
    socketManager.release()
    socketManager.acquire()

    // Navigating table → lobby → table must not renegotiate a websocket. An
    // idle connection costs the server almost nothing; a reconnect costs the
    // player a resync.
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('declares the protocol version in the handshake', async () => {
    const { socketManager } = await import('../../src/socket/manager')
    const { PROTOCOL_VERSION, PROTOCOL_VERSION_AUTH_KEY } = await import(
      '../../src/contracts/events'
    )

    socketManager.connect()

    // A mismatch after a deploy is then one payload rather than a series of
    // confusing mid-game failures.
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { [PROTOCOL_VERSION_AUTH_KEY]: PROTOCOL_VERSION },
        withCredentials: true,
      }),
    )
  })

  it('uses the reconnection backoff from 04 §1.2', async () => {
    const { socketManager } = await import('../../src/socket/manager')

    socketManager.connect()

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ reconnectionDelay: 500, reconnectionDelayMax: 5_000 }),
    )
  })
})

describe('★ no optimistic game state (06 §4.3)', () => {
  it('the manager never writes to the game view or legalMoves', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const source = readFileSync(path.resolve('src/socket/manager.ts'), 'utf8')

    // `markPending` is the only thing a move may do locally: it lifts the card
    // and disables input. Anything that set `view` or `legalMoves` outside an
    // incoming `game:state` would be the client predicting a rule.
    expect(source).not.toMatch(/setState\(\{[^}]*\bview\b/)
    expect(source).not.toMatch(/legalMoves:/)
    expect(source).toContain('markPending')
  })

  it('retains one clientMoveId per move, so a retry cannot play twice', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const source = readFileSync(path.resolve('src/socket/manager.ts'), 'utf8')

    // Generated once, before the emit — not inside a retry loop (03 §4.4).
    const move = source.slice(source.indexOf('async move('), source.indexOf('async requestSync('))
    expect(move.match(/randomUUID/g)).toHaveLength(1)
  })
})
