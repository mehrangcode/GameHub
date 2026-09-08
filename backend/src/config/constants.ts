import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string; name: string }

export const APP_NAME = pkg.name
export const APP_VERSION = pkg.version

/** Lives in contracts/ because the client needs it too (04-realtime-protocol.md §1.2). */
export { PROTOCOL_VERSION } from '../contracts/events.js'

/** Every public REST route lives under this prefix. There are no admin routes here. */
export const API_PREFIX = '/api/v1'
