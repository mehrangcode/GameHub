import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import request from 'supertest'
import { io as connect, type Socket } from 'socket.io-client'
import { buildApp } from '../../src/app.js'
import { buildContainer, type Container, type ContainerOverrides } from '../../src/container.js'
import type { SocketAck } from '../../src/contracts/errors.js'
import type { ClientToServerEvents, ServerToClientEvents } from '../../src/contracts/events.js'
import { PROTOCOL_VERSION } from '../../src/contracts/events.js'
import { SlidingWindowRateLimiter } from '../../src/infrastructure/rateLimit/slidingWindow.js'
import { createGateway, type Gateway } from '../../src/interface/socket/gateway.js'
import { FakeClock } from '../fakes/clock.js'
import { db } from './db.js'

/**
 * A real gateway on a real ephemeral port, with real `socket.io-client`
 * connections — S23.
 *
 * These tests are deliberately end-to-end across the transport. A handler
 * tested in isolation would pass with the handshake middleware unmounted, with
 * the rooms wired to the wrong names, and with the payload schemas bypassed —
 * which is to say it would pass while every property Phase F exists to
 * establish was broken. So the harness pays for a genuine listen and a genuine
 * upgrade, and every assertion below is about behaviour a browser would see.
 *
 * The **clock** is still faked (`FakeClock`), because the alternative is a test
 * suite that sits through a 15-second grace window. Time is the one thing
 * injected; everything else is the real thing.
 */

const silent = pino({ level: 'silent' })

export interface SocketHarness {
  readonly container: Container
  readonly gateway: Gateway
  readonly httpServer: HttpServer
  readonly url: string
  readonly clock: FakeClock
  /** Registers a user over the real HTTP endpoint and keeps its cookie header. */
  register(displayName?: string): Promise<Session>
  guest(inviteCode: string, displayName?: string): Promise<Session>
  /**
   * Forgets every rate-limit bucket. Call it in `beforeEach`.
   *
   * The harness is built once per file, so without this the second half of a
   * file runs against a budget the first half already spent — and because chat
   * is limited **per identity**, one test that deliberately floods the limiter
   * silently throttles every later test that reuses the same account. The
   * failures look like missing broadcasts, which is a genuinely slow thing to
   * diagnose.
   */
  resetLimits(): void
  /** Opens a client, resolving once `connected` has arrived. */
  open(session: Session, options?: OpenOptions): Promise<TestClient>
  close(): Promise<void>
}

export interface Session {
  readonly cookie: string
  readonly displayName: string
  readonly body: Record<string, unknown>
}

export interface OpenOptions {
  readonly protocolVersion?: number | null
}

export interface HarnessOptions extends ContainerOverrides {
  /** Every disconnect grace, in fake milliseconds. Small so a test can step over it. */
  readonly graceMs?: number
}

