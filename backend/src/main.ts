import { buildApp } from './app.js'
import { APP_VERSION } from './config/constants.js'
import { loadEnv } from './config/env.js'

// P7: the environment is parsed before anything else is constructed. A bad
// value exits here, not halfway through a request.
const env = loadEnv()

const app = buildApp()

const server = app.listen(env.PORT, () => {
  console.warn(`[api] v${APP_VERSION} listening on :${env.PORT} (${env.NODE_ENV})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
