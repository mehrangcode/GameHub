import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { MAX_SOCKETS_PER_IDENTITY } from '../../config/socketLimits.js'
import type { Container } from '../../container.js'
import { PROTOCOL_VERSION } from '../../contracts/events.js'
import { holderKey } from '../../domain/value-objects/identity.js'
import { createRedisSocketAdapter } from '../../infrastructure/redis/socketAdapter.js'
import { identityRefOf } from '../http/middleware/authorize.js'
import { registerChatHandlers } from './handlers/chat.handlers.js'
import { registerGameHandlers } from './handlers/game.handlers.js'
import { registerPresenceHandlers } from './handlers/presence.handlers.js'
import { registerTableHandlers } from './handlers/table.handlers.js'
import { resolveHandshake, HandshakeError, type HandshakeRequest } from './identity.js'
import { SocketRealtimePublisher, type GatewayServer } from './publisher.js'
import type { AckContext } from './ack.js'
import { socketContext, type GatewaySocket } from './context.js'

/**
 * The Socket.IO gateway — S23, 04 §1.
 *
 * A **single namespace** (`/`). Per-table namespaces would look tidier and are
 * the wrong tool: rooms already give per-table addressing, and namespaces would
 * complicate the Redis adapter (S27) for no benefit.
 *
 * The transport configuration below is 04 §1.2 exactly, and the one value worth
 * defending is `maxHttpBufferSize`. **100 KB.** Every payload this protocol
 * carries is a few hundred bytes — a seat number, a card, a chat line. A frame
 * larger than 100 KB is therefore not a big move; it is a bug or an attack, and
 * the cheapest place to refuse it is before it is buffered.
 *
 * ### Why the gateway takes an already-built container
 *
 * There is a genuine cycle: the services need to broadcast, broadcasting needs
 * the Socket.IO server, and the server's handlers need the services.
 * `container.realtime` is a `MutableRealtimePublisher` that drops everything
 * until this function attaches the real one — which also means every service is
 * exercisable in a test with no transport at all, and that is how most of
 * Phase F's assertions are written.
 */

export interface Gateway {
  readonly io: GatewayServer
  close(): Promise<void>
}

export interface GatewayOptions {
  /** Attached to an existing HTTP server so REST and the socket share a port. */
  readonly httpServer: HttpServer
  readonly container: Container
}

export function createGateway({ httpServer, container }: GatewayOptions): Gateway {
  const { env, logger } = container

  const io: GatewayServer = new Server(httpServer, {
    // WebSocket preferred; polling stays as the fallback for hostile networks
    // and corporate proxies, which is not a rare case in practice.
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e5,
    cors: {
      origin: env.CORS_ORIGIN,
      // Without this the browser sends no cookies with the handshake, and every
      // connection is anonymous — which presents as "auth is broken" rather
      // than as a CORS setting.
      credentials: true,
    },
  })

  /**
   * S27 — with `REDIS_URL` set, `io.to(room).emit(...)` reaches sockets on every
   * instance; without it, rooms are per-process, which is correct for the
   * single-process deployment M0 targets.
   */
  const adapter =
    container.redis === null ? null : createRedisSocketAdapter(container.redis, logger)
  if (adapter !== null) io.adapter(adapter.adapter)

  container.realtime.attach(new SocketRealtimePublisher(io))
  container.presence.start()

  /**
   * Whatever the previous process left in the mirror describes sockets that no
   * longer exist. Clearing it at boot — before the first connection — is what
   * makes "presence recomputes after a restart" true: every live client
   * reconnects within seconds and re-announces itself, and the tables nobody
   * rejoins simply have no entries rather than phantom ones.
   */
  void container.presenceMirror
    ?.clearAll()
    .then((cleared) => {
      if (cleared > 0) logger.info({ cleared }, 'cleared stale presence mirrors')
    })
    .catch(() => undefined)

  /**
   * ★ Handshake identity, resolved once (04 §1.1).
   *
   * On success the identity is written to `socket.data` **non-writably and
   * frozen**. That is not decoration: it makes "identity is immutable for the
   * socket's life" a property of the object rather than a convention every
   * future handler has to honour, and `tests/integration/socket/handshake.test.ts`
   * asserts a reassignment genuinely fails.
   */
  io.use((socket, next) => {
    const request: HandshakeRequest = {
      cookieHeader: socket.handshake.headers.cookie,
      ip: clientAddress(socket, env.NODE_ENV === 'production'),
      userAgent: socket.handshake.headers['user-agent'] ?? null,
      auth: (socket.handshake.auth ?? {}) as Record<string, unknown>,
    }

    void resolveHandshake(request, {
      users: container.repos.users,
      guests: container.guests,
      security: container.security,
      metrics: container.metrics,
      rateLimiter: container.rateLimiter,
      logger,
      env,
    })
      .then(({ identity, clientProtocolVersion }) => {
        Object.defineProperty(socket.data, 'identity', {
          value: Object.freeze(identity),
          writable: false,
          configurable: false,
          enumerable: true,
        })

        Object.assign(socket.data, {
          tables: new Set<string>(),
          connectedAt: Date.now(),
          clientProtocolVersion,
          ip: request.ip,
          userAgent: request.userAgent,
        })

        next()
      })
      .catch((error: unknown) => {
        next(error instanceof HandshakeError ? error : new Error('UNAUTHORIZED'))
      })
  })

  io.on('connection', (socket) => {
    void onConnection(container, socket as GatewaySocket)
  })

  return {
    io,
    async close() {
      container.presence.stop()
      container.realtime.detach()
      await io.close()
      await adapter?.close()
    },
  }
}