export async function startSocketHarness(options: HarnessOptions = {}): Promise<SocketHarness> {
  const clock = new FakeClock()
  const rateLimiter = options.rateLimiter ?? new SlidingWindowRateLimiter(0)

  const container = buildContainer({
    prisma: db,
    logger: silent,
    rateLimiter,
    clock,
    graceMsOverride: options.graceMs ?? 10_000,
    ...options,
  })

  const app = buildApp(container)
  const httpServer = createServer(app)
  const gateway = createGateway({ httpServer, container })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`

  const clients: TestClient[] = []

  return {
    container,
    gateway,
    httpServer,
    url,
    clock,

    async register(displayName = 'Tester') {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: `u${unique()}@test.dev`,
          password: 'correct-horse-battery',
          displayName,
        })
        .expect(201)

      return {
        cookie: cookieHeaderOf(response),
        displayName,
        body: response.body as Record<string, unknown>,
      }
    },

    async guest(inviteCode, displayName = 'Guest') {
      const response = await request(app)
        .post('/api/v1/auth/guest')
        .send({ inviteCode, displayName })
        .expect(201)

      return {
        cookie: cookieHeaderOf(response),
        displayName,
        body: response.body as Record<string, unknown>,
      }
    },

    async open(session, openOptions = {}) {
      const client = await openClient(url, session.cookie, openOptions)
      clients.push(client)
      return client
    },

    resetLimits() {
      if (rateLimiter instanceof SlidingWindowRateLimiter) rateLimiter.clear()
    },

    async close() {
      for (const client of clients) client.socket.close()
      await gateway.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      rateLimiter.dispose()
    },
  }
}

// ── The client ───────────────────────────────────────────────────────────────

export interface TestClient {
  readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>
  /** Every event received, in order. The transcript most assertions read. */
  readonly received: Array<{ event: string; payload: unknown }>
  emit<T = unknown>(event: string, payload: unknown): Promise<SocketAck<T>>
  /** Resolves with the next matching event, or rejects after `timeoutMs`. */
  next<T = unknown>(event: string, timeoutMs?: number): Promise<T>
  of(event: string): unknown[]
  clear(): void
  close(): void
}

const OBSERVED = [
  'connected',
  'table:snapshot',
  'table:memberJoined',
  'table:memberLeft',
  'table:seatChanged',
  'table:optionsChanged',
  'table:statusChanged',
  'table:presence',
  'chat:message',
  'game:started',
  'game:state',
  'game:event',
  'game:moveRejected',
  'game:finished',
  'game:syncRequired',
  'error',
] as const

export async function openClient(
  url: string,
  cookie: string,
  options: OpenOptions = {},
): Promise<TestClient> {
  const version = options.protocolVersion === undefined ? PROTOCOL_VERSION : options.protocolVersion

  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = connect(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie === '' ? {} : { Cookie: cookie },
    ...(version === null ? {} : { auth: { protocolVersion: version } }),
  })

  const received: Array<{ event: string; payload: unknown }> = []
  const waiters: Array<{ event: string; resolve: (payload: unknown) => void }> = []

  for (const event of OBSERVED) {
    socket.on(
      event as never,
      ((payload: unknown) => {
        received.push({ event, payload })
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index]
          if (waiter?.event === event) {
            waiters.splice(index, 1)
            waiter.resolve(payload)
          }
        }
      }) as never,
    )
  }

  const client: TestClient = {
    socket,
    received,

    async emit<T>(event: string, payload: unknown): Promise<SocketAck<T>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 5_000)
        ;(socket as unknown as Emitter).emit(event, payload, (ack: SocketAck<T>) => {
          clearTimeout(timer)
          resolve(ack)
        })
      })
    },

    async next<T>(event: string, timeoutMs = 3_000): Promise<T> {
      // The transcript is checked first: an event that already arrived is the
      // common case in a test that emits and then waits, and a waiter-only
      // implementation would hang on it. That race is the single most common
      // source of flaky socket tests.
      const seen = received.find((entry) => entry.event === event)
      if (seen !== undefined) return seen.payload as T

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${event}`)),
          timeoutMs,
        )
        waiters.push({
          event,
          resolve: (payload) => {
            clearTimeout(timer)
            resolve(payload as T)
          },
        })
      })
    },

    of(event) {
      return received.filter((entry) => entry.event === event).map((entry) => entry.payload)
    },

    clear() {
      received.length = 0
    },

    close() {
      socket.close()
    },
  }

  await Promise.race([
    client.next('connected'),
    new Promise((_resolve, reject) => {
      socket.once('connect_error', (error: Error) => reject(error))
    }),
  ])

  return client
}

/** Connects expecting to be refused, and resolves with the refusal. */
export async function expectConnectError(
  url: string,
  cookie: string,
): Promise<Error & { data?: { code?: string } }> {
  const socket = connect(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie === '' ? {} : { Cookie: cookie },
  })

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('expected connect_error, but the handshake succeeded'))
    }, 5_000)

    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer)
      socket.close()
      resolve(error)
    })
    socket.once('connected' as never, () => {
      clearTimeout(timer)
      socket.close()
      reject(new Error('expected connect_error, but the handshake succeeded'))
    })
  })
}

interface Emitter {
  emit(event: string, payload: unknown, ack: (response: never) => void): void
}

/**
 * Supertest gives `set-cookie` headers; the socket handshake needs one `Cookie:`
 * header. Only the name=value pair travels — the attributes (`Path`, `HttpOnly`)
 * are instructions *to* a browser, not something a browser ever sends back.
 */
export function cookieHeaderOf(response: request.Response): string {
  const raw = response.headers['set-cookie']
  const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ')
}

let counter = 0
export function unique(): string {
  counter += 1
  return `${Date.now().toString(36)}${counter}`
}

/** Lets the event loop deliver whatever is already queued on the sockets. */
export async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
