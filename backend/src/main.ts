import { createServer } from 'node:http'
import { buildApp } from './app.js'
import { APP_VERSION } from './config/constants.js'
import { loadEnv } from './config/env.js'
import { buildContainer } from './container.js'
import { PROTOCOL_VERSION } from './contracts/events.js'
import { createGateway } from './interface/socket/gateway.js'

// P7: the environment is parsed before anything else is constructed. A bad
// value exits here, not halfway through a request.
const env = loadEnv()

const container = buildContainer({ env })
const app = buildApp(container)

/**
 * One HTTP server, two protocols (S23).
 *
 * The server is created explicitly rather than by `app.listen()` because
 * Socket.IO has to attach to it: `/socket.io/*` is intercepted before Express
 * ever sees the request, and everything else falls through to the Express app.
 * Sharing the port is what lets the Vite dev proxy forward `/api` and
 * `/socket.io` to the same origin, and — more importantly in production — what
 * lets the browser send the same cookie jar to both.
 */
const server = createServer(app)
const gateway = createGateway({ httpServer: server, container })

server.listen(env.PORT, () => {
  container.logger.info(
    {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      version: APP_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    },
    'api listening',
  )
})

/**
 * Without this, a taken port is an unhandled `'error'` event: the process dies
 * with a stack trace and no instruction, and whatever *is* on that port keeps
 * answering. That failure mode is genuinely misleading — the symptom is every
 * request 404ing from a client that looks correctly configured, because a
 * different app is replying.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    // On a dual-stack host the 'listening' event can fire for one address
    // family before the other fails, so an "api listening" line may already be
    // sitting above this one. It is not true, and it is exactly what makes this
    // failure look like a working server plus a broken client.
    container.logger.fatal(
      { port: env.PORT },
      `port ${env.PORT} is already in use — something else is listening there, ` +
        `and it will answer requests you think are reaching this API. ` +
        `Ignore any "api listening" line above: the bind failed. ` +
        `Free the port or set PORT in backend/.env, then start again.`,
    )
  } else {
    container.logger.fatal({ err: error }, 'the server could not start')
  }
  process.exit(1)
})

/**
 * Drain in the right order: stop accepting sockets, then stop accepting
 * requests, finish what is in flight, then close the database. Disconnecting
 * Prisma first would fail the requests we are trying to let finish, and closing
 * the HTTP server before the gateway would leave open WebSockets holding it
 * open past the timeout.
 */
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    container.logger.info({ signal }, 'shutting down')

    void gateway.close().finally(() => {
      server.close(() => {
        void container.shutdown().then(
          () => process.exit(0),
          () => process.exit(1),
        )
      })
    })
  })
}
