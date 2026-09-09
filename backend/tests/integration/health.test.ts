import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { APP_VERSION } from '../../src/config/constants.js'
import { buildContainer } from '../../src/container.js'
import { db } from '../helpers/db.js'

const container = buildContainer({ prisma: db })
const app = buildApp(container)

describe('GET /health — liveness', () => {
  it('reports liveness with the running version', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, version: APP_VERSION })
  })

  it('is also reachable under the /api/v1 prefix the Vite proxy forwards', async () => {
    const res = await request(app).get('/api/v1/health')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('answers even if the database is unreachable — liveness checks nothing', async () => {
    const broken = buildApp(buildContainer({ prisma: deadClient() }))
    const res = await request(broken).get('/health')
    expect(res.status).toBe(200)
  })
})

describe('GET /ready — readiness', () => {
  it('returns 200 while the database is reachable', async () => {
    const res = await request(app).get('/ready')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.checks.database.ok).toBe(true)
    expect(res.body.checks.database.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('is reachable under the /api/v1 prefix too', async () => {
    expect((await request(app).get('/api/v1/ready')).status).toBe(200)
  })

  it('★ returns 503 when the database is not there', async () => {
    // The failure mode that matters: a DATABASE_URL pointing somewhere with no
    // schema. SQLite happily creates the file, so `SELECT 1` would still pass —
    // only touching a table tells the truth.
    const broken = buildApp(buildContainer({ prisma: deadClient() }))
    const res = await request(broken).get('/ready')

    expect(res.status).toBe(503)
    expect(res.body.ok).toBe(false)
    expect(res.body.checks.database.ok).toBe(false)
    expect(res.body.checks.database.error).toBeTruthy()
  })
})

describe('the public port carries no admin surface', () => {
  it('mounts no /admin path — 12 §2.4, permanently', async () => {
    const res = await request(app).get('/admin/api/v1/users')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('says nothing about where the admin app lives', async () => {
    const res = await request(app).get('/admin/api/v1/users')
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('3100')
    expect(body).not.toContain('admin-main')
  })
})

describe('the response is not chatty', () => {
  it('does not advertise Express', async () => {
    const res = await request(app).get('/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('stamps every response with a request id', async () => {
    const res = await request(app).get('/health')
    expect(res.headers['x-request-id']).toBeTruthy()
  })
})

const clients: PrismaClient[] = []
// Outside the repo: SQLite creates the file on connect, and a stray .db in
// prisma/ is litter even when it is gitignored.
const scratch = mkdtempSync(join(tmpdir(), 'ready-probe-'))

/** A client pointed at a database file that was never migrated. */
function deadClient(): PrismaClient {
  const client = new PrismaClient({
    log: [],
    datasources: { db: { url: `file:${join(scratch, 'no-schema-here.db')}` } },
  })
  clients.push(client)
  return client
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()))
  rmSync(scratch, { recursive: true, force: true })
})