async function onConnection(container: Container, socket: GatewaySocket): Promise<void> {
  const context = socketContext(container, socket)
  const ack: AckContext = {
    socketId: socket.id,
    logger: context.logger,
    onRejected: (code) => {
      container.metrics.increment('socket_events_rejected')
      // A payload rejected for carrying an unknown key is the signature of
      // somebody trying `{ tableId, seat, userId }`. Our own clients never send
      // one — the schemas are generated from the same file the server reads —
      // so this counter should sit at zero forever, and any movement is worth a
      // look. (The *rejection* is what protects us; the counter is what tells
      // us it happened.)
      if (code === 'VALIDATION_FAILED') {
        container.metrics.increment('socket_identity_spoof_attempts')
      }
    },
  }

  container.metrics.increment('socket_connections')
  container.metrics.adjust('active_sockets', 1)

  await evictSurplusSockets(container, socket)

  socket.emit('connected', {
    serverTime: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
    clientProtocolVersion: socket.data.clientProtocolVersion,
  })

  /**
   * A version mismatch is *reported*, not refused.
   *
   * Refusing would be tidier and would leave an out-of-date page with no way to
   * explain itself — a connect error is a dead screen, whereas an `error` event
   * on a live socket is a banner that says "please refresh". The protection
   * comes from the Zod schemas either way: an old client's payloads either
   * parse or they do not.
   */
  if (
    socket.data.clientProtocolVersion !== null &&
    socket.data.clientProtocolVersion !== PROTOCOL_VERSION
  ) {
    socket.emit('error', {
      code: 'VALIDATION_FAILED',
      i18nKey: 'errors.protocolVersionMismatch',
      details: { server: PROTOCOL_VERSION, client: socket.data.clientProtocolVersion },
    })
  }

  registerTableHandlers({ context, ack })
  registerPresenceHandlers({ context, ack })
  registerChatHandlers({ context, ack })
  registerGameHandlers({ context, ack })

  socket.on('disconnect', (reason) => {
    container.metrics.adjust('active_sockets', -1)
    context.logger.debug({ reason }, 'socket disconnected')

    // Every table this socket was watching starts its own grace clock —
    // independently, because the games have different windows and a player at
    // two tables is only absent from both by coincidence.
    for (const tableId of socket.data.tables) {
      void container.presence
        .detach(tableId, context.ref, socket.id)
        .catch((error: unknown) => context.logger.error({ err: error }, 'presence detach failed'))
    }
  })
}

/**
 * Five concurrent sockets per identity, oldest evicted (04 §8).
 *
 * Evicting the oldest rather than refusing the newest is the whole design.
 * Refusal produces "it stopped working until I closed every tab", and the tabs
 * a user needs to close are usually the ones a browser is holding open
 * invisibly after a crash — so the user cannot act on the advice. Dropping the
 * stalest connection is invisible when it is a leak and obvious when it is not.
 */
async function evictSurplusSockets(container: Container, socket: GatewaySocket): Promise<void> {
  const key = holderKey(identityRefOf(socket.data.identity))

  const mine = (await socket.nsp.fetchSockets())
    .filter((candidate) => holderKey(identityRefOf(candidate.data.identity)) === key)
    // Oldest first, so the slice taken off the front is the stale end.
    .sort((a, b) => a.data.connectedAt - b.data.connectedAt)

  for (const victim of mine.slice(0, Math.max(0, mine.length - MAX_SOCKETS_PER_IDENTITY))) {
    // Never the socket that just arrived: evicting the newcomer would turn a
    // leak into "the app stops working after five refreshes", which is the
    // failure this limit exists to avoid.
    if (victim.id === socket.id) continue
    container.metrics.increment('socket_evicted_oldest')
    victim.disconnect(true)
  }
}

/**
 * The peer address, or the forwarded one behind Caddy (S46).
 *
 * `X-Forwarded-For` is trusted **only in production**, matching `app.ts`'s
 * `trust proxy` setting exactly. Trusting it in development would let anyone
 * defeat the handshake-failure budget by sending one header.
 */
function clientAddress(
  socket: { handshake: { headers: Record<string, unknown>; address: string } },
  trustProxy: boolean,
): string | null {
  const forwarded = socket.handshake.headers['x-forwarded-for']
  if (trustProxy && typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() ?? null
  }
  return socket.handshake.address || null
}
