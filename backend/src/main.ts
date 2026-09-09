import { buildApp } from './app.js'
import { APP_VERSION } from './config/constants.js'
import { loadEnv } from './config/env.js'
import { buildContainer } from './container.js'

// P7: the environment is parsed before anything else is constructed. A bad
// value exits here, not halfway through a request.
const env = loadEnv()

const container = buildContainer({ env })
const app = buildApp(container)

const server = app.listen(env.PORT, () => {
  container.logger.info(
    { port: env.PORT, nodeEnv: env.NODE_ENV, version: APP_VERSION },
    'api listening',
  )
})

/**
 * Drain in the right order: stop accepting connections, finish what is in
 * flight, then close the database. Disconnecting Prisma first would fail the
 * requests we are trying to let finish.
 */
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    container.logger.info({ signal }, 'shutting down')

    server.close(() => {
      void container.shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  })
}
