import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string; name: string }

export const APP_NAME = pkg.name
export const APP_VERSION = pkg.version

/** Lives in contracts/ because the client needs it too (04-realtime-protocol.md §1.2). */
export { PROTOCOL_VERSION } from '../contracts/events.js'

/** Every public REST route lives under this prefix. There are no admin routes here. */
export const API_PREFIX = '/api/v1'

/**
 * Every admin route lives under this prefix, on `:3100` **only** — 12 §5.
 *
 * The two prefixes deliberately do not nest. `/admin/api/v1` under `/api/v1`
 * would mean one missing mount guard away from serving the console on the
 * public port; a disjoint root makes `app.ts`'s boot assertion a simple string
 * test rather than a judgement about mount order.
 */
export const ADMIN_API_PREFIX = '/admin/api/v1'
