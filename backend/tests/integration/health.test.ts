import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { APP_VERSION } from '../../src/config/constants.js'

describe('GET /health', () => {
  const app = buildApp()

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

  it('mounts no /admin path on the public port', async () => {
    // The permanent assertion from 12-admin-console.md §2.4, in place before
    // the first admin route is ever written.
    const res = await request(app).get('/admin/api/v1/users')
    expect(res.status).toBe(404)
  })
})
