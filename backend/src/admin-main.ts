import { createServer } from 'node:http'
import { buildAdminApp } from './admin-app.js'
import { APP_VERSION } from './config/constants.js'
import { loadAdminEnv } from './config/env.js'
import { buildContainer } from './container.js'

/**
 * ★ The second entrypoint — 12-admin-console.md §2.1. One image, two processes.
 *
 * Three properties this file exists to guarantee, in the order they are
 * established:
 *
 *   1. **It refuses to boot without `ADMIN_TOTP_ENC_KEY`.** `loadAdminEnv`
 *      parses against `AdminEnvSchema`, where the key is required. Generating
 *      one when it is absent would silently invalidate every enrolled
 *      authenticator on the next restart — a failure that presents as "my phone
 *      stopped working" and is diagnosed by nobody.
 *   2. **The same `container.ts`.** Not a copy, not a subset: the identical
 *      composition root the public API uses, so an admin credit and a player's
 *      match reward go through one `WalletService` with one set of caps and one
 *      idempotency rule. §2.2 is explicit that a second implementation of a
 *      ledger is how ledgers break.
 *   3. **No Socket.IO.** `main.ts` wraps its server in `createGateway`; this one
 *      does not, and must not. An admin process holding gameplay sockets would
 *      be able to read live projections, which is exactly what A5 forbids —
 *      admin sees the *spectator* view of a live table and the raw event log
 *      only once the match is over.
 *
 * It binds to `ADMIN_BIND` (`127.0.0.1` bare-metal, `0.0.0.0` inside Docker
 * where the network is the boundary) and is never in a compose `ports:` list.
 */
const env = loadAdminEnv()

const container = buildContainer({ env })
const app = buildAdminApp(container, env)
const server = createServer(app)

server.listen(env.ADMIN_PORT, env.ADMIN_BIND, () => {
  container.logger.info(
    {
      port: env.ADMIN_PORT,
      bind: env.ADMIN_BIND,
      nodeEnv: env.NODE_ENV,
      version: APP_VERSION,
      adminOrigin: env.ADMIN_ORIGIN,
      controlTransport: env.CONTROL_TRANSPORT,
      ipAllowlist: env.ADMIN_IP_ALLOWLIST === '' ? 'disabled' : 'enabled',
    },
    'admin api listening — this port must never be published',
  )
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    container.logger.fatal(
      { port: env.ADMIN_PORT },
      `admin port ${env.ADMIN_PORT} is already in use. Ignore any "admin api listening" ` +
        `line above: the bind failed. Free the port or set ADMIN_PORT, then start again.`,
    )
  } else {
    container.logger.fatal({ err: error }, 'the admin server could not start')
  }
  process.exit(1)
})

/**
 * No gateway to drain and no timers to stop — `turnTimers` and `presence` are
 * owned by the api process, and this one never armed any. `container.shutdown`
 * is still the right call: it disposes the rate limiter and disconnects Prisma
 * and Redis, and calling the shared teardown keeps the two entrypoints from
 * drifting on what "stop cleanly" means.
 */
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    container.logger.info({ signal }, 'admin api shutting down')

    server.close(() => {
      void container.shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  })
}
